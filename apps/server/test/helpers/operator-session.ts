import { randomUUID } from 'node:crypto';
import type { Session } from '@projectman/shared';
import type { DomainHarness } from './domain-harness';

type Repos = Pick<DomainHarness, 'repos'>;

/**
 * The app no longer starts the Operator (PM-1045), so a test of the Operator's own tool surface (its
 * operations, requests and approvals) seeds the session and the owner request the way a delivered owner
 * message used to leave them.
 */
export function seedOperatorSession(
  h: Repos,
  projectKey: string,
  opts: { member?: string; with?: string; at?: string } = {},
): Session {
  const now = opts.at ?? new Date().toISOString();
  const session: Session = {
    id: `ses_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
    projectKey,
    member: opts.member ?? 'operator',
    workItem: opts.with ? { type: 'general', with: opts.with } : { type: 'general' },
    claudeSessionId: randomUUID(),
    provider: 'claude',
    cwd: '/tmp/operator-test',
    branch: null,
    transcriptPath: null,
    state: 'working',
    activity: null,
    startedAt: now,
    lastActivityAt: now,
    endedAt: null,
  };
  h.repos.sessions.insert(session);
  return session;
}

export function seedOperatorRequest(
  h: Repos,
  projectKey: string,
  opts: {
    member?: string;
    from?: string;
    /** The guest of a conversation that is not the owner's. */
    with?: string;
    /** The time of the session, message and request (ISO), when the test runs on its own clock. */
    at?: string;
    text?: string;
    source?: 'message' | 'answer';
    messageId?: string | null;
    inboxItemId?: string | null;
  } = {},
) {
  const now = opts.at ?? new Date().toISOString();
  const session = seedOperatorSession(h, projectKey, { member: opts.member, with: opts.with, at: now });
  const text = opts.text ?? 'Change the writer to Sonnet.';
  const messageId =
    opts.messageId === undefined ? `msg_${randomUUID().replaceAll('-', '').slice(0, 16)}` : opts.messageId;
  if (opts.messageId === undefined)
    h.repos.messages.insert({
      id: messageId!,
      projectKey,
      from: opts.from ?? 'owner',
      to: [session.member],
      taskKey: null,
      body: text,
      createdAt: now,
      deliveredAt: now,
    });
  const request = {
    id: `opr_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
    projectKey,
    sessionId: session.id,
    source: opts.source ?? 'message',
    messageId,
    inboxItemId: opts.inboxItemId ?? null,
    fromHandle: opts.from ?? 'owner',
    quote: text.replace(/\s*[\r\n]+\s*/g, ' ').trim(),
    openedAt: now,
  } as const;
  h.repos.operatorRequests.insert(request);
  return { session, request };
}
