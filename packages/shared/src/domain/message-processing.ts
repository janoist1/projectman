import { z } from 'zod';
import { MemberHandle } from './member';
import type { SessionState } from './session';

/** How long a working session may stay silent before its turn counts as stale (PM-1290). */
export const PROCESSING_STALE_MS = 15 * 60 * 1000;

const at = z.string();

/** Why a message to an AI member has not been handed over yet (`MessageHoldName`). */
const ProcessingHold = z.enum(['engine', 'handoff', 'refinement_turn', 'fix_limit', 'full_test']);
type ProcessingHold = z.infer<typeof ProcessingHold>;

const ProcessingWaitReason = z.enum(['permission', 'input', 'paused', 'quota']);
type ProcessingWaitReason = z.infer<typeof ProcessingWaitReason>;

/**
 * What became of a message for one recipient (PM-1290). It never names a session: the link between a message
 * and the turn that processes it lives in the server's `message_turns`.
 */
export const MessageProcessing = z.discriminatedUnion('state', [
  z.object({ handle: MemberHandle, state: z.literal('stored') }),
  z.object({ handle: MemberHandle, state: z.literal('held'), hold: ProcessingHold, since: at }),
  z.object({ handle: MemberHandle, state: z.literal('starting'), since: at }),
  z.object({ handle: MemberHandle, state: z.literal('delivered'), at }),
  z.object({ handle: MemberHandle, state: z.literal('read'), at }),
  z.object({ handle: MemberHandle, state: z.literal('handed_off'), to: MemberHandle, at }),
  z.object({ handle: MemberHandle, state: z.literal('working'), since: at }),
  z.object({
    handle: MemberHandle,
    state: z.literal('waiting'),
    reason: ProcessingWaitReason.optional(),
    since: at,
  }),
  z.object({
    handle: MemberHandle,
    state: z.literal('stale'),
    cause: z.enum(['engine_offline', 'no_report']),
    lastSeenAt: at,
  }),
  z.object({ handle: MemberHandle, state: z.literal('turn_ended'), at }),
  z.object({
    handle: MemberHandle,
    state: z.literal('replied'),
    at,
    reply: z.union([z.object({ eventId: z.string() }), z.object({ messageId: z.string() })]),
  }),
  z.object({ handle: MemberHandle, state: z.literal('not_sent') }),
]);
export type MessageProcessing = z.infer<typeof MessageProcessing>;

/** What the turn's session reports, as far as the processing needs it. */
export interface ProcessingSession {
  state: SessionState;
  /** When the session entered `state`. */
  stateSince: string;
  /** A pause holds the session; since when. */
  pausedSince?: string | undefined;
  lastActivityAt: string;
  /** Whether the engine the session runs on is connected. */
  engineConnected: boolean;
}

/** The facts the processing of one message for one recipient is projected from. */
export interface MessageProcessingFacts {
  handle: string;
  /** The current time, in epoch milliseconds. */
  now: number;
  /** A comment mentions the recipient, but no notice and no mention item exists for them. */
  notSent?: boolean | undefined;
  /** The recipient's receipt: when the message was handed over to them, when a person read it, who took it on. */
  deliveredAt?: string | null | undefined;
  readAt?: string | null | undefined;
  handedOffTo?: string | null | undefined;
  /** The turn the message was typed into (a row of `message_turns`). */
  turn?: { typedAt: string; endedAt: string | null } | null | undefined;
  /** The turn's session; null/absent when it cannot be read. */
  session?: ProcessingSession | null | undefined;
  /** The hold the message waits under, with the time it was sent. */
  hold?: { name: ProcessingHold; since: string } | null | undefined;
  /** A session of the recipient is starting because of this message. */
  startingSince?: string | null | undefined;
  /** The recipient's first answer that belongs to the message. */
  reply?: { at: string; reply: { eventId: string } | { messageId: string } } | null | undefined;
}

/** A card note, as far as the answer rule reads it. */
interface ReplyNote {
  id: string;
  createdAt: string;
  actor: { handle: string | null };
  data: Record<string, unknown>;
}

/** The recipient's message, as far as the answer rule reads it. */
interface ReplyMessage {
  id: string;
  createdAt: string;
  conversation?: 'direct' | undefined;
  taskKey: string | null;
  to: readonly string[];
}

/**
 * The recipient's first answer to a comment after it reached them (PM-1290): a note in the comment's thread,
 * else a direct message to the comment's author about the same card. `notes` are the card's notes, `sent` the
 * messages the recipient sent. The server and the fake backend share this rule.
 */
export function commentReplyOf(input: {
  comment: ReplyNote;
  taskKey: string;
  handle: string;
  deliveredAt: string;
  notes: readonly ReplyNote[];
  sent: readonly ReplyMessage[];
}): NonNullable<MessageProcessingFacts['reply']> | null {
  const { comment, handle, deliveredAt } = input;
  const thread =
    typeof comment.data.replyTo === 'string' && comment.data.replyTo ? comment.data.replyTo : comment.id;
  const note = input.notes.find(
    (candidate) =>
      candidate.actor.handle === handle &&
      candidate.createdAt >= deliveredAt &&
      candidate.data.replyTo === thread,
  );
  if (note) return { at: note.createdAt, reply: { eventId: note.id } };
  const author = comment.actor.handle;
  const answer = author
    ? input.sent.find(
        (message) =>
          message.conversation === 'direct' &&
          message.taskKey === input.taskKey &&
          message.to.includes(author) &&
          message.createdAt >= deliveredAt,
      )
    : undefined;
  return answer ? { at: answer.createdAt, reply: { messageId: answer.id } } : null;
}

/**
 * What a comment's mention of one member stands on: the notice message's receipt, else (a person) the mention
 * item that notified them, counted from the item's creation whether it is still open or closed (Láttam is no
 * read receipt), else nothing was sent.
 */
export function commentMentionFacts(input: {
  notice?: { deliveredAt: string | null; readAt: string | null; handedOffTo: string | null } | null;
  hasNotice: boolean;
  itemCreatedAt?: string | null | undefined;
}): Pick<MessageProcessingFacts, 'notSent' | 'deliveredAt' | 'readAt' | 'handedOffTo'> {
  if (input.hasNotice)
    return {
      deliveredAt: input.notice?.deliveredAt ?? null,
      readAt: input.notice?.readAt ?? null,
      handedOffTo: input.notice?.handedOffTo ?? null,
    };
  if (input.itemCreatedAt) return { deliveredAt: input.itemCreatedAt };
  return { notSent: true };
}

/**
 * The processing of a message for one recipient, by the precedence: replied, turn ended, the open turn (stale,
 * waiting, working), handed on, read, delivered, starting, held, stored. A closed turn is final: the session's
 * later states never reach it. A mention without any notice is `not_sent`.
 */
export function messageProcessingOf(facts: MessageProcessingFacts): MessageProcessing {
  const { handle } = facts;
  if (facts.reply) return { handle, state: 'replied', at: facts.reply.at, reply: facts.reply.reply };
  if (facts.notSent) return { handle, state: 'not_sent' };
  const { turn, session } = facts;
  if (turn?.endedAt) return { handle, state: 'turn_ended', at: turn.endedAt };
  if (turn) {
    if (!session) return { handle, state: 'stale', cause: 'no_report', lastSeenAt: turn.typedAt };
    if (!session.engineConnected)
      return { handle, state: 'stale', cause: 'engine_offline', lastSeenAt: session.lastActivityAt };
    if (session.state === 'working' && facts.now - Date.parse(session.lastActivityAt) >= PROCESSING_STALE_MS)
      return { handle, state: 'stale', cause: 'no_report', lastSeenAt: session.lastActivityAt };
    if (session.state === 'waiting_permission')
      return { handle, state: 'waiting', reason: 'permission', since: session.stateSince };
    if (session.state === 'waiting_input')
      return { handle, state: 'waiting', reason: 'input', since: session.stateSince };
    if (session.pausedSince)
      return { handle, state: 'waiting', reason: 'paused', since: session.pausedSince };
    // The turn is open until the session goes idle, so a working session is working on it, though it entered
    // that state before the message was acknowledged (the hook that types the message starts the work first).
    if (session.state === 'working')
      return {
        handle,
        state: 'working',
        since: session.stateSince > turn.typedAt ? session.stateSince : turn.typedAt,
      };
  }
  if (facts.handedOffTo && facts.deliveredAt)
    return { handle, state: 'handed_off', to: facts.handedOffTo, at: facts.deliveredAt };
  if (facts.readAt) return { handle, state: 'read', at: facts.readAt };
  if (facts.deliveredAt) return { handle, state: 'delivered', at: facts.deliveredAt };
  if (facts.startingSince) return { handle, state: 'starting', since: facts.startingSince };
  if (facts.hold) return { handle, state: 'held', hold: facts.hold.name, since: facts.hold.since };
  return { handle, state: 'stored' };
}
