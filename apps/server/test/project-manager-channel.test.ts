import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectManagerChannel, routes } from '@projectman/shared';
import { createDomainHarness, OWNER_ACTOR, type DomainHarness } from './helpers/domain-harness';
import {
  addHumanAndLogin,
  createAppHarness,
  createProject,
  setupOwner,
  type AppHarness,
} from './helpers/app-harness';
import { flush } from './helpers/fakes';

let h: DomainHarness;
let app: AppHarness;
afterEach(async () => {
  vi.restoreAllMocks();
  await h?.cleanup();
  await app?.close();
  h = undefined!;
  app = undefined!;
});

async function harness(onLeave = false) {
  h = await createDomainHarness({
    adjust: (config) => {
      const pm = config.team.members.find((m) => m.handle === 'pm')!;
      if (pm.kind === 'ai') {
        pm.onLeave = onLeave;
        pm.capacity = 1;
      }
    },
  });
  return h;
}
const view = () => h.domain.projectManagerChannels.view('AR');

describe('the permanent project manager channel', () => {
  it.each(['direct', 'admission'] as const)(
    'records one card assignment through %s for a new and a running conversation',
    async (path) => {
      await harness();
      const task = await h.domain.tasks.create('AR', { title: 'Distribute checkout work' }, OWNER_ACTOR);
      const config = await h.domain.projects.config('AR');
      const member = config.team.members.find((m) => m.handle === 'pm');
      if (member?.kind !== 'ai') throw new Error('Missing manager');
      const workItem = { type: 'task', taskKey: task.key } as const;
      const cause = { kind: 'start_button', by: OWNER_ACTOR } as const;
      const start = () =>
        path === 'direct'
          ? h.domain.sessions.ensureSession('AR', 'pm', workItem, { cause })
          : h.domain.admission.start({ config, member, workItem, cause });
      const first = await start();
      expect(first.started).toBe(true);
      let messages = h.domain.messages.list('AR', { member: 'pm' }).filter((m) => m.from === 'system');
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ taskKey: task.key, kind: 'action' });
      expect(messages[0]!.body).toContain('started by');
      expect(messages[0]!.body).toContain(task.title);
      const second = await start();
      expect(second.started).toBe(false);
      expect(second.session.id).toBe(first.session.id);
      messages = h.domain.messages.list('AR', { member: 'pm' }).filter((m) => m.from === 'system');
      expect(messages).toHaveLength(2);
      expect(h.runner.started).toHaveLength(1);
    },
  );

  it('uses first-input instructions without another assignment but records a running-session assignment', async () => {
    await harness();
    const task = await h.domain.tasks.create('AR', { title: 'Plan checkout' }, OWNER_ACTOR);
    const workItem = { type: 'task', taskKey: task.key } as const;
    const opts = {
      messages: ['Write the technical plan for this card'],
      cause: { kind: 'refinement' as const, labels: ['plan-ok'] },
    };
    const first = await h.domain.sessions.ensureSession('AR', 'pm', workItem, opts);
    expect(first.messagesSent).toBe(1);
    expect(h.runner.lastStarted().initialMessage).toContain(opts.messages[0]);
    expect(h.domain.messages.list('AR', { member: 'pm' })).toHaveLength(0);
    await h.domain.sessions.ensureSession('AR', 'pm', workItem, opts);
    const messages = h.domain.messages.list('AR', { member: 'pm' });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body).toContain('plan-ok');
  });
  it('serializes concurrent card starts into one general conversation at capacity one', async () => {
    await harness();
    const first = await h.domain.tasks.create('AR', { title: 'First' }, OWNER_ACTOR);
    const second = await h.domain.tasks.create('AR', { title: 'Second' }, OWNER_ACTOR);
    const starts = await Promise.all(
      [first, second].map((task) =>
        h.domain.sessions.ensureSession('AR', 'pm', { type: 'task', taskKey: task.key }),
      ),
    );
    expect(starts[0]!.session.id).toBe(starts[1]!.session.id);
    expect(starts[0]!.session.workItem).toEqual({ type: 'general' });
    expect(h.runner.started).toHaveLength(1);
    const result = await h.domain.messaging.send('AR', 'owner', {
      to: ['pm'],
      taskKey: second.key,
      text: 'Continue this card',
    });
    await flush();
    expect(h.runner.started).toHaveLength(1);
    expect(h.repos.messages.get(result.id)?.receipts?.[0]).toMatchObject({
      route: { type: 'general' },
      deliveredAt: expect.any(String),
    });
    const config = await h.domain.projects.config('AR');
    const pm = config.team.members.find((m) => m.handle === 'pm');
    if (pm?.kind !== 'ai') throw new Error('Missing manager');
    const admitted = await h.domain.admission.start({
      config,
      member: pm,
      workItem: { type: 'task', taskKey: first.key },
    });
    expect(admitted.session.id).toBe(starts[0]!.session.id);
  });

  it('wakes for an AI action on any card and bypasses refinement holds', async () => {
    await harness();
    const task = await h.domain.tasks.create('AR', { title: 'Refining', labels: ['refine'] }, OWNER_ACTOR);
    const sent = await h.domain.messaging.send(
      'AR',
      'dev-1',
      { to: ['pm'], taskKey: task.key, text: 'Distribute this work' },
      { kind: 'action' },
    );
    await vi.waitFor(() => expect(h.runner.started).toHaveLength(1));
    await flush();
    expect(h.domain.sessions.list('AR', { member: 'pm' })[0]?.workItem).toEqual({ type: 'general' });
    expect(h.repos.messages.get(sent.id)?.receipts?.[0]?.deliveredAt).toBeTruthy();
    expect(h.runner.lastStarted().initialMessage).toContain(task.key);
    expect(h.domain.messages.list('AR', { member: 'pm' }).filter((m) => m.from === 'system')).toEqual([]);
  });

  it('collects legacy task receipts in creation order and leaves other members routing intact', async () => {
    await harness();
    const task = await h.domain.tasks.create('AR', { title: 'Legacy card' }, OWNER_ACTOR);
    const legacy = h.domain.messages.record({
      projectKey: 'AR',
      from: 'owner',
      to: ['pm', 'dev-1'],
      taskKey: task.key,
      body: 'Legacy pending request',
      actor: OWNER_ACTOR,
      routes: { pm: { type: 'task', taskKey: task.key } },
    });
    expect(h.domain.messages.waiting('AR', 'pm', { type: 'general' }).map((m) => m.id)).toEqual([legacy.id]);
    expect(h.domain.messages.waiting('AR', 'dev-1', { type: 'general' })).toEqual([]);
    await h.domain.messaging.releaseWaiting('AR', task.key, 'pm');
    await vi.waitFor(() => expect(h.runner.started).toHaveLength(1));
    await flush();
    expect(h.runner.lastStarted().initialMessage).toContain('Legacy pending request');
    expect(
      h.repos.messages.get(legacy.id)?.receipts?.find((r) => r.handle === 'pm')?.deliveredAt,
    ).toBeTruthy();
    expect(h.repos.messages.pending('AR', 'dev-1')).toHaveLength(1);
  });

  it('reports leave first and retains messages for a manager on leave', async () => {
    await harness(true);
    const message = await h.domain.messaging.send('AR', 'owner', { to: ['pm'], text: 'For your return' });
    await flush();
    expect(await view()).toMatchObject({
      state: 'on_leave',
      sessionId: null,
      member: { handle: 'pm', onLeave: true },
    });
    expect(h.repos.messages.pending('AR', 'pm').map((m) => m.id)).toEqual([message.id]);
    expect(h.runner.started).toHaveLength(0);
  });

  it('flushes legacy card receipts into a running general conversation', async () => {
    await harness();
    const task = await h.domain.tasks.create('AR', { title: 'Old receipts' }, OWNER_ACTOR);
    const { session } = await h.domain.sessions.ensureSession('AR', 'pm', { type: 'general' });
    const message = h.domain.messages.record({
      projectKey: 'AR',
      from: 'dev-1',
      to: ['pm'],
      taskKey: task.key,
      body: 'Queued before the new route',
      actor: { kind: 'ai', handle: 'dev-1' },
      routes: { pm: { type: 'task', taskKey: task.key } },
    });
    h.repos.sessions.update(session.id, { state: 'idle' });
    expect(h.domain.sessions.messageWaiting(h.domain.sessions.find(session.id)!)).toBe(true);
    await h.domain.messaging.releaseWaiting('AR', task.key, 'pm');
    await flush();
    expect(h.runner.started).toHaveLength(1);
    expect(
      h.runner.messages.some((input) => input.sessionId === session.id && input.text.includes(message.body)),
    ).toBe(true);
    expect(h.repos.messages.pending('AR', 'pm')).toEqual([]);
  });

  it('returns a card question answer to the general conversation', async () => {
    await harness();
    const task = await h.domain.tasks.create('AR', { title: 'Question' }, OWNER_ACTOR);
    const { session } = await h.domain.sessions.ensureSession('AR', 'pm', { type: 'general' });
    const { inboxItemId } = await h.domain.teamTools.askHuman(
      { projectKey: 'AR', member: 'pm', taskKey: task.key, sessionId: session.id },
      { question: 'Which step comes first?', options: ['Planning', 'Delivery'] },
    );
    await h.domain.inbox.resolve(
      'AR',
      inboxItemId,
      { optionId: 'option_1' },
      { handle: 'owner', access: 'owner' },
    );
    await flush();
    expect(h.runner.started).toHaveLength(1);
    expect(
      h.runner.messages.some((input) => input.sessionId === session.id && input.text.includes('Planning')),
    ).toBe(true);
  });

  it('reports deferred wake-ups once for all cards while retaining every message', async () => {
    await harness();
    await h.domain.projects.update(
      'AR',
      { actor: OWNER_ACTOR, author: { name: 'Owner', email: 'owner@example.com' } },
      (c) => {
        c.team.limits.aiEnabled = false;
        return 'Disable AI';
      },
    );
    for (const title of ['First', 'Second']) {
      const task = await h.domain.tasks.create('AR', { title }, OWNER_ACTOR);
      await h.domain.messaging.send('AR', 'owner', { to: ['pm'], taskKey: task.key, text: title });
    }
    await vi.waitFor(async () =>
      expect(await view()).toMatchObject({ state: 'waiting', waiting: { reason: 'ai_disabled' } }),
    );
    expect(
      h.repos.deferredStarts.list().filter((entry) => entry.key.startsWith('message:AR:pm:')),
    ).toHaveLength(1);
    expect(h.repos.messages.pending('AR', 'pm')).toHaveLength(2);
  });

  it('reports pause and each conversation state, including ended conversations', async () => {
    await harness();
    expect(await view()).toMatchObject({ state: 'available', sessionId: null });
    const { session } = await h.domain.sessions.ensureSession('AR', 'pm', { type: 'general' });
    for (const [state, expected] of [
      ['starting', 'starting'],
      ['working', 'working'],
      ['waiting_permission', 'working'],
      ['idle', 'available'],
      ['waiting_input', 'available'],
      ['exited', 'available'],
    ] as const) {
      h.repos.sessions.update(session.id, { state });
      expect(ProjectManagerChannel.parse(await view())).toMatchObject({
        state: expected,
        sessionId: session.id,
      });
    }
    await h.domain.pauses.pause({ scope: 'project', projectKey: 'AR' }, { userId: null, source: 'system' });
    expect(await view()).toMatchObject({
      state: 'waiting',
      waiting: { reason: 'team_paused', since: expect.any(String) },
    });
  });

  it('returns the DTO to developers and refuses clients and viewers', async () => {
    app = await createAppHarness({ app: { claudeTmpRoots: [] } });
    const owner = await setupOwner(app.app);
    await createProject(app, owner);
    for (const access of ['developer', 'client', 'viewer'] as const) {
      const cookie = await addHumanAndLogin(app.app, {
        handle: access,
        access,
        email: `${access}@example.com`,
      });
      const response = await app.app.inject({ url: routes.projectManager('AR'), headers: { cookie } });
      expect(response.statusCode).toBe(access === 'developer' ? 200 : 403);
      if (access === 'developer')
        expect(ProjectManagerChannel.parse(response.json()).member?.handle).toBe('pm');
    }
  });

  it('reports a legacy project without a manager as missing', async () => {
    await harness();
    const config = await h.domain.projects.config('AR');
    vi.spyOn(h.domain.projects, 'config').mockResolvedValue({
      ...config,
      team: { ...config.team, members: config.team.members.filter((m) => m.handle !== 'pm') },
    });
    expect(await view()).toEqual({ member: null, state: 'missing', sessionId: null });
    vi.restoreAllMocks();
  });
});
