import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardView, Me, MemberView, ServerEvent } from '@projectman/shared';
import type { AgentProvider } from '@projectman/shared';
import { cookieOf, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import { planUsage } from './helpers/fakes';

describe('board API', () => {
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

  it.each(['client', 'viewer'] as const)(
    'exposes AI session settings to a %s through the board',
    async (access) => {
      const member = await h.app.projectman.domain.members.hire(
        'AR',
        { role: 'qa', model: 'fictional-model', provider: 'codex' },
        by,
      );
      const invite = await inject(h.app, 'POST', '/api/projects/AR/invites', cookie, {
        email: `${access}@example.test`,
        access,
        roles: [],
      });
      const accepted = await inject(
        h.app,
        'POST',
        invite.json().path.replace('/invite/', '/api/invites/') + '/accept',
        null,
        { name: 'Fictional reader', password: 'correct horse battery' },
      );
      const login = cookieOf(accepted);
      if (access === 'client')
        expect((await inject(h.app, 'GET', '/api/projects/AR/config', login)).statusCode).toBe(403);
      const board = BoardView.parse((await inject(h.app, 'GET', '/api/projects/AR/board', login)).json());
      expect(MemberView.parse(board.members.find((m) => m.handle === member.handle))).toMatchObject({
        model: 'fictional-model',
        permissionMode: member.permissionMode,
        provider: 'codex',
      });
      expect(board.members.find((m) => m.kind === 'human')).not.toHaveProperty('model');
      expect(Me.parse((await inject(h.app, 'GET', '/api/me', login)).json()).projects).toEqual([
        { key: 'AR', name: 'acme', access, roles: [] },
      ]);
    },
  );

  it('sends a client no key of an internal card an AI member works on, on the board, the member list and the profile (PM-244)', async () => {
    const { domain } = h.app.projectman;
    const member = await domain.members.hire('AR', { role: 'qa' }, by);
    const internal = await domain.tasks.create(
      'AR',
      { title: 'Internal job', visibility: 'internal' },
      OWNER_ACTOR,
    );
    const shared = await domain.tasks.create(
      'AR',
      { title: 'Shared job', visibility: 'shared' },
      OWNER_ACTOR,
    );
    for (const task of [internal, shared]) {
      const { session } = await domain.sessions.ensureSession('AR', member.handle, {
        type: 'task',
        taskKey: task.key,
      });
      h.runner.setState(session.id, 'working', 'Bash: npm test');
    }
    const invite = await inject(h.app, 'POST', '/api/projects/AR/invites', cookie, {
      email: 'client@example.test',
      access: 'client',
      roles: [],
    });
    const accepted = await inject(
      h.app,
      'POST',
      invite.json().path.replace('/invite/', '/api/invites/') + '/accept',
      null,
      { name: 'Fictional client', password: 'correct horse battery' },
    );
    const login = cookieOf(accepted);
    const workKeys = (m: MemberView | undefined) => (m?.taskWork ?? []).map((w) => w.taskKey);
    const get = async (path: string, as: string) =>
      (await inject(h.app, 'GET', `/api/projects/AR/${path}`, as)).json();

    const clientBoard = BoardView.parse(await get('board', login));
    const ownerBoard = BoardView.parse(await get('board', cookie));
    const ownerMember = ownerBoard.members.find((m) => m.handle === member.handle);
    expect(workKeys(ownerMember).sort()).toEqual([internal.key, shared.key].sort());
    expect(ownerMember?.currentTaskKeys).toContain(internal.key);
    const clientMember = clientBoard.members.find((m) => m.handle === member.handle);
    expect(workKeys(clientMember)).toEqual([shared.key]);
    expect(clientMember?.currentTaskKeys).toEqual([shared.key]);
    expect(JSON.stringify(clientBoard)).not.toContain(internal.key);

    const clientList = (await get('members', login)) as MemberView[];
    const clientListed = clientList.find((m) => m.handle === member.handle);
    expect(workKeys(clientListed)).toEqual([shared.key]);
    expect(clientListed?.currentTaskKeys).toEqual([shared.key]);
    const ownerList = (await get('members', cookie)) as MemberView[];
    expect(workKeys(ownerList.find((m) => m.handle === member.handle))).toHaveLength(2);

    const clientProfile = JSON.stringify(await get(`members/${member.handle}/profile`, login));
    expect(clientProfile).not.toContain(internal.key);
    expect(clientProfile).toContain(shared.key);
  });

  it('uses the runner’s per-provider plan usage for snapshots and fetched events', async () => {
    const module = h.runnerModule.createWithBroker(h.runnerModule.broker());
    const values = { claude: planUsage(12), codex: planUsage(34), nanogpt: null };
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
    refreshUsage();
    await vi.waitFor(() => expect(calls).toContain('codex'));
    const board = BoardView.parse((await inject(h.app, 'GET', '/api/projects/AR/board', cookie)).json());
    expect(board.planUsage).toEqual(values.claude);
    expect(board.planUsageByProvider).toEqual(values);
    expect([...new Set(calls)].sort()).toEqual(['claude', 'codex']);
    expect(events.filter((e) => e.type === 'plan_usage')).toEqual(
      expect.arrayContaining([
        { type: 'plan_usage', projectKey: 'AR', provider: 'claude', usage: values.claude },
        { type: 'plan_usage', projectKey: 'AR', provider: 'codex', usage: values.codex },
      ]),
    );
    values.codex = planUsage(45);
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
});
