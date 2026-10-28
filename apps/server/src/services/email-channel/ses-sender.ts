import type { SESv2Client } from '@aws-sdk/client-sesv2';
import type { EmailSendFailure } from '@projectman/shared';

export interface OutboundMail {
  to: string;
  /** The sender address: the service decides which one. */
  from: string;
  fromName: string;
  /** Absent: no `ReplyToAddresses`. */
  replyTo?: string;
  headers?: { name: 'In-Reply-To' | 'References'; value: string }[];
  subject: string;
  text: string;
  html: string;
}

export interface EmailSender {
  send(input: OutboundMail): Promise<{ providerId: string }>;
}

const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;
const ADDRESS = /^[^\s@<>,;"()[\]\\]+@[^\s@<>,;"()[\]\\]+$/;
let ses: Promise<typeof import('@aws-sdk/client-sesv2')> | undefined;

export function isSesRegion(region: string): boolean {
  return REGION.test(region);
}

export class EmailSendError extends Error {
  readonly reason: EmailSendFailure;
  /** The provider refused this sender address (the IAM `ses:FromAddress` condition). */
  readonly fromRefused: boolean;

  constructor(reason: EmailSendFailure, fromRefused = false) {
    super('the e-mail could not be sent');
    this.name = 'EmailSendError';
    this.reason = reason;
    this.fromRefused = fromRefused;
  }
}

const FROM_REFUSED = new Set(['AccessDeniedException', 'AccessDenied']);

const REASONS: Readonly<Record<string, EmailSendFailure>> = {
  MessageRejected: 'rejected',
  MailFromDomainNotVerifiedException: 'rejected',
  AccountSuspendedException: 'rejected',
  SendingPausedException: 'rejected',
  TooManyRequestsException: 'throttled',
  LimitExceededException: 'throttled',
  Throttling: 'throttled',
  ThrottlingException: 'throttled',
};

function reasonOf(error: unknown): EmailSendFailure {
  const name = error instanceof Error ? error.name : '';
  return REASONS[name] ?? 'unavailable';
}

export function encodedFrom(fromName: string, from: string): string {
  const safeName = fromName.replace(/["\\\r\n]+/g, ' ').trim();
  return `=?UTF-8?B?${Buffer.from(safeName).toString('base64')}?= <${from}>`;
}

export interface SesEmailSenderOptions {
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  configurationSet: string | null;
  endpoint?: string;
}

export function createSesEmailSender(options: SesEmailSenderOptions): EmailSender {
  if (!REGION.test(options.region)) throw new TypeError('the SES region is not an AWS region name');
  const clientOptions = {
    region: options.region,
    endpoint: options.endpoint ?? `https://email.${options.region}.amazonaws.com`,
    credentials: options.credentials,
  };
  let client: SESv2Client | undefined;
  return {
    async send(input: OutboundMail) {
      if (!ADDRESS.test(input.to) || !ADDRESS.test(input.from)) throw new EmailSendError('not_configured');
      const { SESv2Client, SendEmailCommand } = await (ses ??= import('@aws-sdk/client-sesv2'));
      client ??= new SESv2Client(clientOptions);
      const command = new SendEmailCommand({
        FromEmailAddress: encodedFrom(input.fromName, input.from),
        Destination: { ToAddresses: [input.to] },
        ...(input.replyTo ? { ReplyToAddresses: [input.replyTo] } : {}),
        ...(options.configurationSet ? { ConfigurationSetName: options.configurationSet } : {}),
        Content: {
          Simple: {
            ...(input.headers?.length
              ? { Headers: input.headers.map(({ name, value }) => ({ Name: name, Value: value })) }
              : {}),
            Subject: { Data: input.subject.replace(/[\r\n]+/g, ' ').trim(), Charset: 'UTF-8' },
            Body: {
              Text: { Data: input.text, Charset: 'UTF-8' },
              Html: { Data: input.html, Charset: 'UTF-8' },
            },
          },
        },
      });
      try {
        const result = await client.send(command);
        return { providerId: result.MessageId ?? '' };
      } catch (providerError) {
        const name = providerError instanceof Error ? providerError.name : '';
        throw new EmailSendError(reasonOf(providerError), FROM_REFUSED.has(name));
      }
    },
  };
}
