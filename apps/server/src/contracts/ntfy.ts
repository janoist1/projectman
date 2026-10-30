import type { PushFailure } from '@projectman/shared';

/** Publishes one message to an ntfy server; the web push service reaches ntfy only through `PhoneChannel`. */
export interface NtfyTransport {
  send(input: NtfySendInput): Promise<NtfySendOutcome>;
}
export interface NtfySendInput {
  server: string;
  topic: string;
  title: string;
  message: string;
  /** Absolute link the message opens when tapped. */
  click?: string;
  priority: 'default' | 'high';
  timeoutMs: number;
}
export type NtfySendOutcome = { result: 'ok' } | { result: 'failed'; failure: PushFailure };

/** What the web push service needs from a second delivery channel for the same decisions. */
export interface PhoneChannel {
  /** True when the user has a switched-on channel. */
  active(userId: string): boolean;
  /** Delivers one generic message to that user's channel; failures are recorded there, never thrown. */
  deliver(userId: string, message: PhoneMessage): Promise<void>;
}
export interface PhoneMessage {
  title: string;
  body: string;
  urgent: boolean;
}
