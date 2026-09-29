import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from '@node-rs/argon2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ApiError,
  BoardView,
  ConfigView,
  InboxItem,
  InboxView,
  Me,
  MemberView,
  ProjectSummary,
  Session,
  SessionDetail,
  Task,
  TaskDetail,
  TeamMessagesView,
  TemplateSummary,
} from '@projectman/shared';
import { cookieOf, createAppHarness, createProject, OWNER_LOGIN, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { flush } from './helpers/fakes';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

describe('REST API', () => {
  let h: AppHarness;
  beforeEach(async () => {
    h = await createAppHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  async function call<T>(method: Method, url: string, cookie?: string, payload?: unknown) {
    const res = await h.app.inject({
      method,
      url,
      headers: cookie ? { cookie } : {},
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
    return { status: res.statusCode, body: (res.body ? res.json() : null) as T, res };
  }

  describe('setup, login and the guard', () => {
    it('runs the first setup once, from localhost only', async () => {
      expect((await call<{ needsSetup: boolean }>('GET', '/api/setup')).body).toEqual({ needsSetup: true });

      const remote = await h.app.inject({
        method: 'POST',
        url: '/api/setup',
        payload: OWNER_LOGIN,
        remoteAddress: '100.64.0.7',
      });
      expect(remote.statusCode).toBe(403);
      expect(remote.json<ApiError>().error.code).toBe('setup_requires_localhost');
      const proxied = await h.app.inject({
        method: 'POST',
        url: '/api/setup',
        payload: OWNER_LOGIN,
        headers: { 'x-forwarded-for': '100.64.0.7' },
      });
      expect(proxied.statusCode).toBe(403);

      const setup = await h.app.inject({ method: 'POST', url: '/api/setup', payload: OWNER_LOGIN });
      expect(setup.statusCode).toBe(201);
      expect(setup.json<Me>()).toMatchObject({ name: 'Owner', email: 'owner@example.com', handles: {} });
      const cookie = setup.headers['set-cookie'] as string;
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');

      expect((await call<{ needsSetup: boolean }>('GET', '/api/setup')).body).toEqual({ needsSetup: false });
      const again = await call<ApiError>('POST', '/api/setup', undefined, OWNER_LOGIN);
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('already_set_up');
    });

    it('guards /api with the login cookie; login and logout manage it', async () => {
      await setupOwner(h.app);
      const anonymous = await call<ApiError>('GET', '/api/projects');
      expect(anonymous.status).toBe(401);
      expect(anonymous.body).toEqual({ error: { code: 'unauthorized', message: 'login required' } });
      expect((await call('GET', '/api/projects', 'pm_session=forged.value')).status).toBe(401);
      expect((await call('GET', '/api/nope')).status).toBe(401);

      const wrong = await call<ApiError>('POST', '/api/auth/login', undefined, {
        email: OWNER_LOGIN.email,
        password: 'wrong password',
      });
      expect(wrong.status).toBe(401);
      expect(wrong.body.error.code).toBe('invalid_credentials');
      const invalid = await call<ApiError>('POST', '/api/auth/login', undefined, { email: 'x' });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error.code).toBe('invalid_request');

      const login = await call<Me>('POST', '/api/auth/login', undefined, {
        email: 'OWNER@example.com',
        password: OWNER_LOGIN.password,
      });
      expect(login.status).toBe(200);
      const cookie = cookieOf(login.res);
      expect((await call<Me>('GET', '/api/me', cookie)).body.email).toBe('owner@example.com');
      expect((await call<ApiError>('GET', '/api/nope', cookie)).body.error.code).toBe('not_found');

      expect((await call('POST', '/api/auth/logout', cookie)).status).toBe(204);
      expect((await call('GET', '/api/me', cookie)).status).toBe(401);
    });
  });

  describe('with a project', () => {
    let cookie: string;
    beforeEach(async () => {
      cookie = await setupOwner(h.app);
      await createProject(h, cookie);
    });

    it('lists templates and projects, and maps the user to a handle', async () => {
      const templates = await call<TemplateSummary[]>('GET', '/api/templates', cookie);
      expect(templates.body).toEqual([
        {
          id: 'test',
          nameKey: 'templates.test.name',
          descriptionKey: 'templates.test.description',
          memberCount: { human: 1, ai: 3 },
          stageCount: 6,
        },
      ]);
      const projects = await call<ProjectSummary[]>('GET', '/api/projects', cookie);
      expect(projects.body).toEqual([
        {
          key: 'AR',
          name: 'acme',
          templateId: 'test',
          configVersion: expect.stringMatching(/^[0-9a-f]{40}$/),
        },
      ]);
      expect((await call<Me>('GET', '/api/me', cookie)).body.handles).toEqual({ AR: 'owner' });
      expect((await call<ProjectSummary>('GET', '/api/projects/AR', cookie)).body.key).toBe('AR');
      expect((await call<ApiError>('GET', '/api/projects/ZZ', cookie)).status).toBe(404);

      const duplicate = await call<ApiError>('POST', '/api/projects', cookie, {
        key: 'AR',
        name: 'again',
        workspacePath: h.workspace,
        templateId: 'test',
      });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error.code).toBe('project_exists');
      const missing = await call<ApiError>('POST', '/api/projects', cookie, {
        key: 'BB',
        name: 'x',
        workspacePath: join(h.home, 'does-not-exist'),
        templateId: 'test',
      });
      expect(missing.body.error.code).toBe('workspace_not_found');
    });

    it('serves the board', async () => {
      const board = (await call<BoardView>('GET', '/api/projects/AR/board', cookie)).body;
      expect(board.project.key).toBe('AR');
      expect(board.columns.map((c) => [c.id, c.stageIds])).toEqual([
        ['todo', ['backlog']],
        ['doing', ['development']],
        ['review', ['code_review', 'merge', 'release']],
        ['done', ['done']],
      ]);
      expect(board.members.map((m) => [m.handle, m.status])).toEqual([
        ['owner', 'offline'],
        ['dev-1', 'idle'],
        ['dev-2', 'idle'],
        ['cr', 'idle'],
      ]);
      expect(board).toMatchObject({ tasks: [], openInboxCount: 0, planUsage: null });
    });

    it('creates, edits, gates and starts tasks', async () => {
      const created = await call<Task>('POST', '/api/projects/AR/tasks', cookie, {
        title: 'Login page',
        description: 'Email + password',
        repo: 'web',
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        key: 'AR-1',
        stageId: 'backlog',
        status: 'active',
        createdBy: 'owner',
      });

      const edited = await call<Task>('PATCH', '/api/projects/AR/tasks/AR-1', cookie, {
        title: 'Login screen',
      });
      expect(edited.body.title).toBe('Login screen');
      const blocked = await call<ApiError>('PATCH', '/api/projects/AR/tasks/AR-1', cookie, {
        stageId: 'merge',
      });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('gate_blocked');
      const badRepo = await call<ApiError>('POST', '/api/projects/AR/tasks', cookie, {
        title: 'x',
        repo: 'nope',
      });
      expect(badRepo.body.error.code).toBe('unknown_repo');

      const started = await call<TaskDetail>('POST', '/api/projects/AR/tasks/AR-1/start', cookie, {});
      expect(started.status).toBe(200);
      expect(started.body.task).toMatchObject({ assignee: 'dev-1', stageId: 'development' });
      expect(started.body.sessions).toHaveLength(1);
      const spec = h.runner.lastStarted();
      expect(spec).toMatchObject({
        displayName: 'Dev One · AR-1',
        initialMessage: 'Brief for AR-1: Login screen',
      });
      expect(spec.mcpUrl.startsWith('http://127.0.0.1:4700/mcp/')).toBe(true);
      // The MCP module got a resolver for the session's token.
      const token = spec.mcpUrl.split('/').pop()!;
      expect(h.mcp.options().resolveContext(token)).toMatchObject({ member: 'dev-1', taskKey: 'AR-1' });
      expect(h.mcp.options().resolveContext('bogus')).toBeNull();

      const detail = await call<TaskDetail>('GET', '/api/projects/AR/tasks/AR-1', cookie);
      expect(detail.body.timeline.map((e) => e.type)).toEqual(
        expect.arrayContaining([
          'task_created',
          'task_updated',
          'task_assigned',
          'task_stage_changed',
          'session_started',
        ]),
      );
      const tasks = await call<Task[]>('GET', '/api/projects/AR/tasks', cookie);
      expect(tasks.body.map((t) => t.key)).toEqual(['AR-1']);
    });

    it('shows session chat, accepts human messages and stops sessions', async () => {
      await call('POST', '/api/projects/AR/tasks', cookie, { title: 'Login page' });
      const started = await call<TaskDetail>('POST', '/api/projects/AR/tasks/AR-1/start', cookie, {});
      const sessionId = started.body.sessions[0]!.id;
      h.runner.emit({ type: 'transcript_path', sessionId, path: '/transcripts/a.jsonl' });
      h.runnerModule.transcripts.set('/transcripts/a.jsonl', [
        { id: 'u1', ts: '2026-09-29T10:00:00.000Z', kind: 'user_text', text: 'Brief' },
        { id: 'a1', ts: '2026-09-29T10:00:01.000Z', kind: 'assistant_text', text: 'On it' },
      ]);

      const detail = await call<SessionDetail>('GET', `/api/projects/AR/sessions/${sessionId}`, cookie);
      expect(detail.body.chat.map((c) => c.kind)).toEqual(['user_text', 'assistant_text']);
      expect(detail.body.task?.key).toBe('AR-1');

      const sent = await call('POST', `/api/projects/AR/sessions/${sessionId}/messages`, cookie, {
        text: 'Use Inter',
      });
      expect(sent.status).toBe(202);
      await flush();
      expect(h.runner.messages).toContainEqual({ sessionId, text: 'Use Inter' });
      const messages = await call<TeamMessagesView>('GET', '/api/projects/AR/messages?taskKey=AR-1', cookie);
      expect(messages.body.messages).toMatchObject([{ from: 'owner', to: ['dev-1'], body: 'Use Inter' }]);

      const stopped = await call<Session>('POST', `/api/projects/AR/sessions/${sessionId}/stop`, cookie);
      expect(stopped.body.state).toBe('exited');
      expect((await call('GET', '/api/projects/AR/sessions/ses_nope', cookie)).status).toBe(404);
    });

    it('answers permission requests from the inbox', async () => {
      await call('POST', '/api/projects/AR/tasks', cookie, { title: 'Login page' });
      const started = await call<TaskDetail>('POST', '/api/projects/AR/tasks/AR-1/start', cookie, {});
      const sessionId = started.body.sessions[0]!.id;

      const decision = h.runnerModule
        .broker()
        .decide(
          { sessionId, toolName: 'Bash', toolInput: { command: 'npm publish' }, raw: {} },
          new AbortController().signal,
        );
      await flush();
      const inbox = await call<InboxView>('GET', '/api/projects/AR/inbox?mine=true', cookie);
      expect(inbox.body.items).toHaveLength(1);
      const item = inbox.body.items[0]!;
      expect(item).toMatchObject({ kind: 'permission', title: 'Bash: npm publish', assignees: ['owner'] });
      expect((await call<BoardView>('GET', '/api/projects/AR/board', cookie)).body.openInboxCount).toBe(1);

      const resolved = await call<InboxItem>('POST', `/api/projects/AR/inbox/${item.id}/resolve`, cookie, {
        optionId: 'allow',
      });
      expect(resolved.body).toMatchObject({
        state: 'resolved',
        resolution: { optionId: 'allow', by: 'owner' },
      });
      expect(await decision).toEqual({ behavior: 'allow' });
      expect((await call<InboxView>('GET', '/api/projects/AR/inbox', cookie)).body.items).toEqual([]);
      expect(
        (await call<InboxView>('GET', '/api/projects/AR/inbox?state=all', cookie)).body.items,
      ).toHaveLength(1);
      const twice = await call<ApiError>('POST', `/api/projects/AR/inbox/${item.id}/resolve`, cookie, {
        optionId: 'deny',
      });
      expect(twice.body.error.code).toBe('inbox_item_closed');
    });

    it('hires and retires members through configuration commits', async () => {
      const hired = await call<MemberView>('POST', '/api/projects/AR/members', cookie, {
        role: 'qa',
        displayName: 'Tester',
      });
      expect(hired.status).toBe(201);
      expect(hired.body).toMatchObject({
        handle: 'qa',
        kind: 'ai',
        role: 'qa',
        sponsor: 'owner',
        status: 'idle',
      });
      const dev = await call<MemberView>('POST', '/api/projects/AR/members', cookie, { role: 'developer' });
      expect(dev.body.handle).toBe('dev-3');

      const retired = await h.app.inject({
        method: 'DELETE',
        url: '/api/projects/AR/members/qa',
        headers: { cookie },
      });
      expect(retired.statusCode).toBe(204);
      const members = await call<MemberView[]>('GET', '/api/projects/AR/members', cookie);
      expect(members.body.map((m) => m.handle)).not.toContain('qa');
      const human = await h.app.inject({
        method: 'DELETE',
        url: '/api/projects/AR/members/owner',
        headers: { cookie },
      });
      expect(human.json<ApiError>().error.code).toBe('not_ai_member');

      const history = (await call<ConfigView>('GET', '/api/projects/AR/config', cookie)).body.history;
      expect(history.slice(0, 3).map((e) => e.message)).toEqual([
        'Retire qa',
        'Hire developer dev-3',
        'Hire qa qa',
      ]);
      expect(history[0]!.author).toBe('Owner');
    });

    it('edits and reverts the configuration', async () => {
      const view = (await call<ConfigView>('GET', '/api/projects/AR/config', cookie)).body;
      expect(view.config.project.key).toBe('AR');
      const first = view.version;

      const changed = structuredClone(view.config);
      changed.team.limits.maxConcurrentAi = 5;
      const saved = await call<ConfigView>('PUT', '/api/projects/AR/config', cookie, {
        config: changed,
        message: 'Raise the AI limit',
        baseVersion: first,
      });
      expect(saved.status).toBe(200);
      expect(saved.body.config.team.limits.maxConcurrentAi).toBe(5);
      expect(saved.body.history[0]!.message).toBe('Raise the AI limit');

      const stale = await call<ApiError>('PUT', '/api/projects/AR/config', cookie, {
        config: changed,
        baseVersion: first,
      });
      expect(stale.body.error.code).toBe('version_conflict');

      const bare = structuredClone(saved.body.config);
      bare.team.limits.maxConcurrentAi = 4;
      expect(
        (await call<ConfigView>('PUT', '/api/projects/AR/config', cookie, bare)).body.config.team.limits
          .maxConcurrentAi,
      ).toBe(4);

      const invalidConfig = structuredClone(bare);
      invalidConfig.pipeline.stages.find((s) => s.id === 'merge')!.gate = {
        conditions: [{ type: 'human_approval', approvers: ['dev-1'] }],
      };
      const rejected = await call<ApiError>('PUT', '/api/projects/AR/config', cookie, invalidConfig);
      expect(rejected.status).toBe(422);
      expect(rejected.body.error.code).toBe('invalid_config');

      const reverted = await call<ConfigView>('POST', '/api/projects/AR/config/revert', cookie, {
        version: first,
      });
      expect(reverted.body.config.team.limits.maxConcurrentAi).toBe(3);
      expect(reverted.body.history[0]!.message).toMatch(/^Revert AR configuration to /);
    });

    it('enforces membership and access levels', async () => {
      // A second user (inviting people is a later phase; insert the account directly).
      const { repos, domain } = h.app.projectman;
      repos.users.insert({
        id: 'usr_dev',
        name: 'Dev Human',
        email: 'dev@example.com',
        passwordHash: await hash('another password'),
        createdAt: new Date().toISOString(),
      });
      const login = await call('POST', '/api/auth/login', undefined, {
        email: 'dev@example.com',
        password: 'another password',
      });
      const devCookie = cookieOf(login.res);
      expect((await call<ApiError>('GET', '/api/projects/AR/board', devCookie)).body.error.code).toBe(
        'not_a_member',
      );
      expect((await call<ProjectSummary[]>('GET', '/api/projects', devCookie)).body).toEqual([]);

      await domain.projects.update(
        'AR',
        { actor: { kind: 'human', handle: 'owner' }, author: OWNER_LOGIN },
        (draft) => {
          draft.team.members.push({
            kind: 'human',
            handle: 'dani',
            displayName: 'Dani',
            access: 'developer',
            roles: [],
            email: 'dev@example.com',
          });
          return 'Add Dani';
        },
      );
      expect((await call('GET', '/api/projects/AR/board', devCookie)).status).toBe(200);
      expect((await call('POST', '/api/projects/AR/tasks', devCookie, { title: 'From Dani' })).status).toBe(
        201,
      );
      const hire = await call<ApiError>('POST', '/api/projects/AR/members', devCookie, { role: 'qa' });
      expect(hire.status).toBe(403);
      expect(hire.body.error.code).toBe('insufficient_access');

      // As an admin Dani may hire; the AI member still runs on the owner's subscription.
      await domain.projects.update(
        'AR',
        { actor: { kind: 'human', handle: 'owner' }, author: OWNER_LOGIN },
        (draft) => {
          const dani = draft.team.members.find((m) => m.handle === 'dani');
          if (dani?.kind === 'human') dani.access = 'admin';
          return 'Make Dani an admin';
        },
      );
      const hired = await call<MemberView>('POST', '/api/projects/AR/members', devCookie, { role: 'qa' });
      expect(hired.status).toBe(201);
      expect(hired.body.sponsor).toBe('owner');

      // Admins cannot change the release approvers or who is an owner; only owners can revert.
      const config = (await call<ConfigView>('GET', '/api/projects/AR/config', devCookie)).body.config;
      const approvers = structuredClone(config);
      approvers.pipeline.stages.find((s) => s.id === 'release')!.gate = {
        conditions: [{ type: 'pr_merged' }, { type: 'human_approval', approvers: ['dani'] }],
      };
      const ownerOnly = await call<ApiError>('PUT', '/api/projects/AR/config', devCookie, approvers);
      expect(ownerOnly.status).toBe(403);
      expect(ownerOnly.body.error.code).toBe('owner_only');
      const limits = structuredClone(config);
      limits.team.limits.maxConcurrentAi = 2;
      expect((await call('PUT', '/api/projects/AR/config', devCookie, limits)).status).toBe(200);
      const revert = await call<ApiError>('POST', '/api/projects/AR/config/revert', devCookie, {
        version: 'abcdef1',
      });
      expect(revert.body.error.code).toBe('insufficient_access');
    });

    it('shows client members only what is shared with them', async () => {
      const { repos, domain } = h.app.projectman;
      repos.users.insert({
        id: 'usr_client',
        name: 'Client',
        email: 'client@example.com',
        passwordHash: await hash('client password'),
        createdAt: new Date().toISOString(),
      });
      await domain.projects.update(
        'AR',
        { actor: { kind: 'human', handle: 'owner' }, author: OWNER_LOGIN },
        (draft) => {
          draft.team.members.push({
            kind: 'human',
            handle: 'client',
            displayName: 'Client',
            access: 'client',
            roles: [],
            email: 'client@example.com',
          });
          return 'Add the client';
        },
      );
      await call('POST', '/api/projects/AR/tasks', cookie, { title: 'Internal work' });
      await call('POST', '/api/projects/AR/tasks', cookie, { title: 'Shared work', visibility: 'shared' });
      const login = await call('POST', '/api/auth/login', undefined, {
        email: 'client@example.com',
        password: 'client password',
      });
      const clientCookie = cookieOf(login.res);

      const tasks = await call<Task[]>('GET', '/api/projects/AR/tasks', clientCookie);
      expect(tasks.body.map((t) => t.title)).toEqual(['Shared work']);
      const board = await call<BoardView>('GET', '/api/projects/AR/board', clientCookie);
      expect(board.body.tasks.map((t) => t.key)).toEqual(['AR-2']);
      expect(board.body.planUsage).toBeNull();
      expect((await call('GET', '/api/projects/AR/tasks/AR-1', clientCookie)).status).toBe(404);
      const shared = await call<TaskDetail>('GET', '/api/projects/AR/tasks/AR-2', clientCookie);
      expect(shared.body.sessions).toEqual([]);
      expect(shared.body.timeline.map((e) => e.type)).toEqual(['task_created']);
      expect((await call<ApiError>('GET', '/api/projects/AR/config', clientCookie)).status).toBe(403);
      expect((await call('POST', '/api/projects/AR/tasks', clientCookie, { title: 'x' })).status).toBe(403);
    });
  });

  it('serves the web app with an SPA fallback when it is built', async () => {
    await h.close();
    const dist = mkdtempSync(join(tmpdir(), 'pm-web-'));
    try {
      writeFileSync(join(dist, 'index.html'), '<!doctype html><title>projectman</title>');
      h = await createAppHarness({ webDistDir: dist });
      const index = await h.app.inject({ method: 'GET', url: '/board/AR' });
      expect(index.statusCode).toBe(200);
      expect(index.body).toContain('<title>projectman</title>');
      expect((await h.app.inject({ method: 'GET', url: '/' })).statusCode).toBe(200);
      expect((await h.app.inject({ method: 'GET', url: '/api/unknown' })).statusCode).toBe(401);
      expect((await h.app.inject({ method: 'GET', url: '/hooks/unknown' })).statusCode).toBe(404);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });
});
