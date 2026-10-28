import type { StoredMemberQueueItem } from '../../db';
import type { DomainContext } from '../../core/base';
import { isDeferrableCode } from '../admission';
import type { SessionStartCause } from '../sessions';
import type { MemberQueueLane } from './lane';

/** What one kind of decision (a permission request, a held fix limit) tells the lane. */
interface DecisionSource {
  /** The text the decider is given; null when the request is gone. */
  prompt(item: StoredMemberQueueItem): string | null;
  /** Whether the decider still has it to decide. */
  owed(item: StoredMemberQueueItem): boolean;
  /** The request reached the decider's session (the first time starts their time to decide). */
  delivered(item: StoredMemberQueueItem, at: string): void;
  /** No decider can be reached any more: the request goes to a person. */
  unreachable(item: StoredMemberQueueItem): Promise<void>;
  /** The decider's session ended without a decision three times: the request goes to a person. */
  exhausted(item: StoredMemberQueueItem): Promise<void>;
}

interface DecisionLaneDeps {
  ctx: DomainContext;
  permission: DecisionSource;
  fixLimit: DecisionSource;
}

/** Waits that no later attempt overcomes without a person: the member has no provider login, no AI, or is away. */
const HARD_WAITS = new Set([
  'provider_not_logged_in',
  'ai_disabled',
  'member_on_leave',
  'nanogpt_key_missing',
  'nanogpt_setup_incomplete',
  'codex_setup_incomplete',
]);

/** A wait that holds the decider back for good (as far as the server can tell), not for a moment. */
const isHardWait = (code: string): boolean => HARD_WAITS.has(code) || !isDeferrableCode(code);

const UNAVAILABLE = '(The request is no longer open.)';

/**
 * The lane of the decisions an AI member makes at its desk (PM-926): a permission request and
 * the lead's decision about a held fix limit. A decision needs no workspace (`decide_permission_request` and the
 * like work from any session), so its items start a general session of the decider and never wait for a card's
 * workspace. The item stays `processing` until its source closes it (`completion: 'source'`); the time to decide
 * counts from the delivery (`delivered`), and a request no decider can be started for reaches a person at once.
 */
export function decisionLane(deps: DecisionLaneDeps): MemberQueueLane {
  const { ctx } = deps;
  const sourceOf = (item: StoredMemberQueueItem): DecisionSource =>
    item.kind === 'permission' ? deps.permission : deps.fixLimit;

  /** The request goes to a person when every decider it was given to is held back for good. */
  const noDeciderLeft = async (item: StoredMemberQueueItem): Promise<void> => {
    const others = ctx.repos.memberQueue
      .listOpenOfSource(item.projectKey, item.source)
      .filter((other) => other.id !== item.id && other.kind === item.kind);
    if (others.some((other) => !other.wait || !isHardWait(other.wait.code))) return;
    await sourceOf(item).unreachable(item);
  };

  return {
    kinds: ['permission', 'fix_limit'],
    completion: 'source',
    oneAtATime: false,
    // The Operator's fix limit items (an inbox source) are not the lead's decision.
    owns: (item) => item.kind !== 'fix_limit' || item.source.type === 'fix_limit',
    cause: (item): SessionStartCause => ({
      kind: 'member_queue',
      by: { kind: 'system', handle: null },
      ...(item.source.type === 'inbox' ? { inboxItemId: item.source.id } : {}),
    }),
    render: (item) => sourceOf(item).prompt(item) ?? UNAVAILABLE,
    stillOwed: (item) => sourceOf(item).owed(item),
    hold: async () => null,
    delivered: (item, _sessionId, at) => sourceOf(item).delivered(item, at),
    deferred: (item, code) => {
      if (!isHardWait(code)) return;
      noDeciderLeft(item).catch((err: unknown) => {
        ctx.logger.warn({ err, itemId: item.id }, 'a decision that no decider can be reached for stays');
      });
    },
    refused: async (item) => {
      await noDeciderLeft(item).catch((err: unknown) => {
        ctx.logger.warn({ err, itemId: item.id }, 'a decision that no decider can be reached for stays');
      });
      return 'wait';
    },
    exhausted: (item) => sourceOf(item).exhausted(item),
  };
}
