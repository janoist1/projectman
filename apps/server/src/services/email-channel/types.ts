import type { EmailChannelView, EmailContact, EmailLogResponse, InboxItem } from '@projectman/shared';
import type { Resolver } from '../../core/inbox';
import type { EmailChannelEnv } from './config';

export interface EmailChannelService {
  configured(): boolean;
  view(projectKey: string): Promise<EmailChannelView>;
  setContact(projectKey: string, handle: string, wants: boolean, by: { handle: string }): EmailContact;
  log(projectKey: string, before: string | null): EmailLogResponse;
  send(
    projectKey: string,
    caller: string,
    input: { to: string; subject: string; text: string; taskKey: string | null },
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
