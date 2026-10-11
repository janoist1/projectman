import { afterEach, describe, expect, it, vi } from 'vitest';
import { memberOf, operatorApprovalOf } from '@projectman/shared';
import type { AiMemberConfig, OperatorOperation, ProjectConfig } from '@projectman/shared';
import type { ToolContext } from '../src/contracts';
import { createDomainHarness, OWNER, OWNER_ACTOR, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

let h: DomainHarness;
let ctx: ToolContext;
const by = { actor: OWNER_ACTOR, author: OWNER };
const owner = { handle: 'owner', access: 'owner' as const };
afterEach(async () => {
  await h?.cleanup();
});

async function setup(persistent = false, adjust?: (config: ProjectConfig) => void) {
  h = await createDomainHarness({
    persistent,
    adjust: (config) => {
      (memberOf(config, 'dev-1') as AiMemberConfig).outboundNetwork = false;
      config.team.members.push({
        kind: 'human',
        handle: 'dana',
        displayName: 'Dana',
        access: 'admin',
        roles: [],
        email: 'dana@example.test',
      });
      config.pipeline.stages.splice(1, 0, {
        id: 'ready',
        name: 'Ready',
        kind: 'queue',
        owners: ['owner'],
        columnId: 'todo',
      });
      adjust?.(config);
    },
  });
  await h.domain.messaging.sendReporting('AR', 'owner', {
    to: ['operator'],
    text: 'Change the writer to Sonnet.\nAllow network access.',
  });
  await flush();
  const session = h.domain.sessions.list('AR', { member: 'operator' })[0]!;
  ctx = { projectKey: 'AR', member: 'operator', sessionId: session.id, taskKey: null };
}
async function operate(operation: OperatorOperation) {
  return h.domain.teamTools.operate(ctx, { title: 'Requested result', operation });
}
const network = (): OperatorOperation => ({
  op: 'member_update',
  handle: 'dev-1',
  changes: { outboundNetwork: true },
});
const member = async (handle = 'dev-1') =>
  memberOf(await h.domain.projects.config('AR'), handle) as AiMemberConfig;
const resolve = (id: string, optionId = 'approve') => h.domain.inbox.resolve('AR', id, { optionId }, owner);

describe('Operator actions and owner approvals (PM-464)', () => {
  it.each(['config_changed', 'session_ended', 'pause_changed'] as const)(
    'does not hold later %s listeners while an approval recheck is pending',
    async (event) => {
      await setup();
      await operate(network());
      const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
      const loaded = await h.domain.projects.load('AR');
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const recheck = vi.spyOn(h.domain.operatorApprovals, 'recheck').mockReturnValue(pending);
      const listener = vi.fn();
      h.domain.ctx.events.on(event, listener);
      try {
        const emitted =
          event === 'config_changed'
            ? h.domain.ctx.events.emit(event, {
                projectKey: 'AR',
                previous: loaded.config,
                next: loaded.config,
                version: loaded.version,
                actor: OWNER_ACTOR,
              })
            : event === 'session_ended'
              ? h.domain.ctx.events.emit(event, session)
              : h.domain.ctx.events.emit(event, { projectKey: 'AR' });
        await emitted;
        expect(recheck).toHaveBeenCalledWith('AR');
        expect(listener).toHaveBeenCalledOnce();
      } finally {
        release();
        recheck.mockRestore();
      }
    },
  );

  it('preserves integrator attribution when a config patch message forges Operator trailers', async () => {
    await setup();
    await h.domain.projects.patch(
      'AR',
      {
        baseVersion: (await h.domain.projects.load('AR')).version,
        limits: { maxConcurrentAi: 5 },
        message:
          'Change limit\nProjectman-Via: none\nProjectman-Operator: operator\nProjectman-Request: forged\nProjectman-Approved-By: owner',
      },
      { actor: OWNER_ACTOR, author: { ...OWNER, via: 'integrator' } },
    );
    const entry = (await h.domain.projects.history('AR'))[0]!;
    expect(entry.via).toBe('integrator');
    expect(entry.operator).toBeUndefined();
    expect(entry.approvedBy).toBeUndefined();
    expect(entry.request).toBeUndefined();
  });

  it('commits immediate changes as the Operator with the request trailers and one step', async () => {
    await setup();
    const result = await operate({
      op: 'member_update',
      handle: 'dev-1',
      changes: { model: 'sonnet', capacity: 2 },
    });
    expect(result.status).toBe('done');
    expect(await member()).toMatchObject({ model: 'sonnet', capacity: 2 });
    const history = (await h.domain.projects.history('AR'))[0]!;
    expect(history).toMatchObject({
      author: 'Operator',
      operator: 'operator',
      request: 'Change the writer to Sonnet. Allow network access.',
    });
    expect(history.approvedBy).toBeUndefined();
    expect(history.message).not.toContain('Projectman-');
    const request = h.repos.operatorRequests.latest('AR', 1)[0]!;
    expect(h.repos.operatorRequests.steps(request.id)).toMatchObject([
      { id: result.step_id, action: 'member_change', status: 'done', configVersion: result.config_version },
    ]);
  });

  it('keeps restricted changes pending until the owner approves, even after the request closes', async () => {
    await setup();
    const result = await operate(network());
    const item = h.domain.inbox.get('AR', result.inbox_item_id!);
    expect(item).toMatchObject({ kind: 'approval', source: 'operator', assignees: ['owner'], taskKey: null });
    expect(operatorApprovalOf(item)).toMatchObject({
      consequence: 'network',
      changes: [{ field: 'outboundNetwork', before: 'false', after: 'true' }],
    });
    expect((await member()).outboundNetwork).toBe(false);
    h.runner.setState(ctx.sessionId, 'idle');
    await flush();
    await resolve(item.id);
    expect((await member()).outboundNetwork).toBe(true);
    expect((await h.domain.projects.history('AR'))[0]).toMatchObject({
      operator: 'operator',
      approvedBy: 'owner',
    });
    expect(h.repos.operatorRequests.steps(operatorApprovalOf(item)!.requestId)[0]?.status).toBe('approved');
    expect(h.repos.messages.pending('AR', 'operator').some((m) => m.body.includes('approved by owner'))).toBe(
      true,
    );
  });

  it('rejects without changing configuration or waking the Operator', async () => {
    await setup();
    const result = await operate(network());
    const version = (await h.domain.projects.load('AR')).version;
    await resolve(result.inbox_item_id!, 'reject');
    expect((await h.domain.projects.load('AR')).version).toBe(version);
    expect((await member()).outboundNetwork).toBe(false);
    const request = h.repos.operatorRequests.latest('AR', 1)[0]!;
    expect(h.repos.operatorRequests.steps(request.id)[0]?.status).toBe('rejected');
    expect(h.repos.messages.pending('AR', 'operator').some((m) => m.body.includes('rejected'))).toBe(true);
  });

  it('marks a changed field stale proactively and permits only dismissal', async () => {
    await setup();
    const result = await operate(network());
    await h.domain.members.update('AR', 'dev-1', { outboundNetwork: true }, by);
    await flush();
    const item = h.domain.inbox.get('AR', result.inbox_item_id!);
    expect(operatorApprovalOf(item)?.stale?.reason).toBe('config_changed');
    expect(item.options.map((o) => o.id)).toEqual(['dismiss']);
    await expect(resolve(item.id)).rejects.toMatchObject({ code: 'operator_approval_stale', status: 409 });
    await expect(resolve(item.id, 'reject')).rejects.toMatchObject({ code: 'operator_approval_stale' });
    expect(h.domain.inbox.get('AR', item.id).state).toBe('open');
    await resolve(item.id, 'dismiss');
    expect(h.domain.inbox.get('AR', item.id).state).toBe('resolved');
  });

  it('replays against current configuration when an unrelated field changed', async () => {
    await setup();
    const result = await operate(network());
    await h.domain.members.update('AR', 'dev-1', { model: 'sonnet' }, by);
    expect(operatorApprovalOf(h.domain.inbox.get('AR', result.inbox_item_id!))?.stale).toBeNull();
    await resolve(result.inbox_item_id!);
    expect((await member()).outboundNetwork).toBe(true);
    expect((await member()).model).toBe('sonnet');
  });

  it('allows one of two concurrent decisions to execute only once', async () => {
    await setup();
    const result = await operate(network());
    const outcomes = await Promise.allSettled([
      resolve(result.inbox_item_id!),
      resolve(result.inbox_item_id!),
    ]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await h.domain.projects.history('AR')).filter((row) => row.approvedBy === 'owner')).toHaveLength(
      1,
    );
  });

  it('rechecks the approved rows at commit if state changes after the replay', async () => {
    await setup();
    const result = await operate(network());
    const execute = h.domain.operatorActions.execute.bind(h.domain.operatorActions);
    vi.spyOn(h.domain.operatorActions, 'execute').mockImplementationOnce(async (...args) => {
      await h.domain.members.update('AR', 'dev-1', { outboundNetwork: true }, by);
      return execute(...args);
    });
    await expect(resolve(result.inbox_item_id!)).rejects.toMatchObject({
      code: 'operator_approval_stale',
      status: 409,
    });
    expect(operatorApprovalOf(h.domain.inbox.get('AR', result.inbox_item_id!))?.stale?.reason).toBe(
      'config_changed',
    );
    expect((await h.domain.projects.history('AR')).some((row) => row.approvedBy === 'owner')).toBe(false);
  });

  it('rejects integrator decisions and non-owner human decisions', async () => {
    await setup();
    const result = await operate(network());
    await expect(
      h.domain.inbox.resolve(
        'AR',
        result.inbox_item_id!,
        { optionId: 'approve' },
        { ...owner, via: 'integrator' },
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      h.domain.inbox.resolve(
        'AR',
        result.inbox_item_id!,
        { optionId: 'approve' },
        { handle: 'dana', access: 'admin' },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect((await member()).outboundNetwork).toBe(false);
  });

  it('logs forbidden configuration operations and refuses other tool callers', async () => {
    await setup();
    await expect(operate({ op: 'member_retire', handle: 'operator' })).rejects.toMatchObject({
      code: 'forbidden',
      message: expect.stringContaining('operator_never:'),
    });
    await expect(
      operate({ op: 'member_update', handle: 'operator', changes: { capacity: 2 } }),
    ).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('operator_never:') });
    const request = h.repos.operatorRequests.latest('AR', 1)[0]!;
    expect(h.repos.operatorRequests.steps(request.id).every((s) => s.status === 'refused')).toBe(true);
    await expect(
      h.domain.teamTools.operate({ ...ctx, member: 'dev-1' }, { title: 'Change', operation: network() }),
    ).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('operator_only:') });
    await expect(
      h.domain.teamTools.startTask({ ...ctx, member: 'dev-1' }, { taskKey: 'AR-1' }),
    ).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('operator_only:') });
  });

  it('requires an open owner request before either tool writes', async () => {
    await setup();
    h.runner.setState(ctx.sessionId, 'idle');
    await flush();
    await expect(operate(network())).rejects.toMatchObject({
      message: expect.stringContaining('operator_no_request:'),
    });
    await expect(h.domain.teamTools.startTask(ctx, { taskKey: 'AR-1' })).rejects.toMatchObject({
      message: expect.stringContaining('operator_no_request:'),
    });
  });

  it('marks stopping an ended session stale and forbids stopping itself', async () => {
    await setup();
    await h.domain.messaging.sendReporting('AR', 'owner', { to: ['dev-1'], text: 'Hello' });
    await flush();
    const target = h.domain.sessions.list('AR', { member: 'dev-1' })[0]!;
    const result = await operate({ op: 'session_stop', sessionId: target.id });
    await h.domain.sessions.stop('AR', target.id);
    await flush();
    expect(operatorApprovalOf(h.domain.inbox.get('AR', result.inbox_item_id!))?.stale?.reason).toBe(
      'session_changed',
    );
    await expect(resolve(result.inbox_item_id!)).rejects.toMatchObject({ code: 'operator_approval_stale' });
    await expect(operate({ op: 'session_stop', sessionId: ctx.sessionId })).rejects.toMatchObject({
      message: expect.stringContaining('operator_never:'),
    });
  });

  it('stops a matching live session only after approval', async () => {
    await setup();
    await h.domain.messaging.sendReporting('AR', 'owner', { to: ['dev-1'], text: 'Hello' });
    await flush();
    const target = h.domain.sessions.list('AR', { member: 'dev-1' })[0]!;
    const result = await operate({ op: 'session_stop', sessionId: target.id });
    expect(h.domain.sessions.isRunning(target.id)).toBe(true);
    await resolve(result.inbox_item_id!);
    expect(h.domain.sessions.isRunning(target.id)).toBe(false);
    expect(operatorApprovalOf(h.domain.inbox.get('AR', result.inbox_item_id!))?.stale).toBeNull();
  });

  it('makes pause approval stale when the pause state changes', async () => {
    await setup();
    const result = await operate({ op: 'project_pause' });
    await h.domain.pauses.pause({ scope: 'project', projectKey: 'AR' }, { userId: null, source: 'app' });
    await flush();
    expect(operatorApprovalOf(h.domain.inbox.get('AR', result.inbox_item_id!))?.stale?.reason).toBe(
      'pause_changed',
    );
    await expect(resolve(result.inbox_item_id!)).rejects.toMatchObject({ code: 'operator_approval_stale' });
  });

  it('pauses only after approval and resumes an approved matching pause', async () => {
    await setup();
    const pause = await operate({ op: 'project_pause' });
    expect(h.domain.pauses.isPaused('AR')).toBe(false);
    await resolve(pause.inbox_item_id!);
    expect(h.domain.pauses.isPaused('AR')).toBe(true);
    const resume = await operate({ op: 'project_resume' });
    await resolve(resume.inbox_item_id!);
    expect(h.domain.pauses.isPaused('AR')).toBe(false);
  });

  it('hires and retires through the existing member service after approval', async () => {
    await setup();
    const hire = await operate({ op: 'member_hire', request: { role: 'developer', handle: 'writer' } });
    expect(memberOf(await h.domain.projects.config('AR'), 'writer')).toBeUndefined();
    await resolve(hire.inbox_item_id!);
    expect(await member('writer')).toMatchObject({ role: 'developer', sponsor: 'owner' });
    const retire = await operate({ op: 'member_retire', handle: 'writer' });
    await resolve(retire.inbox_item_id!);
    expect(memberOf(await h.domain.projects.config('AR'), 'writer')).toBeUndefined();
  });

  it('judges a revert by its resulting changes and attributes the new commit', async () => {
    await setup();
    const version = (await h.domain.projects.load('AR')).version;
    await h.domain.members.update('AR', 'dev-1', { model: 'sonnet' }, by);
    const now = await operate({ op: 'config_revert', version });
    expect(now.status).toBe('done');
    await h.domain.members.update('AR', 'dev-1', { outboundNetwork: true }, by);
    const approval = await operate({ op: 'config_revert', version });
    expect(approval.status).toBe('awaiting_approval');
    await resolve(approval.inbox_item_id!);
    expect((await member()).outboundNetwork).toBe(false);
    expect((await h.domain.projects.history('AR'))[0]).toMatchObject({
      operator: 'operator',
      approvedBy: 'owner',
    });
  });

  it('preserves approval proposals and decisions across a server restart', async () => {
    await setup(true);
    const result = await operate(network());
    h = await restartDomainHarness(h);
    await resolve(result.inbox_item_id!);
    expect((await member()).outboundNetwork).toBe(true);
  });

  it('starts ready work and restarts a stalled work-stage task', async () => {
    await setup();
    const task = await h.domain.tasks.create('AR', { title: 'Write', stageId: 'ready' }, OWNER_ACTOR);
    const first = await h.domain.teamTools.startTask(ctx, { taskKey: task.key, assignee: 'dev-1' });
    expect(first.session_id).toBeTruthy();
    expect(h.domain.tasks.get('AR', task.key).stageId).toBe('development');
    await h.domain.sessions.stop('AR', first.session_id!);
    const second = await h.domain.teamTools.startTask(ctx, { taskKey: task.key });
    expect(second.session_id).toBeTruthy();
    expect(h.domain.sessions.isRunning(second.session_id!)).toBe(true);
  });

  it('honors the explicit prerequisite override only for the owner-requested Operator start', async () => {
    await setup();
    const task = await h.domain.tasks.create('AR', { title: 'Dependent', stageId: 'ready' }, OWNER_ACTOR);
    const prerequisite = await h.domain.tasks.create('AR', { title: 'First' }, OWNER_ACTOR);
    await h.domain.tasks.update(
      'AR',
      task.key,
      { relations: { add: [{ kind: 'prerequisite', key: prerequisite.key }] } },
      OWNER_ACTOR,
    );
    await expect(h.domain.teamTools.startTask(ctx, { taskKey: task.key })).rejects.toThrow();
    const result = await h.domain.teamTools.startTask(ctx, { taskKey: task.key, despitePrerequisites: true });
    expect(result.session_id).toBeTruthy();
  });

  it('starts AI gate setters and waits for their label', async () => {
    await setup(false, (config) => {
      config.team.members.push({
        kind: 'ai',
        handle: 'des',
        displayName: 'Designer',
        role: 'designer',
        sponsor: 'owner',
        model: 'sonnet',
        capacity: 1,
        temp: false,
        permissionMode: 'auto',
        instructions: '',
      });
      config.pipeline.labels.push({
        id: 'design-ok',
        name: 'Design ready',
        setBy: { duties: ['ux_design'] },
      });
      config.pipeline.stages.find((s) => s.id === 'development')!.gate = {
        conditions: [{ type: 'has_label', label: 'design-ok' }],
      };
    });
    const task = await h.domain.tasks.create('AR', { title: 'Screen', stageId: 'ready' }, OWNER_ACTOR);
    const result = await h.domain.teamTools.startTask(ctx, { taskKey: task.key });
    expect(result.session_id).toBeNull();
    expect(h.domain.sessions.list('AR', { taskKey: task.key }).map((s) => s.member)).toEqual(['des']);
    expect(h.domain.tasks.get('AR', task.key).startWaiting).toMatchObject({
      reason: 'label_missing',
    });
  });

  it('refuses a fix-limit hold without granting another fix round', async () => {
    await setup();
    const task = await h.domain.tasks.create('AR', { title: 'Fix', stageId: 'ready' }, OWNER_ACTOR);
    h.repos.taskFixLimits.save({
      taskKey: task.key,
      projectKey: 'AR',
      countedFrom: null,
      extraRounds: 0,
      holdPhase: 'owner',
      heldAt: new Date().toISOString(),
      decider: null,
      deciders: ['owner'],
      reason: 'again',
      inboxItemId: null,
    });
    await expect(h.domain.teamTools.startTask(ctx, { taskKey: task.key })).rejects.toMatchObject({
      code: 'forbidden',
      message: expect.stringContaining('the Operator cannot start'),
    });
    expect(h.repos.taskFixLimits.get(task.key)?.extraRounds).toBe(0);
  });

  it('hires a policy-limited temp worker as the system and names it in the start step', async () => {
    await setup(false, (config) => {
      (memberOf(config, 'dev-1') as AiMemberConfig).onLeave = true;
      (memberOf(config, 'dev-2') as AiMemberConfig).onLeave = true;
      config.team.limits.tempWorkers = { enabled: true, max: 1, role: 'developer' };
    });
    const task = await h.domain.tasks.create(
      'AR',
      { title: 'Temporary work', stageId: 'ready' },
      OWNER_ACTOR,
    );
    const result = await h.domain.teamTools.startTask(ctx, { taskKey: task.key });
    expect(result.hired).toBeTruthy();
    expect(await member(result.hired!)).toMatchObject({ temp: true, sponsor: 'owner' });
    const request = h.repos.operatorRequests.latest('AR', 1)[0]!;
    expect(h.repos.operatorRequests.steps(request.id).at(-1)).toMatchObject({
      action: 'task_start',
      status: 'done',
      member: result.hired,
    });
    expect(h.domain.timeline.list('AR').find((e) => e.type === 'member_hired')?.actor.kind).toBe('system');
    const next = await h.domain.tasks.create('AR', { title: 'No more temps', stageId: 'ready' }, OWNER_ACTOR);
    await expect(h.domain.teamTools.startTask(ctx, { taskKey: next.key })).rejects.toThrow();
    expect(
      (await h.domain.projects.config('AR')).team.members.filter((m) => m.kind === 'ai' && m.temp),
    ).toHaveLength(1);
  });
});
