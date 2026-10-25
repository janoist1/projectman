import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { routes } from '@projectman/shared';
import type { InboxItem, ProjectConfig } from '@projectman/shared';
import { getLocale } from '@projectman/templates';
import { aiActor, humanActor } from '../src/kernel';
import { addHumanAndLogin, createAppHarness, createProject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { settle } from './helpers/fakes';

/**
 * The fix round limit item addressed to the integrator (PM-801): it decides replan, reassign or another round,
 * or hands the same item to the owners; it gets no other approval right. Card AR-1 is carried by `dev-1`, the
 * limit is two rounds, the lead is `lead`, the planner `arch`.
 */

const START = '2026-10-18T10:00:00.000Z';
const OWNER_LOGIN = { name: 'Owner', email: 'owner@example.com', password: 'correct horse battery' };
const ASSESSMENT = {
  recurrence: 'The same test fails again after each fix.',
  currentState: 'The fix is half done and the test still fails.',
  recommendation: { optionId: 'another_round', reason: 'One more try is cheap.' },
};

describe('integrator fix limit decision', () => {
  let h: AppHarness;
  let now: Date;
  let cookie: string;
  let superKey: ReturnType<AppHarness['app']['projectman']['auth']['createIntegratorAccessKey']>;

  beforeEach(async () => {
    now = new Date(START);
    h = await createAppHarness({ now: () => now });
    cookie = await setupOwner(h.app);
    await createProject(h, cookie);
    const { auth, repos, domain } = h.app.projectman;
    superKey = auth.createIntegratorAccessKey(repos.users.list()[0]!.id, { mode: 'super', expiresInDays: 7 });
    await domain.projects.update('AR', { actor: humanActor('owner'), author: OWNER_LOGIN }, (draft) => {
      draft.team.limits.maxConcurrentAi = 10;
      draft.team.limits.maxFixRounds = 2;
      for (const [handle, role] of [
        ['lead', 'lead_developer'],
        ['arch', 'architect'],
      ] as const)
        draft.team.members.push({
          kind: 'ai',
          handle,
          displayName: handle,
          role,
          sponsor: 'owner',
        } as ProjectConfig['team']['members'][number]);
      return 'Add the lead and the planner';
    });
    h.runner.idleOnStart = true;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.close();
  });

  const domain = () => h.app.projectman.domain;
  const repos = () => h.app.projectman.repos;
  const headers = () => ({ authorization: `Bearer ${superKey.secret}` });
  const task = () => domain().tasks.get('AR', 'AR-1');
  const record = () => repos().taskFixLimits.get('AR-1');
  const item = (id: string) => domain().inbox.get('AR', id);
  const fixLimitEvents = () =>
    repos()
      .timeline.list('AR', { taskKey: 'AR-1' })
      .filter((event) => event.type === 'task_fix_limit');
  const escalations = () =>
    repos()
      .timeline.list('AR', { taskKey: 'AR-1' })
      .filter((event) => event.type === 'fix_limit_recipient_escalated');

  /** AR-1 reaches the limit and the lead passes the decision on, so the item is addressed. */
  async function heldAtLimit(): Promise<void> {
    await domain().tasks.create('AR', { title: 'Login page' }, humanActor('owner'));
    await domain().taskStarts.start('AR', 'AR-1', {
      assignee: 'dev-1',
      actor: humanActor('owner'),
      author: { name: 'Owner', email: 'owner@example.com' },
    });
    await settle();
    await domain().tasks.moveToStage('AR', 'AR-1', 'code_review', aiActor('dev-1'));
    await settle();
    for (const comment of ['First fix', 'Second fix']) {
      if (task().labels.includes('code-review-changes'))
        await domain().tasks.changeLabels('AR', 'AR-1', { remove: ['code-review-changes'] }, aiActor('cr'));
      await domain().tasks.changeLabels('AR', 'AR-1', { add: ['code-review-changes'] }, aiActor('cr'), {
        comment,
      });
      await settle();
    }
  }

  async function passedOn(): Promise<InboxItem> {
    await heldAtLimit();
    await domain().fixLimit.decide('lead', 'AR', 'AR-1', 'to_owner', 'Not my call.', ASSESSMENT);
    return item(record()!.inboxItemId!);
  }

  const decide = (id: string, optionId: string, note?: string, auth: Record<string, string> = headers()) =>
    h.app.inject({
      method: 'POST',
      url: routes.resolveIntegratorFixLimit('AR', id),
      headers: auth,
      payload: { optionId, ...(note !== undefined ? { note } : {}) },
    });

  it('addresses the item to the integrator with the whole text, and hides it from the people', async () => {
    const created = await passedOn();
    expect(created.payload).toMatchObject({ recipient: 'integrator', integratorOpenedAt: START });
    expect(created.body).toContain(ASSESSMENT.recurrence);
    expect(created.body).toContain('First fix');
    expect(created.options.map((option) => option.id)).toEqual(
      expect.arrayContaining(['replan', 'reassign', 'another_round']),
    );
    expect(domain().inbox.countOpenFor('AR', 'owner')).toBe(0);
    expect(
      (await h.app.inject({ url: routes.inbox('AR') + '?mine=true', headers: { cookie } })).json().items,
    ).toHaveLength(0);
    const listed = await h.app.inject({ url: routes.inbox('AR'), headers: headers() });
    expect(listed.json().items.map((entry: InboxItem) => entry.id)).toContain(created.id);
    expect(task().fixLimit).toMatchObject({ phase: 'owner', recipient: 'integrator' });
    for (const access of ['admin', 'developer', 'viewer'] as const) {
      const login = await addHumanAndLogin(h.app, {
        handle: `person-${access}`,
        access,
      });
      const response = await h.app.inject({ url: routes.inbox('AR'), headers: { cookie: login } });
      expect(response.json().items.map((entry: InboxItem) => entry.id)).not.toContain(created.id);
    }
  });

  it('another_round: one more round in the integrator’s name, counted as an extra round', async () => {
    const created = await passedOn();
    const response = await decide(created.id, 'another_round', 'Try once more.');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().item.resolution).toMatchObject({
      optionId: 'another_round',
      via: 'integrator',
      integratorFixLimit: true,
      actor: { kind: 'ai', handle: 'operator', operatorMode: 'super' },
    });
    expect(record()).toMatchObject({ holdPhase: null, extraRounds: 1, inboxItemId: null });
    expect(fixLimitEvents().at(-1)).toMatchObject({
      actor: { handle: 'operator', operatorMode: 'super' },
      data: { phase: 'decided', decision: 'another_round', note: 'Try once more.', extraRounds: 1 },
    });
    expect((await decide(created.id, 'another_round')).json().error.code).toBe('inbox_item_closed');
  });

  it('executes an owner-addressed fix limit decision through inbox_resolve', async () => {
    const created = await passedOn();
    await decide(created.id, 'to_owner', 'Ask the owner.');
    const response = await h.app.inject({
      method: 'POST',
      url: routes.superOperations('AR'),
      headers: headers(),
      payload: {
        requestId: randomUUID(),
        command: {
          kind: 'inbox_resolve',
          itemId: created.id,
          request: { optionId: 'another_round', note: 'Try again.' },
        },
      },
    });
    expect(response.statusCode, response.body).toBe(202);
    expect(response.json().operation.state).toBe('succeeded');
    expect(item(created.id).resolution).toMatchObject({
      by: 'owner',
      superDecision: true,
      actor: { handle: 'operator', operatorMode: 'super' },
    });
    expect(record()).toMatchObject({ holdPhase: null, extraRounds: 1 });
    expect(fixLimitEvents().at(-1)?.actor).toMatchObject({ handle: 'operator', operatorMode: 'super' });
  });

  it('starts a held card as the Operator and releases its fix limit hold', async () => {
    await passedOn();
    const response = await h.app.inject({
      method: 'POST',
      url: routes.superOperations('AR'),
      headers: headers(),
      payload: {
        requestId: randomUUID(),
        command: { kind: 'task_start', taskKey: 'AR-1', request: { assignee: 'dev-1' } },
      },
    });
    expect(response.statusCode, response.body).toBe(202);
    expect(response.json().operation.state).toBe('succeeded');
    expect(record()).toMatchObject({ holdPhase: null, extraRounds: 1 });
    expect(fixLimitEvents().at(-1)?.actor).toMatchObject({ handle: 'operator', operatorMode: 'super' });
  });

  it('reassign: another implementer starts with a fresh count', async () => {
    const created = await passedOn();
    const response = await decide(created.id, 'reassign');
    expect(response.statusCode, response.body).toBe(200);
    await settle();
    expect(task().assignee).toBe('dev-2');
    expect(record()).toMatchObject({ holdPhase: null, extraRounds: 0 });
    expect(fixLimitEvents().at(-1)).toMatchObject({
      actor: { operatorMode: 'super' },
      data: { phase: 'decided', decision: 'reassign' },
    });
  });

  it.each(['another_round', 'replan'])(
    'hands a timeout directly to the integrator and fulfills after it chooses %s',
    async (optionId) => {
      await heldAtLimit();
      const stop = async () => {
        for (const session of domain().sessions.list('AR')) await domain().sessions.stop('AR', session.id);
        await settle();
      };
      await stop();
      await domain().obligations.sweep();
      now = new Date(now.getTime() + 30 * 60_000);
      await domain().obligations.sweep();
      await settle();
      await stop();
      now = new Date(now.getTime() + 30 * 60_000);
      await domain().obligations.sweep();
      const created = item(record()!.inboxItemId!);
      const row = repos()
        .obligations.listLive('AR', 'AR-1')
        .find((entry) => entry.kind === 'fix_limit')!;
      expect(row).toMatchObject({ state: 'handed_over', inboxItemId: created.id });
      expect(created.payload).toMatchObject({
        recipient: 'integrator',
        fixLimit: { reason: 'decider_timeout' },
      });
      expect(domain().inbox.countOpenFor('AR', 'owner')).toBe(0);
      expect(
        domain()
          .inbox.list('AR', {})
          .filter((entry) => entry.kind === 'question' && entry.payload.obligation),
      ).toHaveLength(0);
      expect(
        domain()
          .timeline.list('AR')
          .find((entry) => entry.type === 'obligation_handed_over' && entry.data.kind === 'fix_limit')?.data,
      ).toMatchObject({ inboxItemId: created.id, decisionItemId: created.id, recipient: 'integrator' });
      await domain().obligations.sweep();
      expect(item(created.id).state).toBe('open');
      const response = await decide(created.id, optionId);
      expect(response.statusCode, response.body).toBe(200);
      await domain().obligations.sweep();
      expect(repos().obligations.get(row.id)?.state).toBe('fulfilled');
      expect(item(created.id)).toMatchObject({
        state: 'resolved',
        resolution: { optionId, integratorFixLimit: true },
      });
    },
  );

  it('replan: another technical direction holder is asked for a more exact plan', async () => {
    const created = await passedOn();
    const response = await decide(created.id, 'replan');
    expect(response.statusCode, response.body).toBe(200);
    expect(record()).toMatchObject({ holdPhase: 'replan', decider: 'arch' });
    expect(fixLimitEvents().at(-1)).toMatchObject({
      actor: { operatorMode: 'super' },
      data: { phase: 'decided', decision: 'replan', decider: 'arch' },
    });
  });

  it('to_owner hands the same item to the owners with a reason, and an owner then decides it', async () => {
    const created = await passedOn();
    expect((await decide(created.id, 'to_owner')).json().error.code).toBe('invalid_request');
    expect((await decide(created.id, 'to_owner', '   ')).json().error.code).toBe('invalid_request');
    expect(item(created.id).payload.recipient).toBe('integrator');

    const response = await decide(created.id, 'to_owner', 'I cannot judge the product impact.');
    expect(response.statusCode, response.body).toBe(200);
    expect(item(created.id)).toMatchObject({
      state: 'open',
      assignees: ['owner'],
      payload: { recipient: 'owner', integratorOpenedAt: START },
    });
    expect(item(created.id).payload.integratorEscalatedAt).toBeDefined();
    expect(escalations()).toHaveLength(1);
    expect(escalations()[0]).toMatchObject({
      actor: { operatorMode: 'super' },
      data: {
        inboxItemId: created.id,
        from: 'integrator',
        to: 'owner',
        reason: 'integrator_passed_on',
        note: 'I cannot judge the product impact.',
      },
    });
    expect(record()).toMatchObject({ holdPhase: 'owner', inboxItemId: created.id });
    expect(task().fixLimit?.recipient).toBe('owner');
    expect(domain().inbox.countOpenFor('AR', 'owner')).toBe(1);
    // The integrator has no say any more.
    expect((await decide(created.id, 'another_round')).json().error.code).toBe('super_relay_refused');

    const owner = await h.app.inject({
      method: 'POST',
      url: routes.resolveInbox('AR', created.id),
      headers: { cookie },
      payload: { optionId: 'another_round' },
    });
    expect(owner.statusCode, owner.body).toBe(200);
    expect(fixLimitEvents().at(-1)).toMatchObject({
      actor: { kind: 'human', handle: 'owner' },
      data: { decision: 'another_round' },
    });
  });

  it('hands the item to the technical direction holders, not to every owner, and rewrites the closing line', async () => {
    await domain().projects.update('AR', { actor: humanActor('owner'), author: OWNER_LOGIN }, (draft) => {
      draft.team.members.push({
        kind: 'human',
        handle: 'boss',
        displayName: 'Boss',
        access: 'admin',
        roles: ['lead_developer'],
      } as ProjectConfig['team']['members'][number]);
      return 'Add an admin who holds the technical direction';
    });
    const config = await domain().projects.config('AR');
    const footer = getLocale(config.project.language).fixLimitItem.footer;
    const created = await passedOn();
    expect(created.assignees).toEqual(['boss']);
    expect(created.body).toContain(footer.integrator);
    expect(record()!.deciders).toEqual(['boss']);

    const response = await decide(created.id, 'to_owner', 'Not mine to decide.');
    expect(response.statusCode, response.body).toBe(200);
    const moved = item(created.id);
    expect(moved.assignees).toEqual(['boss']);
    expect(moved.assignees).toEqual(record()!.deciders);
    expect(moved.body).toContain(ASSESSMENT.recurrence);
    expect(moved.body).toContain(footer.owner);
    expect(moved.body).not.toContain(footer.integrator);
  });

  it('goes straight to the owners when the project has no Operator', async () => {
    await heldAtLimit();
    const config = structuredClone(await domain().projects.config('AR'));
    config.team.members = config.team.members.filter(
      (member) => member.kind !== 'ai' || member.role !== 'ai_operator',
    );
    vi.spyOn(domain().projects, 'config').mockResolvedValue(config);
    await domain().fixLimit.decide('lead', 'AR', 'AR-1', 'to_owner', 'Not my call.', ASSESSMENT);
    const created = item(record()!.inboxItemId!);
    expect(created.payload).toMatchObject({ recipient: 'owner', recipientRefusal: 'integrator_unavailable' });
    expect(created.payload.integratorOpenedAt).toBeUndefined();
    expect(domain().inbox.countOpenFor('AR', 'owner')).toBe(1);
    expect((await decide(created.id, 'another_round')).json().error.code).toBe('integrator_not_allowed');
  });

  it('keeps the item for the integrator after 24 hours: the Operator’s queue has no escalation', async () => {
    const created = await passedOn();
    now = new Date(now.getTime() + 86_400_000);
    expect(item(created.id).payload).toMatchObject({ recipient: 'integrator' });
    expect(escalations()).toHaveLength(0);
    expect((await decide(created.id, 'another_round')).statusCode).toBe(200);
  });

  it('lets one of two simultaneous decisions win', async () => {
    const created = await passedOn();
    const results = await Promise.all([decide(created.id, 'another_round'), decide(created.id, 'reassign')]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(fixLimitEvents().filter((event) => event.data.phase === 'decided')).toHaveLength(1);
  });

  it('refuses every credential that is not a super key, and changes nothing', async () => {
    const created = await passedOn();
    const { auth } = h.app.projectman;
    const user = repos().users.list()[0]!;
    const read = auth.createIntegratorAccessKey(user.id, { mode: 'read', expiresInDays: 7 });
    const legacy = auth.createIntegratorKey(user.id, null);
    const refused = [
      [await decide(created.id, 'another_round', undefined, { authorization: `Bearer ${read.secret}` }), 403],
      [
        await decide(created.id, 'another_round', undefined, { authorization: `Bearer ${legacy.secret}` }),
        403,
      ],
      [await decide(created.id, 'another_round', undefined, { cookie }), 403],
    ] as const;
    for (const [response, status] of refused) expect(response.statusCode, response.body).toBe(status);
    expect(item(created.id).state).toBe('open');
    expect(record()).toMatchObject({ holdPhase: 'owner', extraRounds: 0 });
  });

  it('keeps the generic resolve, the relay and the todo endpoint closed to the item', async () => {
    const created = await passedOn();
    const generic = await h.app.inject({
      method: 'POST',
      url: routes.resolveInbox('AR', created.id),
      headers: headers(),
      payload: { optionId: 'another_round' },
    });
    expect(generic.json().error.code).toBe('super_relay_refused');
    const relay = await h.app.inject({
      method: 'POST',
      url: routes.relayOwnerAnswer('AR', created.id),
      headers: headers(),
      payload: { answer: 'Go on.' },
    });
    expect(relay.json().error.code).toBe('super_relay_refused');
    const todo = await h.app.inject({
      method: 'POST',
      url: routes.resolveIntegratorTodo('AR', created.id),
      headers: headers(),
      payload: { optionId: 'todo_done' },
    });
    expect(todo.statusCode).toBeGreaterThanOrEqual(400);
    expect(item(created.id).state).toBe('open');
    expect(record()).toMatchObject({ holdPhase: 'owner', extraRounds: 0 });
  });

  it('refuses items that are not the narrow fix limit decision, with the original codes', async () => {
    const make = (payload: Record<string, unknown>) =>
      domain().inbox.create({
        projectKey: 'AR',
        kind: 'decision',
        assignees: ['owner'],
        source: 'system',
        title: 'Decision',
        payload,
        options: [{ id: 'another_round', label: 'Another round', style: 'primary' }],
      });
    const plain = make({});
    const mixed = make({
      fixLimit: { taskKey: 'AR-1', rounds: 2, limit: 2, reason: 'passed_on' },
      recipient: 'integrator',
      integratorOpenedAt: START,
      release: { id: 'x' },
    });
    const owners = make({
      fixLimit: { taskKey: 'AR-1', rounds: 2, limit: 2, reason: 'passed_on' },
      recipient: 'owner',
    });
    for (const target of [plain, mixed, owners]) {
      const response = await decide(target.id, 'another_round');
      expect(response.statusCode, response.body).toBe(403);
      expect(item(target.id).state).toBe('open');
    }
    expect((await decide('no-such-item', 'another_round')).statusCode).toBe(404);
  });
});
