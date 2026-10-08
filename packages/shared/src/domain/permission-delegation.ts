import { z } from 'zod';
import { memberOf } from '../config/lookup';
import { approverOf } from '../config/permission-level';
import type { ProjectConfig } from '../config/schema';
import { boundaryLeads } from './boundary';
import type { InboxItem } from './inbox';
import { MemberHandle } from './member';
import type { Approver } from './member';
import { permissionOwnerCategory } from './permission-category';
import type { PermissionOwnerCategory } from './permission-category';

/**
 * `payload.delegation` of a `permission` item whose question went to an AI decider (PM-169): who may
 * decide it and until when. `pending_owner` is what it becomes when the decider passes it on or does
 * not answer in time; the item then belongs to the sponsor or the owners and the delegation stays on
 * it as the record. Nothing here ever means permission.
 */
export const PermissionDelegation = z.object({
  state: z.enum(['pending_lead', 'pending_owner']),
  /** The AI members who may decide it, as chosen when the question came in. */
  leads: z.array(MemberHandle).min(1),
  leadDeadline: z.string().datetime(),
  /** Why it came to a person: the decider passed it on (`lead`, with its reason) or the time ran out. */
  escalation: z
    .object({
      cause: z.enum(['lead', 'timeout']),
      /** The decider's handle, or `system`. */
      by: z.string(),
      reason: z.string().optional(),
    })
    .optional(),
});
export type PermissionDelegation = z.infer<typeof PermissionDelegation>;

/** The decision of an AI decider about a delegated question: `escalate` hands it to a person. */
export const DelegatedPermissionDecision = z.enum(['allow', 'deny', 'escalate']);
export type DelegatedPermissionDecision = z.infer<typeof DelegatedPermissionDecision>;

/** The delegation of a permission item, or null when it has none (or an unreadable one). */
export function permissionDelegationOf(item: Pick<InboxItem, 'payload'>): PermissionDelegation | null {
  const parsed = PermissionDelegation.safeParse(item.payload.delegation);
  return parsed.success ? parsed.data : null;
}

/** The AI members that may decide a question of `requester` now: live, independent, holding the duty. */
export function permissionDeciders(config: ProjectConfig, requester: string): string[] {
  if (config.team.boundary?.enabled !== true) return [];
  return boundaryLeads(config, requester).filter((handle) => memberOf(config, handle)?.kind === 'ai');
}

export type PermissionRoute =
  | { to: 'ai'; leads: string[] }
  | {
      to: 'human';
      why: 'approver_human' | 'owner_category' | 'no_decider' | 'too_long';
      category?: PermissionOwnerCategory;
    };

/**
 * How much of a request's input (as JSON) the decider is shown. A longer request is never delegated:
 * the decider would judge a part of it, so a person gets it whole.
 */
export const DELEGATED_INPUT_LIMIT = 4_000;

function inputLength(toolInput: unknown): number {
  try {
    return (JSON.stringify(toolInput ?? null) ?? 'null').length;
  } catch {
    return Infinity;
  }
}

/**
 * Where a question of an AI member goes when no command rule has answered it (PM-169): to the AI
 * decider only for a member whose approver is `ai`, and only when the request is not one of the owner's
 * categories and a decider other than the member itself is at work. Everything else goes to the
 * member's sponsor or an owner.
 */
export function routePermissionRequest(
  config: ProjectConfig,
  requester: string,
  request: {
    toolName: string;
    toolInput: unknown;
    roots: readonly string[];
    /** The approver that applies to the asking session (PM-170, `effectiveSessionPermissions`); absent: the member's. */
    approver?: Approver;
  },
): PermissionRoute {
  const member = memberOf(config, requester);
  if (member?.kind !== 'ai' || (request.approver ?? approverOf(member)) !== 'ai')
    return { to: 'human', why: 'approver_human' };
  const category = permissionOwnerCategory(request.toolName, request.toolInput, request.roots);
  if (category) return { to: 'human', why: 'owner_category', category };
  if (inputLength(request.toolInput) > DELEGATED_INPUT_LIMIT) return { to: 'human', why: 'too_long' };
  const leads = permissionDeciders(config, requester);
  return leads.length ? { to: 'ai', leads } : { to: 'human', why: 'no_decider' };
}

/**
 * Whether a delegated question still waits for its AI decider at `now`: the deadline has not passed,
 * delegation is still on and one of its deciders is still at work (not removed, not on leave, the AI
 * team not switched off). Otherwise it belongs to a person, the same rule as for external operations.
 */
export function permissionDelegationState(
  config: ProjectConfig,
  requester: string,
  delegation: PermissionDelegation,
  now: number,
): PermissionDelegation['state'] {
  if (delegation.state !== 'pending_lead') return delegation.state;
  const live = permissionDeciders(config, requester);
  if (now >= Date.parse(delegation.leadDeadline) || !delegation.leads.some((lead) => live.includes(lead)))
    return 'pending_owner';
  return 'pending_lead';
}

export function permissionDecidersNow(
  config: ProjectConfig,
  item: Pick<InboxItem, 'source' | 'assignees' | 'payload'>,
  now: number,
): string[] {
  const delegation = permissionDelegationOf(item);
  if (delegation && permissionDelegationState(config, item.source, delegation, now) === 'pending_lead') {
    const live = permissionDeciders(config, item.source);
    return delegation.leads.filter((lead) => live.includes(lead));
  }
  return item.assignees;
}

/** The one rule for who may decide a delegated question: a chosen, live, independent AI decider, in time. */
export function canDecidePermission(
  config: ProjectConfig,
  requester: string,
  delegation: PermissionDelegation,
  handle: string,
  now: number,
): boolean {
  return (
    permissionDelegationState(config, requester, delegation, now) === 'pending_lead' &&
    handle !== requester &&
    delegation.leads.includes(handle) &&
    permissionDeciders(config, requester).includes(handle)
  );
}
