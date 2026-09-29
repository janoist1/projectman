import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardView, Me, MemberView, ServerEvent, TaskDetail } from '@projectman/shared';
import type { AgentProvider, PlanUsage } from '@projectman/shared';
import { createAppHarness, createProject, setupOwner, cookieOf } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import { pullRequest } from './helpers/fakes';

const usage = (percent: number): PlanUsage => ({
  fiveHourPercent: percent,
  weeklyPercent: percent + 10,
  fiveHourResetsAt: '2026-10-01T12:00:00.000Z',
  weeklyResetsAt: '2026-10-04T12:00:00.000Z',
  fetchedAt: '2026-10-01T10:00:00.000Z',
});

describe('web contract follow-ups', () => {
  let h: AppHarness;
  let cookie: string;
  let refreshUsage: () => void;
  beforeEach(async () => {
    const intervals = vi.spyOn(globalThis, 'setInterval');
    h = await createAppHarness();
    refreshUsage = intervals.mock.calls.find((call) => call[1] === 60_000)![0] as () => void;
    cookie = await setupOwner(h.app);
    await createProject(h, cookie);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.close();
  });

  const by = { actor: OWNER_ACTOR, author: OWNER, sponsor: 'owner' };

  async function get(url: string, login = cookie) {
    return h.app.inject({ method: 'GET', url, headers: { cookie: login } });
  }

  it.each(['client', 'viewer'] as const)(
    'exposes AI session settings to a %s through the board',
    async (access) => {
      const member = await h.app.projectman.domain.members.hire(
        'AR',
        { role: 'qa', model: 'fictional-model', provider: 'codex' },
        by,
      );
      const invite = await h.app.inject({
        method: 'POST',
        url: '/api/projects/AR/invites',
        headers: { cookie },
        payload: { email: `${access}@example.test`, access, roles: [] },
      });
      const accepted = await h.app.inject({
        method: 'POST',
        url: invite.json().path.replace('/invite/', '/api/invites/') + '/accept',
        payload: { name: 'Fictional reader', password: 'correct horse battery' },
      });
      const login = cookieOf(accepted);
      if (access === 'client') expect((await get('/api/projects/AR/config', login)).statusCode).toBe(403);
      const board = BoardView.parse((await get('/api/projects/AR/board', login)).json());
      expect(MemberView.parse(board.members.find((m) => m.handle === member.handle))).toMatchObject({
        model: 'fictional-model',
        permissionMode: member.permissionMode,
        provider: 'codex',
      });
      expect(board.members.find((m) => m.kind === 'human')).not.toHaveProperty('model');
      expect(Me.parse((await get('/api/me', login)).json()).projects).toEqual([
        { key: 'AR', name: 'acme', access, roles: [] },
      ]);
    },
  );

  it('lists only the authenticated user’s projects and reflects changed membership roles', async () => {
    await h.app.projectman.domain.projects.create(
      { key: 'OTHER', name: 'Other fictional project', workspacePath: h.workspace, templateId: 'test' },
      { name: 'Other owner', email: 'other@example.test' },
    );
    await h.app.projectman.domain.members.update('AR', 'owner', { roles: ['operator', 'qa'] }, by);
    const me = Me.parse((await get('/api/me')).json());
    expect(me.handles).toEqual({ AR: 'owner' });
    expect(me.projects).toEqual([{ key: 'AR', name: 'acme', access: 'owner', roles: ['operator', 'qa'] }]);
  });

  it('publishes member snapshots on hire, update, retirement and invitation acceptance', async () => {
    const events: ServerEvent[] = [];
    h.app.projectman.domain.bus.subscribe((event) => events.push(ServerEvent.parse(event)));
    const member = await h.app.projectman.domain.members.hire('AR', { role: 'qa' }, by);
    await h.app.projectman.domain.members.update('AR', member.handle, { model: 'fictional-new-model' }, by);
    await h.app.projectman.domain.members.retire('AR', member.handle, {}, by);
    const invite = await h.app.inject({
      method: 'POST',
      url: '/api/projects/AR/invites',
      headers: { cookie },
      payload: { email: 'reader@example.test', access: 'viewer', roles: ['qa'] },
    });
    await h.app.inject({
      method: 'POST',
      url: invite.json().path.replace('/invite/', '/api/invites/') + '/accept',
      payload: { name: 'Fictional reader', password: 'correct horse battery' },
    });
    expect(events.filter((e) => e.type === 'member_changed')).toEqual([
      expect.objectContaining({
        handle: member.handle,
        member: expect.objectContaining({ model: member.model }),
      }),
      expect.objectContaining({
        handle: member.handle,
        member: expect.objectContaining({ model: 'fictional-new-model' }),
      }),
      expect.objectContaining({ handle: member.handle, member: null }),
      expect.objectContaining({
        handle: 'fictional-reader',
        member: expect.objectContaining({ kind: 'human', role: 'viewer', roles: ['qa'] }),
      }),
    ]);
  });

  it('uses the runner’s per-provider plan usage for snapshots and fetched events', async () => {
    const module = h.runnerModule.createWithBroker(h.runnerModule.broker());
    const values = { claude: usage(12), codex: usage(34) };
    const calls: AgentProvider[] = [];
    module.planUsageFor = (provider) => ({
      get: async () => {
        calls.push(provider);
        return values[provider];
      },
    });
    await h.app.projectman.domain.members.hire('AR', { role: 'qa', provider: 'codex' }, by);
    const events: ServerEvent[] = [];
    h.app.projectman.domain.bus.subscribe((event) => events.push(ServerEvent.parse(event)));
    const board = BoardView.parse((await get('/api/projects/AR/board')).json());
    expect(board.planUsage).toEqual(values.claude);
    expect(board.planUsageByProvider).toEqual(values);
    expect(calls.sort()).toEqual(['claude', 'codex']);
    expect(events.filter((e) => e.type === 'plan_usage')).toEqual(
      expect.arrayContaining([
        { type: 'plan_usage', projectKey: 'AR', provider: 'claude', usage: values.claude },
        { type: 'plan_usage', projectKey: 'AR', provider: 'codex', usage: values.codex },
      ]),
    );
    values.codex = usage(45);
    events.length = 0;
    refreshUsage();
    await vi.waitFor(() =>
      expect(events).toContainEqual({
        type: 'plan_usage',
        projectKey: 'AR',
        provider: 'codex',
        usage: values.codex,
      }),
    );
  });

  it.each([
    ['success', 'passing'],
    ['failure', 'failing'],
    ['pending', 'pending'],
    ['none', null],
  ] as const)('maps polled %s checks to %s and preserves GitHub fields', async (checks, expected) => {
    const domain = h.app.projectman.domain;
    const task = await domain.tasks.create('AR', { title: 'Fictional login form' }, OWNER_ACTOR);
    domain.tasks.addLink('AR', task.key, { kind: 'pull_request', repo: 'acme/web', ref: '7' }, OWNER_ACTOR);
    expect(TaskDetail.parse((await get(`/api/projects/AR/tasks/${task.key}`)).json()).pullRequests).toEqual([
      {
        repo: 'acme/web',
        number: 7,
        url: null,
        title: null,
        state: null,
        checks: null,
        reviewDecision: null,
        additions: null,
        deletions: null,
      },
    ]);
    await domain.githubSync.handleChange(pullRequest({ checks, reviewDecision: 'approved' }));
    const detail = TaskDetail.parse((await get(`/api/projects/AR/tasks/${task.key}`)).json());
    expect(detail.pullRequests).toEqual([
      {
        repo: 'acme/web',
        number: 7,
        url: 'https://github.com/acme/web/pull/7',
        title: 'Add login page',
        state: 'open',
        checks: expected,
        reviewDecision: 'approved',
        additions: 10,
        deletions: 2,
      },
    ]);
    const published = vi.fn();
    domain.bus.subscribe(published);
    await domain.githubSync.handleChange(
      pullRequest({ checks, reviewDecision: 'changes_requested', additions: 99 }),
    );
    expect(domain.tasks.detail('AR', task.key).pullRequests[0]).toMatchObject({
      reviewDecision: 'changes_requested',
      additions: 99,
    });
    expect(published).toHaveBeenCalledWith(expect.objectContaining({ type: 'task_upserted' }));
  });
});
