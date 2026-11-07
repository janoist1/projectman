import { z } from 'zod';
import type { AlertPayload } from './inbox';

/**
 * The one rule for where a request or a message to a person, the integrator or the project manager goes
 * (PM-1241, PM-1246). A pure function: the server executes its output in one place (`core/inbox` `applyRoute`),
 * and the web's test backend calls the same one. No call site chooses a recipient by itself, and nothing writes
 * `recipient: 'owner'` as a fallback: what the owners get in their inbox is an owner decision (with its topic)
 * or an approval, and nothing else but the owner's own side (`owner_side`).
 */

/** The kind of an alert (`AlertPayload.alert`): a new one needs a row in `ALERT_ROUTE_CLASS` to compile. */
export type AlertKind = AlertPayload['alert'];

/** The route kinds that are not alerts. Every one has a row in `ITEM_ROUTE_TABLE`. */
export const PLAIN_ITEM_ROUTE_KINDS = [
  'screened_decision',
  'screened_todo',
  'screening_fallback',
  'unscreened_question',
  'coordinator_question',
  'reask',
  'member_todo',
  'system_todo',
  'integrator_question',
  'integrator_pass_on',
  'owner_pulled',
  'fix_limit',
  'senior_wait',
] as const;
export type PlainItemRouteKind = (typeof PLAIN_ITEM_ROUTE_KINDS)[number];

/** A route kind: the plain ones, and one `alert:<kind>` per alert kind. */
export type ItemRouteKind = PlainItemRouteKind | `alert:${AlertKind}`;

/** Where an item goes. */
export const ItemRouteTarget = z.enum([
  'owner_inbox',
  'owner_side',
  'integrator_queue',
  'decider',
  'pm',
  'wait_pm',
  'owner_messages',
  'duty_holder',
  'refuse',
]);
export type ItemRouteTarget = z.infer<typeof ItemRouteTarget>;

/** Why the rule chose the target; the timeline and the weekly measure group by it. */
export const ItemRouteReason = z.enum([
  'owner_topic',
  'approval',
  'protected',
  'machine_work',
  'requested_integrator',
  'system_obligation',
  'issuer_without_machine_access',
  'no_integrator',
  'pm_pending',
  'owner_side',
  'owner_topic_missing',
  'signal_not_for_owner',
  'pm_matter',
  'no_pm',
  'information',
  'human_duty',
  'retired',
]);
export type ItemRouteReason = z.infer<typeof ItemRouteReason>;

/** The refusal codes of a `refuse` target. */
type ItemRouteRefusal =
  'owner_topic_required' | 'no_machine_access' | 'signal_not_for_owner' | 'alert_retired';

/** The topic an owner item needs: an owner decision topic of the project, or an approval. */
export type ItemRouteTopic = { ownerTopic: string } | 'approval';

/** The pm of the project as the rule sees it. */
export type ItemRoutePm = 'available' | 'leave' | 'paused' | 'engine_offline' | 'none';
export const ITEM_ROUTE_PM_STATES: readonly ItemRoutePm[] = [
  'available',
  'leave',
  'paused',
  'engine_offline',
  'none',
];

/** The recipient the asker named (`payload.requestedRecipient`). */
export type ItemRouteRequested = 'owner' | 'integrator' | null;

export interface ItemRouteInput {
  kind: ItemRouteKind;
  /** The owner topic the decision falls under, `approval` (also for a protected question), or null. */
  topic: ItemRouteTopic | null;
  requested: ItemRouteRequested;
  /** Whether the member who put the item in the machine queue may do that (`machineTodoIssuerAllowed`). */
  issuerMachineAccess: boolean;
  pm: ItemRoutePm;
  /** Whether an integrator can work the machine queue (a live super key); it never decides the owner as fallback. */
  integrator: boolean;
  /** Whether the project has a technical decider (`technicalDeciderOf`). */
  decider: boolean;
  /** Alert kinds that depend on a reason: the `refinement` alert's reason. */
  alertReason?: string;
  /** The question is about a system signal the owners are not told about (`OWNER_SILENT_SIGNAL_KINDS`). */
  ownerSilentSignal?: boolean;
}

/** An item route: the target, why, and for a refusal its code; `owner_inbox` always carries its topic. */
export type ItemRoute =
  | { to: 'owner_inbox'; topic: ItemRouteTopic; reason: ItemRouteReason }
  | { to: 'refuse'; refusal: ItemRouteRefusal; reason: ItemRouteReason }
  | { to: Exclude<ItemRouteTarget, 'owner_inbox' | 'refuse'>; reason: ItemRouteReason };

/** What the route leaves on the item (`InboxItem.route`) and on the timeline (`item_routed`). */
export const ItemRouteRecord = z.object({
  kind: z.string(),
  requested: z.enum(['owner', 'integrator']).nullable(),
  to: ItemRouteTarget,
  reason: ItemRouteReason,
});
export type ItemRouteRecord = z.infer<typeof ItemRouteRecord>;

export function itemRouteRecord(
  input: Pick<ItemRouteInput, 'kind' | 'requested'>,
  route: ItemRoute,
): ItemRouteRecord {
  return { kind: input.kind, requested: input.requested, to: route.to, reason: route.reason };
}

/**
 * What an alert kind becomes (PM-1241 chapter 7.6). `by_reason` is the `refinement` alert: its reason decides.
 * `retired` kinds are never created any more; their schema stays for the stored rows.
 */
export type AlertRouteClass =
  'integrator_queue' | 'pm' | 'owner_messages' | 'owner_approval' | 'duty_holder' | 'by_reason';

export const ALERT_ROUTE_CLASS: Record<AlertKind, AlertRouteClass | 'retired'> = {
  disk_low: 'integrator_queue',
  machine_busy: 'integrator_queue',
  worktree_kept: 'integrator_queue',
  session_input: 'integrator_queue',
  work_outage: 'pm',
  relation_check: 'pm',
  session_tokens: 'owner_messages',
  provider_rate_limited: 'owner_messages',
  feedback_forwarded: 'owner_messages',
  host_request_answered: 'owner_messages',
  email_parked: 'owner_messages',
  refinement: 'by_reason',
  merge_blocked: 'duty_holder',
  release_failed: 'retired',
  message_burst: 'retired',
  parts_left: 'retired',
  work_stalled: 'retired',
};

type Rule = (input: ItemRouteInput) => ItemRoute;

const ownerInbox = (input: ItemRouteInput): ItemRoute =>
  input.topic
    ? {
        to: 'owner_inbox',
        topic: input.topic,
        reason: input.topic === 'approval' ? 'approval' : 'owner_topic',
      }
    : { to: 'refuse', refusal: 'owner_topic_required', reason: 'owner_topic_missing' };

/** A protected question (an approval) is never delegated: it is the owners' with the `approval` topic. */
const protectedFirst =
  (rule: Rule): Rule =>
  (input) =>
    input.topic === 'approval' ? { to: 'owner_inbox', topic: 'approval', reason: 'protected' } : rule(input);

/**
 * A todo of a member: machine work goes to the integrator's queue, which stays the place it waits in whether
 * or not an integrator is connected. A member without machine access cannot put work there.
 */
const memberMachineTodo: Rule = (input) =>
  input.issuerMachineAccess
    ? { to: 'integrator_queue', reason: 'machine_work' }
    : { to: 'refuse', refusal: 'no_machine_access', reason: 'issuer_without_machine_access' };

export const ITEM_ROUTE_TABLE: Record<PlainItemRouteKind, Rule> = {
  screened_decision: ownerInbox,
  screened_todo: protectedFirst((input) =>
    input.issuerMachineAccess
      ? { to: 'integrator_queue', reason: 'machine_work' }
      : input.decider
        ? { to: 'decider', reason: 'issuer_without_machine_access' }
        : { to: 'refuse', refusal: 'no_machine_access', reason: 'issuer_without_machine_access' },
  ),
  screening_fallback: protectedFirst((input) =>
    input.requested === 'integrator' && !input.topic
      ? { to: 'integrator_queue', reason: 'requested_integrator' }
      : { to: 'wait_pm', reason: 'pm_pending' },
  ),
  unscreened_question: (input) =>
    input.topic
      ? ownerInbox(input)
      : input.requested === 'integrator'
        ? { to: 'integrator_queue', reason: 'requested_integrator' }
        : ownerInbox(input),
  coordinator_question: (input) =>
    input.ownerSilentSignal
      ? { to: 'refuse', refusal: 'signal_not_for_owner', reason: 'signal_not_for_owner' }
      : ownerInbox(input),
  reask: ownerInbox,
  member_todo: protectedFirst(memberMachineTodo),
  system_todo: () => ({ to: 'integrator_queue', reason: 'system_obligation' }),
  integrator_question: () => ({ to: 'owner_side', reason: 'owner_side' }),
  integrator_pass_on: () => ({ to: 'owner_side', reason: 'owner_side' }),
  owner_pulled: () => ({ to: 'owner_side', reason: 'owner_side' }),
  fix_limit: protectedFirst((input) =>
    input.integrator
      ? { to: 'integrator_queue', reason: 'machine_work' }
      : { to: 'owner_inbox', topic: { ownerTopic: 'product_direction' }, reason: 'no_integrator' },
  ),
  senior_wait: (input) => (input.pm === 'none' ? ownerInbox(input) : { to: 'pm', reason: 'pm_matter' }),
};

/** The route of an alert: its class, and for the `refinement` alert its reason. */
function alertRoute(kind: AlertKind, input: ItemRouteInput): ItemRoute {
  const retired: ItemRoute = { to: 'refuse', refusal: 'alert_retired', reason: 'retired' };
  let cls = ALERT_ROUTE_CLASS[kind];
  if (cls === 'by_reason')
    cls =
      input.alertReason === 'done'
        ? 'owner_messages'
        : input.alertReason === 'manual_step'
          ? 'owner_approval'
          : 'retired';
  switch (cls) {
    case 'integrator_queue':
      return { to: 'integrator_queue', reason: 'machine_work' };
    case 'pm':
      return input.pm === 'none'
        ? { to: 'owner_messages', reason: 'no_pm' }
        : { to: 'pm', reason: 'pm_matter' };
    case 'owner_messages':
      return { to: 'owner_messages', reason: 'information' };
    case 'owner_approval':
      return { to: 'owner_inbox', topic: 'approval', reason: 'approval' };
    case 'duty_holder':
      return { to: 'duty_holder', reason: 'human_duty' };
    case 'retired':
      return retired;
  }
}

/** Where an item goes. Pure; the caller executes the answer and records `itemRouteRecord`. */
export function routeItem(input: ItemRouteInput): ItemRoute {
  if (input.kind.startsWith('alert:')) return alertRoute(input.kind.slice(6) as AlertKind, input);
  return ITEM_ROUTE_TABLE[input.kind as PlainItemRouteKind](input);
}

/**
 * The topic a fix limit decision is routed with: only the narrow delegable shape may wait in the integrator's
 * queue, any other fix limit item is an approval.
 */
export function fixLimitRouteTopic(delegable: boolean): ItemRouteTopic | null {
  return delegable ? null : 'approval';
}

/**
 * What a routed fix limit decision carries on its payload (PM-714, PM-1246): the recipient, when the integrator
 * got it, why an owner item is not delegable, and the owner topic of an owner decision. The server and the web's
 * test backend both build the payload from the route here.
 */
export function fixLimitRoutePayload(
  route: ItemRoute,
  delegable: boolean,
  now: string,
): {
  recipient: 'integrator' | 'owner';
  integratorOpenedAt?: string;
  recipientRefusal?: 'protected_question';
  ownerTopic?: string;
} {
  const recipient = route.to === 'integrator_queue' ? 'integrator' : 'owner';
  return {
    recipient,
    ...(recipient === 'integrator' ? { integratorOpenedAt: now } : {}),
    ...(recipient === 'owner' && !delegable ? { recipientRefusal: 'protected_question' as const } : {}),
    ...(route.to === 'owner_inbox' && typeof route.topic === 'object'
      ? { ownerTopic: route.topic.ownerTopic }
      : {}),
  };
}

/** Every route kind there is: the plain ones and one per alert kind. */
export function allItemRouteKinds(): ItemRouteKind[] {
  return [
    ...PLAIN_ITEM_ROUTE_KINDS,
    ...(Object.keys(ALERT_ROUTE_CLASS) as AlertKind[]).map((kind): ItemRouteKind => `alert:${kind}`),
  ];
}
