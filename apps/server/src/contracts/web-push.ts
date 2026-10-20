import type { PushFailure } from '@projectman/shared';

export interface PushTransport {
  send(input: PushSendInput): Promise<PushSendOutcome>;
}
export interface PushSendInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  payload: string;
  ttlSeconds: number;
  urgency: 'normal' | 'high';
  vapid: { subject: string; publicKey: string; privateKey: string };
  timeoutMs: number;
}
export type PushSendOutcome =
  { result: 'ok' } | { result: 'expired' } | { result: 'failed'; failure: PushFailure };
