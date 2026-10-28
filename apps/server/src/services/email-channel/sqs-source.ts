import type { SQSClient } from '@aws-sdk/client-sqs';
import { z } from 'zod';
import { isSesRegion } from './ses-sender';
import type { DeliveryEvent, EmailInbound, InboundMail, Verdict } from './types';

/** The long poll of the reader (PM-945): the queue holds what SES receiving and the delivery events produce. */
const RECEIVE_MAX = 10;
const RECEIVE_WAIT_SECONDS = 20;
const RECEIVE_VISIBILITY_SECONDS = 60;
const BACKOFF_FIRST_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

export interface SqsLike {
  receive(input: {
    queueUrl: string;
    max: number;
    waitSeconds: number;
    visibilitySeconds: number;
  }): Promise<Array<{ receiptHandle: string; body: string }>>;
  delete(queueUrl: string, receiptHandle: string): Promise<void>;
}

interface SourceLogger {
  warn(object: object, message: string): void;
  debug(object: object, message: string): void;
}

export type SesNotification =
  | { kind: 'mail'; mail: InboundMail }
  | { kind: 'event'; event: DeliveryEvent }
  | { kind: 'ignored'; reason: string };

const verdictStatus = z.looseObject({ status: z.string() });
const receivedSchema = z.looseObject({
  notificationType: z.literal('Received'),
  mail: z.looseObject({ messageId: z.string().min(1), timestamp: z.string() }),
  receipt: z.looseObject({
    recipients: z.array(z.string()),
    spfVerdict: verdictStatus.optional(),
    dkimVerdict: verdictStatus.optional(),
    dmarcVerdict: verdictStatus.optional(),
    spamVerdict: verdictStatus.optional(),
    virusVerdict: verdictStatus.optional(),
  }),
  content: z.string().optional(),
});
const timestamped = z.looseObject({ timestamp: z.string().optional() });
const eventSchema = z.looseObject({
  eventType: z.enum(['Bounce', 'Complaint', 'Delivery']),
  mail: z.looseObject({ messageId: z.string().min(1), timestamp: z.string() }),
  bounce: z.looseObject({ bounceType: z.string().optional(), timestamp: z.string().optional() }).optional(),
  complaint: timestamped.optional(),
  delivery: timestamped.optional(),
});

function verdict(value: { status: string } | undefined): Verdict {
  switch (value?.status) {
    case 'PASS':
      return 'pass';
    case 'FAIL':
      return 'fail';
    case 'GRAY':
      return 'gray';
    default:
      return 'unknown';
  }
}

function instant(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const time = Date.parse(value);
  return Number.isNaN(time) ? fallback : new Date(time).toISOString();
}

/** Reads one SQS body (the SNS message of SES, delivered raw) into a mail, a delivery event or nothing. */
export function parseSesNotification(body: string, fallbackAt = new Date().toISOString()): SesNotification {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { kind: 'ignored', reason: 'not JSON' };
  }
  const received = receivedSchema.safeParse(json);
  if (received.success) {
    const { mail, receipt, content } = received.data;
    if (content === undefined) return { kind: 'ignored', reason: 'no message content' };
    return {
      kind: 'mail',
      mail: {
        providerId: mail.messageId,
        recipients: receipt.recipients,
        raw: Buffer.from(content, 'base64'),
        verdicts: {
          spf: verdict(receipt.spfVerdict),
          dkim: verdict(receipt.dkimVerdict),
          dmarc: verdict(receipt.dmarcVerdict),
          spam: verdict(receipt.spamVerdict),
          virus: verdict(receipt.virusVerdict),
        },
        receivedAt: instant(mail.timestamp, fallbackAt),
      },
    };
  }
  const event = eventSchema.safeParse(json);
  if (event.success) {
    const { eventType, mail, bounce, complaint, delivery } = event.data;
    const at = (own: string | undefined) => instant(own ?? mail.timestamp, fallbackAt);
    if (eventType === 'Bounce')
      return {
        kind: 'event',
        event: {
          providerId: mail.messageId,
          kind: 'bounce',
          permanent: bounce?.bounceType === 'Permanent',
          at: at(bounce?.timestamp),
        },
      };
    return {
      kind: 'event',
      event: {
        providerId: mail.messageId,
        kind: eventType === 'Complaint' ? 'complaint' : 'delivery',
        permanent: false,
        at: at((eventType === 'Complaint' ? complaint : delivery)?.timestamp),
      },
    };
  }
  const kind =
    typeof json === 'object' && json !== null
      ? ((json as Record<string, unknown>).eventType ?? (json as Record<string, unknown>).notificationType)
      : undefined;
  return {
    kind: 'ignored',
    reason: typeof kind === 'string' ? `unhandled ${kind.slice(0, 40)}` : 'unknown shape',
  };
}

export interface SqsInboundSource {
  start(): void;
  stop(): Promise<void>;
}

/** Hands the queue's mails and delivery events to the channel; only a failed handling leaves a message to SQS. */
export function createSqsInboundSource(deps: {
  queueUrl: string;
  client: SqsLike;
  inbound: EmailInbound;
  logger: SourceLogger;
  now: () => Date;
}): SqsInboundSource {
  const { queueUrl, client, inbound, logger, now } = deps;
  let running = false;
  let processing: Promise<void> = Promise.resolve();
  let wake: (() => void) | null = null;

  /** Neither the queue URL nor a key is logged: the name of the failure is enough. */
  const failure = (error: unknown) => (error instanceof Error ? error.name : 'unknown');

  function pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        wake = null;
        resolve();
      }
      wake = done;
    });
  }

  async function handle(message: { receiptHandle: string; body: string }): Promise<void> {
    try {
      const parsed = parseSesNotification(message.body, now().toISOString());
      if (parsed.kind === 'mail') await inbound.receive(parsed.mail);
      else if (parsed.kind === 'event') await inbound.deliveryEvent(parsed.event);
      else logger.debug({ reason: parsed.reason }, 'an e-mail queue message was ignored');
    } catch (error) {
      // Not deleted: SQS offers it again and, after five receives, moves it to the dead-letter queue.
      logger.warn({ error: failure(error) }, 'handling an e-mail queue message failed');
      return;
    }
    try {
      await client.delete(queueUrl, message.receiptHandle);
    } catch (error) {
      logger.warn({ error: failure(error) }, 'deleting an e-mail queue message failed');
    }
  }

  async function loop(): Promise<void> {
    let backoff = BACKOFF_FIRST_MS;
    while (running) {
      let messages: Array<{ receiptHandle: string; body: string }>;
      try {
        messages = await client.receive({
          queueUrl,
          max: RECEIVE_MAX,
          waitSeconds: RECEIVE_WAIT_SECONDS,
          visibilitySeconds: RECEIVE_VISIBILITY_SECONDS,
        });
      } catch (error) {
        if (!running) return;
        logger.warn({ error: failure(error), retryInMs: backoff }, 'reading the e-mail queue failed');
        await pause(backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
        continue;
      }
      backoff = BACKOFF_FIRST_MS;
      // After a stop the batch is left alone: its visibility timeout returns it to the queue.
      if (!running) return;
      processing = (async () => {
        for (const message of messages) await handle(message);
      })();
      await processing;
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      void loop();
    },
    async stop() {
      running = false;
      wake?.();
      await processing;
    },
  };
}

let sqs: Promise<typeof import('@aws-sdk/client-sqs')> | undefined;

export function createAwsSqsClient(options: {
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  endpoint?: string;
}): SqsLike {
  if (!isSesRegion(options.region)) throw new TypeError('the SQS region is not an AWS region name');
  let client: SQSClient | undefined;
  async function open() {
    const sdk = await (sqs ??= import('@aws-sdk/client-sqs'));
    client ??= new sdk.SQSClient({
      region: options.region,
      endpoint: options.endpoint ?? `https://sqs.${options.region}.amazonaws.com`,
      credentials: options.credentials,
    });
    return { sdk, client };
  }
  return {
    async receive(input) {
      const { sdk, client } = await open();
      const result = await client.send(
        new sdk.ReceiveMessageCommand({
          QueueUrl: input.queueUrl,
          MaxNumberOfMessages: input.max,
          WaitTimeSeconds: input.waitSeconds,
          VisibilityTimeout: input.visibilitySeconds,
        }),
      );
      return (result.Messages ?? []).flatMap((message) =>
        message.ReceiptHandle && message.Body !== undefined
          ? [{ receiptHandle: message.ReceiptHandle, body: message.Body }]
          : [],
      );
    },
    async delete(queueUrl, receiptHandle) {
      const { sdk, client } = await open();
      await client.send(new sdk.DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
    },
  };
}
