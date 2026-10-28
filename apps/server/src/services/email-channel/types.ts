import type { EmailChannelView, EmailContact, EmailLogResponse, InboxItem } from '@projectman/shared';
import type { Resolver } from '../../core/inbox';
import type { EmailChannelEnv } from './config';

export type Verdict = 'pass' | 'fail' | 'gray' | 'unknown';
/** A mail received by the provider-specific reader (PM-945), as the channel processes it. */
export type InboundMail = {
  /** The provider's message id: the key of idempotence. */
  providerId: string;
  /** The recipients of the envelope. */
  recipients: readonly string[];
  /** The whole MIME message; it is not kept after processing. */
  raw: Uint8Array;
  verdicts: { spf: Verdict; dkim: Verdict; dmarc: Verdict; spam: Verdict; virus: Verdict };
  receivedAt: string;
};
export type DeliveryEvent = {
  /** The `provider_id` of the outgoing mail. */
  providerId: string;
  kind: 'delivery' | 'bounce' | 'complaint';
  permanent: boolean;
  at: string;
};
export interface EmailInbound {
  receive(mail: InboundMail): Promise<'delivered' | 'parked' | 'duplicate' | 'dropped'>;
  deliveryEvent(event: DeliveryEvent): Promise<void>;
}

export interface EmailChannelService {
  /** Processes mails the provider reader hands over and the delivery events of outgoing mails. */
  inbound: EmailInbound;
  /** Starts the daily pruning of parked mails; `stop` ends it. */
  start(): void;
  stop(): void;
  configured(): boolean;
  view(projectKey: string): Promise<EmailChannelView>;
  setContact(projectKey: string, handle: string, wants: boolean, by: { handle: string }): EmailContact;
  log(projectKey: string, before: string | null): EmailLogResponse;
  send(
    projectKey: string,
    caller: string,
    input: {
      to: string;
      subject: string | null;
      text: string;
      taskKey: string | null;
      replyTo: string | null;
    },
  ): Promise<{ emailId: string; status: 'pending_approval' | 'sent' }>;
  setContactByMember(
    projectKey: string,
    caller: string,
    input: {
      handle: string;
      wants: boolean;
      requestedBy: string;
      sourceMessageId?: string;
      sourceEmailId?: string;
      quote?: string;
    },
  ): { handle: string; wants: boolean };
  contactsForMember(projectKey: string): Array<{
    handle: string;
    displayName: string;
    wants: boolean;
    hasAddress: boolean;
  }>;
  decideApproval(item: InboxItem, by: Resolver, optionId: string, note: string | null): Promise<void>;
  onConfigChanged(projectKey: string): void;
}

export type { EmailChannelEnv };
