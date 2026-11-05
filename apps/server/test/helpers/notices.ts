import type { SystemNoticeKind, TeamMessage } from '@projectman/shared';
import type { DomainHarness } from './domain-harness';

type SystemNoticeOrigin = Extract<NonNullable<TeamMessage['origin']>, { kind: 'system_notice' }>;
export type SentNotice = TeamMessage & { origin: SystemNoticeOrigin };

/**
 * The notices the system sent to the owners about alerts (PM-1250), oldest first: a message from the system
 * whose origin is `system_notice`, optionally of one kind.
 */
export function systemNotices(
  h: Pick<DomainHarness, 'repos'>,
  notice?: SystemNoticeKind,
  projectKey = 'AR',
): SentNotice[] {
  return h.repos.messages
    .list(projectKey)
    .filter(
      (message): message is SentNotice =>
        message.origin?.kind === 'system_notice' && (!notice || message.origin.notice === notice),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
