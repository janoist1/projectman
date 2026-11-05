import { describe, expect, it } from 'vitest';
import {
  ALERT_ROUTE_CLASS,
  ITEM_ROUTE_PM_STATES,
  ITEM_ROUTE_TABLE,
  PLAIN_ITEM_ROUTE_KINDS,
  allItemRouteKinds,
  fixLimitRoutePayload,
  fixLimitRouteTopic,
  itemRouteRecord,
  routeItem,
  type AlertKind,
  type ItemRoute,
  type ItemRouteInput,
  type ItemRouteKind,
  type ItemRouteRequested,
  type ItemRouteTopic,
} from './item-route';

const TOPICS: (ItemRouteTopic | null)[] = [null, { ownerTopic: 'cost' }, 'approval'];
const REQUESTED: ItemRouteRequested[] = ['owner', 'integrator', null];
const booleans = [true, false];

/** The whole input space of one route kind: pm × integrator × decider × requested × topic × machine access × signal. */
function* space(kind: ItemRouteKind, alertReason?: string): Generator<ItemRouteInput> {
  for (const pm of ITEM_ROUTE_PM_STATES)
    for (const integrator of booleans)
      for (const decider of booleans)
        for (const requested of REQUESTED)
          for (const topic of TOPICS)
            for (const issuerMachineAccess of booleans)
              for (const ownerSilentSignal of booleans)
                yield {
                  kind,
                  pm,
                  integrator,
                  decider,
                  requested,
                  topic,
                  issuerMachineAccess,
                  ownerSilentSignal,
                  ...(alertReason ? { alertReason } : {}),
                };
}

/** The outcome as written in the expectation tables: the target, a refusal after a colon. */
const outcome = (route: ItemRoute): string => (route.to === 'refuse' ? `refuse:${route.refusal}` : route.to);

const ownerInbox = (i: ItemRouteInput): string => (i.topic ? 'owner_inbox' : 'refuse:owner_topic_required');
const protectedFirst = (i: ItemRouteInput, otherwise: string): string =>
  i.topic === 'approval' ? 'owner_inbox' : otherwise;

/** The expected outcome of every plain route kind (PM-1241 chapter 7.3), written out apart from the rule. */
const EXPECTED: Record<(typeof PLAIN_ITEM_ROUTE_KINDS)[number], (i: ItemRouteInput) => string> = {
  screened_decision: ownerInbox,
  screened_todo: (i) =>
    protectedFirst(
      i,
      i.issuerMachineAccess ? 'integrator_queue' : i.decider ? 'decider' : 'refuse:no_machine_access',
    ),
  screening_fallback: (i) =>
    protectedFirst(i, i.requested === 'integrator' && !i.topic ? 'integrator_queue' : 'wait_pm'),
  unscreened_question: (i) =>
    i.topic
      ? 'owner_inbox'
      : i.requested === 'integrator'
        ? 'integrator_queue'
        : 'refuse:owner_topic_required',
  coordinator_question: (i) => (i.ownerSilentSignal ? 'refuse:signal_not_for_owner' : ownerInbox(i)),
  reask: ownerInbox,
  member_todo: (i) =>
    protectedFirst(i, i.issuerMachineAccess ? 'integrator_queue' : 'refuse:no_machine_access'),
  system_todo: () => 'integrator_queue',
  integrator_question: () => 'owner_side',
  integrator_pass_on: () => 'owner_side',
  owner_pulled: () => 'owner_side',
  fix_limit: (i) => protectedFirst(i, i.integrator ? 'integrator_queue' : 'owner_inbox'),
  senior_wait: (i) => (i.pm === 'none' ? ownerInbox(i) : 'pm'),
};

const ALERT_OUTCOME: Record<string, (i: ItemRouteInput) => string> = {
  integrator_queue: () => 'integrator_queue',
  pm: (i) => (i.pm === 'none' ? 'owner_messages' : 'pm'),
  owner_messages: () => 'owner_messages',
  duty_holder: () => 'duty_holder',
  retired: () => 'refuse:alert_retired',
};

describe('routeItem', () => {
  it('has a row for every route kind and every alert kind', () => {
    expect(Object.keys(ITEM_ROUTE_TABLE).sort()).toEqual([...PLAIN_ITEM_ROUTE_KINDS].sort());
    expect(allItemRouteKinds()).toHaveLength(
      PLAIN_ITEM_ROUTE_KINDS.length + Object.keys(ALERT_ROUTE_CLASS).length,
    );
  });

  it.each(PLAIN_ITEM_ROUTE_KINDS)('%s routes as the table says over the whole input space', (kind) => {
    let seen = 0;
    for (const input of space(kind)) {
      expect(outcome(routeItem(input)), JSON.stringify(input)).toBe(EXPECTED[kind](input));
      seen += 1;
    }
    expect(seen).toBe(5 * 2 * 2 * 3 * 3 * 2 * 2);
  });

  it.each(Object.keys(ALERT_ROUTE_CLASS) as AlertKind[])('alert:%s routes by its class', (alert) => {
    const reasons = alert === 'refinement' ? ['done', 'manual_step', 'stalled'] : [undefined];
    for (const reason of reasons) {
      const cls =
        alert === 'refinement'
          ? reason === 'done'
            ? 'owner_messages'
            : reason === 'manual_step'
              ? 'owner_approval'
              : 'retired'
          : ALERT_ROUTE_CLASS[alert];
      for (const input of space(`alert:${alert}`, reason)) {
        const expected = cls === 'owner_approval' ? 'owner_inbox' : ALERT_OUTCOME[cls]!(input);
        expect(outcome(routeItem(input)), JSON.stringify(input)).toBe(expected);
      }
    }
  });

  it('never opens the owners inbox without a topic, and sends no machine work or alert there as a fallback', () => {
    for (const kind of allItemRouteKinds())
      for (const reason of kind === 'alert:refinement' ? ['done', 'manual_step', 'stalled'] : [undefined])
        for (const input of space(kind, reason)) {
          const route = routeItem(input);
          if (route.to !== 'owner_inbox') continue;
          expect(route.topic, JSON.stringify(input)).toBeTruthy();
        }
  });

  it('allows the owner side only for the integrator’s own question and pass-on and a pull by the owner', () => {
    const ownerSide = new Set<ItemRouteKind>();
    for (const kind of allItemRouteKinds())
      for (const reason of kind === 'alert:refinement' ? ['done', 'manual_step', 'stalled'] : [undefined])
        for (const input of space(kind, reason))
          if (routeItem(input).to === 'owner_side') ownerSide.add(kind);
    expect([...ownerSide].sort()).toEqual(['integrator_pass_on', 'integrator_question', 'owner_pulled']);
  });

  it('creates no retired alert and lets no machine work reach the owners without a topic', () => {
    for (const [alert, cls] of Object.entries(ALERT_ROUTE_CLASS))
      if (cls === 'retired')
        for (const input of space(`alert:${alert as AlertKind}`))
          expect(routeItem(input)).toMatchObject({ to: 'refuse', refusal: 'alert_retired' });
    // A fix limit without an integrator is an owner decision with its fixed topic, not a lost machine item.
    expect(
      routeItem({
        kind: 'fix_limit',
        topic: null,
        requested: null,
        issuerMachineAccess: true,
        pm: 'available',
        integrator: false,
        decider: false,
      }),
    ).toEqual({ to: 'owner_inbox', topic: { ownerTopic: 'product_direction' }, reason: 'no_integrator' });
  });

  it('records the requested and the final recipient with the reason', () => {
    const input: ItemRouteInput = {
      kind: 'screening_fallback',
      topic: null,
      requested: 'integrator',
      issuerMachineAccess: true,
      pm: 'engine_offline',
      integrator: false,
      decider: false,
    };
    expect(itemRouteRecord(input, routeItem(input))).toEqual({
      kind: 'screening_fallback',
      requested: 'integrator',
      to: 'integrator_queue',
      reason: 'requested_integrator',
    });
  });
});

describe('the payload of a routed fix limit decision', () => {
  const input = (delegable: boolean, integrator: boolean): ItemRouteInput => ({
    kind: 'fix_limit',
    topic: fixLimitRouteTopic(delegable),
    requested: null,
    issuerMachineAccess: true,
    pm: 'available',
    integrator,
    decider: false,
  });
  const payload = (delegable: boolean, integrator: boolean) =>
    fixLimitRoutePayload(routeItem(input(delegable, integrator)), delegable, 'NOW');

  it('names the integrator and when it got the item', () => {
    expect(payload(true, true)).toEqual({ recipient: 'integrator', integratorOpenedAt: 'NOW' });
  });
  it('opens at the owners under a topic when no integrator is available', () => {
    expect(payload(true, false)).toEqual({ recipient: 'owner', ownerTopic: 'product_direction' });
  });
  it('keeps a non-delegable item an owner approval with the reason', () => {
    expect(payload(false, true)).toEqual({ recipient: 'owner', recipientRefusal: 'protected_question' });
  });
});
