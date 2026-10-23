import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSqsInboundSource, parseSesNotification } from './sqs-source';
import type { SqsLike } from './sqs-source';
import type { EmailInbound } from './types';

const RAW = 'From: a@example.test\r\nSubject: Re: hi\r\n\r\nthanks\r\n';
const received = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    notificationType: 'Received',
    mail: { messageId: 'in-1', timestamp: '2026-10-23T10:00:00.000Z', source: 'a@example.test' },
    receipt: {
      recipients: ['r-ar-token@reply.example.test'],
      spfVerdict: { status: 'PASS' },
      dkimVerdict: { status: 'FAIL' },
      dmarcVerdict: { status: 'GRAY' },
      spamVerdict: { status: 'PROCESSING_FAILED' },
      virusVerdict: { status: 'PASS' },
      action: { type: 'SNS', encoding: 'BASE64' },
    },
    content: Buffer.from(RAW).toString('base64'),
    ...overrides,
  });
const event = (eventType: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    eventType,
    mail: { messageId: 'out-1', timestamp: '2026-10-23T09:00:00.000Z' },
    ...extra,
  });

describe('parseSesNotification', () => {
  it('turns a received mail into an inbound mail with mapped verdicts and decoded content', () => {
    const parsed = parseSesNotification(received());
    expect(parsed).toEqual({
      kind: 'mail',
      mail: {
        providerId: 'in-1',
        recipients: ['r-ar-token@reply.example.test'],
        raw: Buffer.from(RAW),
        verdicts: { spf: 'pass', dkim: 'fail', dmarc: 'gray', spam: 'unknown', virus: 'pass' },
        receivedAt: '2026-10-23T10:00:00.000Z',
      },
    });
  });

  it.each([
    ['a permanent bounce', event('Bounce', { bounce: { bounceType: 'Permanent' } }), 'bounce', true],
    ['a transient bounce', event('Bounce', { bounce: { bounceType: 'Transient' } }), 'bounce', false],
    [
      'a complaint',
      event('Complaint', { complaint: { timestamp: '2026-10-23T09:30:00.000Z' } }),
      'complaint',
      false,
    ],
    ['a delivery', event('Delivery', { delivery: {} }), 'delivery', false],
  ])('turns %s into a delivery event of the sent mail', (_name, body, kind, permanent) => {
    const parsed = parseSesNotification(body);
    expect(parsed).toMatchObject({ kind: 'event', event: { providerId: 'out-1', kind, permanent } });
  });

  it('takes the time of the event, else the one of the mail', () => {
    const complaint = parseSesNotification(
      event('Complaint', { complaint: { timestamp: '2026-10-23T09:30:00.000Z' } }),
    );
    const delivery = parseSesNotification(event('Delivery'));
    expect(complaint).toMatchObject({ event: { at: '2026-10-23T09:30:00.000Z' } });
    expect(delivery).toMatchObject({ event: { at: '2026-10-23T09:00:00.000Z' } });
  });

  it.each([
    ['a rejected send', event('Reject')],
    ['an unknown shape', JSON.stringify({ hello: 'world' })],
    ['a received mail without content', received({ content: undefined })],
    ['a non-JSON body', 'not json'],
    ['a message with no id', event('Bounce', { mail: { timestamp: 'x' } })],
  ])('ignores %s', (_name, body) => {
    expect(parseSesNotification(body).kind).toBe('ignored');
  });
});

describe('createSqsInboundSource', () => {
  const queueUrl = 'https://sqs.example.test/123/queue';
  const logger = { warn: vi.fn(), debug: vi.fn() };
  const now = () => new Date('2026-10-23T12:00:00.000Z');

  beforeEach(() => {
    vi.useFakeTimers();
    logger.warn.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  /** Serves the batches in order, then answers with an empty long poll after a pause. */
  function queue(batches: Array<Array<{ receiptHandle: string; body: string }> | Error>) {
    const deleted: string[] = [];
    const inputs: unknown[] = [];
    const client: SqsLike = {
      async receive(input) {
        inputs.push(input);
        const next = batches.shift();
        if (next instanceof Error) throw next;
        if (next) return next;
        await new Promise((resolve) => setTimeout(resolve, 20_000));
        return [];
      },
      async delete(url, handle) {
        expect(url).toBe(queueUrl);
        deleted.push(handle);
      },
    };
    return { client, deleted, inputs };
  }
  const inbound = (receive: EmailInbound['receive'] = async () => 'delivered'): EmailInbound => ({
    receive: vi.fn(receive),
    deliveryEvent: vi.fn(async () => undefined),
  });

  it('hands over mails and events and deletes what was handled, ignored or only repeated', async () => {
    const results = ['delivered', 'parked', 'duplicate', 'dropped'] as const;
    let index = 0;
    const target = inbound(async () => results[index++]!);
    const { client, deleted, inputs } = queue([
      [
        { receiptHandle: 'm1', body: received() },
        { receiptHandle: 'm2', body: received() },
        { receiptHandle: 'm3', body: received() },
        { receiptHandle: 'm4', body: received() },
        { receiptHandle: 'e1', body: event('Delivery') },
        { receiptHandle: 'x1', body: event('Reject') },
      ],
    ]);
    const source = createSqsInboundSource({ queueUrl, client, inbound: target, logger, now });
    source.start();
    await vi.advanceTimersByTimeAsync(0);
    await source.stop();

    expect(deleted).toEqual(['m1', 'm2', 'm3', 'm4', 'e1', 'x1']);
    expect(target.receive).toHaveBeenCalledTimes(4);
    expect(target.deliveryEvent).toHaveBeenCalledTimes(1);
    expect(inputs[0]).toEqual({ queueUrl, max: 10, waitSeconds: 20, visibilitySeconds: 60 });
  });

  it('keeps a message the handler failed on, so SQS offers it again', async () => {
    const target = inbound(async () => {
      throw new Error('database is locked');
    });
    const { client, deleted } = queue([[{ receiptHandle: 'm1', body: received() }]]);
    const source = createSqsInboundSource({ queueUrl, client, inbound: target, logger, now });
    source.start();
    await vi.advanceTimersByTimeAsync(0);
    await source.stop();

    expect(deleted).toEqual([]);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(queueUrl);
  });

  it('waits longer after each failed read, up to a minute, and starts over after a good one', async () => {
    const failure = () => Object.assign(new Error('boom'), { name: 'NetworkingError' });
    const { client, inputs } = queue([failure(), failure(), failure()]);
    const source = createSqsInboundSource({ queueUrl, client, inbound: inbound(), logger, now });
    source.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(inputs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(inputs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(inputs).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(inputs).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(inputs).toHaveLength(3);
    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(logger.warn.mock.calls[2]![0]).toMatchObject({ error: 'NetworkingError', retryInMs: 4_000 });
    await source.stop();
  });

  it('on stop waits for the batch in hand and reads no more', async () => {
    let finish: (() => void) | undefined;
    const target = inbound(
      () =>
        new Promise((resolve) => {
          finish = () => resolve('delivered');
        }),
    );
    const { client, deleted, inputs } = queue([[{ receiptHandle: 'm1', body: received() }]]);
    const source = createSqsInboundSource({ queueUrl, client, inbound: target, logger, now });
    source.start();
    await vi.advanceTimersByTimeAsync(0);

    let stopped = false;
    const stopping = source.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    finish!();
    await stopping;

    expect(deleted).toEqual(['m1']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(inputs).toHaveLength(1);
  });
});
