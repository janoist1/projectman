import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '@projectman/shared';
import type { EngineId, ProjectEngineView } from '@projectman/shared';
import type { EngineRegistry } from '../src/runtime/sessions';
import {
  addHumanAndLogin,
  createAppHarness,
  createProject,
  inject,
  OWNER_LOGIN,
  setupOwner,
} from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

/** The project–engine binding (PM-1060) over the whole cloud-mode app: the three endpoints, the journal and the choice. */
describe('the engines of a project', () => {
  let h: AppHarness;
  let cookie: string;
  let patCookie: string;
  let devCookie: string;
  let registry: EngineRegistry;
  let hostId: string;
  let engA: EngineId;
  let engB: EngineId;

  const put = (key: string, engine: string, who = cookie, body: unknown = {}) =>
    inject(h.app, 'PUT', routes.projectEngine(key, engine), who, body);
  const del = (key: string, engine: string, who = cookie) =>
    inject(h.app, 'DELETE', routes.projectEngine(key, engine), who);
  const list = async (key = 'AR', who = cookie) =>
    ((await inject(h.app, 'GET', routes.projectEngines(key), who)).json() as { engines: ProjectEngineView[] })
      .engines;
  const engineEntries = (project: string) =>
    h.app.projectman.repos.projectChanges.list(project, 0, 1000).filter((row) => row.kind === 'engine')
      .length;

  beforeEach(async () => {
    // A project's folder is checked on its engine, and no engine is connected here: make the projects first,
    // then start the same home as a cloud.
    h = await createAppHarness();
    cookie = await setupOwner(h.app);
    await createProject(h, cookie, 'AR');
    await createProject(h, cookie, 'BR');
    patCookie = await addHumanAndLogin(h.app, { handle: 'pat', access: 'owner' });
    devCookie = await addHumanAndLogin(h.app, { handle: 'dev1', access: 'developer' });
    h.app = await h.relaunch({ engineMode: 'cloud', appVersion: 'test', claudeTmpRoots: [] });
    registry = h.app.projectman.engineRegistry!;
    hostId = h.app.projectman.repos.users.findByEmail(OWNER_LOGIN.email)!.id;
    engA = registry.create('Mac A', hostId).engine.id;
    engB = registry.create('Mac B', hostId).engine.id;
  });
  afterEach(() => h.close());

  it('lists the fallback engine as the one default engine while nothing is bound, without host data', async () => {
    const engines = await list();
    expect(engines).toEqual([
      { id: engA, name: 'Mac A', online: false, isDefault: true, holdsProject: false, ownedByMe: true },
    ]);
    expect(await list('AR', devCookie)).toEqual([expect.objectContaining({ id: engA, ownedByMe: false })]);
  });

  it('makes the first binding the default and moves the default in one step, journaling only that project', async () => {
    const before = engineEntries('BR');
    expect((await put('AR', engA)).json()).toMatchObject({ id: engA, isDefault: true });
    expect((await put('AR', engB)).json()).toMatchObject({ id: engB, isDefault: false });
    expect((await list()).map((e) => [e.id, e.isDefault])).toEqual([
      [engA, true],
      [engB, false],
    ]);
    expect((await put('AR', engB, patCookie, { default: true })).json()).toMatchObject({
      id: engB,
      isDefault: true,
    });
    expect((await list()).map((e) => [e.id, e.isDefault])).toEqual([
      [engA, false],
      [engB, true],
    ]);
    expect(engineEntries('BR')).toBe(before);
  });

  it('sends two projects to their own engines and tells the listeners which project changed', async () => {
    const changed = vi.fn();
    registry.onProjectEngineChange(changed);
    await put('AR', engA);
    await put('BR', engB);
    expect([registry.projectEngine('AR'), registry.projectEngine('BR')]).toEqual([engA, engB]);
    expect(changed.mock.calls).toEqual([['AR'], ['BR']]);
  });

  it('chooses nothing for an unbound project whose global default belongs to someone who does not own it', async () => {
    const strangerEngine = registry.create('Dev box', 'usr_dev1').engine.id;
    registry.setDefault(strangerEngine);
    expect(registry.projectEngine('AR')).toBeNull();
    expect(await list()).toEqual([]);
    // Bound, the project does not depend on the global default.
    await put('AR', engA);
    expect(registry.projectEngine('AR')).toBe(engA);
  });

  it('does not move a project off its revoked base engine, and the owner picks a new base', async () => {
    await put('AR', engA);
    await put('AR', engB);
    registry.revoke(engA, hostId);
    expect(registry.projectEngine('AR')).toBeNull();
    expect((await put('AR', engB, patCookie, { default: true })).statusCode).toBe(200);
    expect(registry.projectEngine('AR')).toBe(engB);
  });

  it.each([
    ['a developer', 'dev', 'PUT', 'a', 403, 'insufficient_access'],
    ['a project owner who is not the engine owner', 'pat', 'PUT', 'a', 403, 'engine_not_owned'],
    ['the local engine', 'host', 'PUT', 'local', 404, 'engine_not_found'],
    ['an unknown engine', 'host', 'PUT', 'eng_zzzzzzzzzzzz', 404, 'engine_not_found'],
    ['a revoked engine', 'host', 'PUT', 'revoked', 409, 'engine_revoked'],
    ['an engine that is not bound', 'host', 'DELETE', 'a', 404, 'engine_not_found'],
    ['someone with neither side', 'dev', 'DELETE', 'a', 403, 'insufficient_access'],
  ])('refuses %s', async (_name, who, method, engine, status, code) => {
    const revoked = registry.create('Old', hostId).engine.id;
    registry.revoke(revoked, hostId);
    const id = { a: engA, revoked }[engine] ?? engine;
    if (method === 'DELETE' && who === 'dev') await put('AR', engA);
    const cookies: Record<string, string> = { host: cookie, pat: patCookie, dev: devCookie };
    const res = method === 'PUT' ? await put('AR', id, cookies[who]) : await del('AR', id, cookies[who]);
    expect([res.statusCode, res.json().error.code]).toEqual([status, code]);
  });

  it('lets a project owner who is not the engine owner make a bound engine the default', async () => {
    await put('AR', engA);
    await put('AR', engB);
    expect((await put('AR', engB, patCookie, { default: true })).statusCode).toBe(200);
  });

  it('keeps a binding while the project has a session on the engine, and the default while another stays', async () => {
    await put('AR', engA);
    await put('AR', engB);
    expect((await del('AR', engA)).json().error.code).toBe('engine_is_default');
    h.app.projectman.repos.db
      .prepare(
        `INSERT INTO sessions (id, project_key, member, work_item_type, work_item_ref, claude_session_id, cwd, state,
           state_since, started_at, last_activity_at, engine_id)
         VALUES ('s1', 'AR', 'dev', 'task', 'AR-1', 'c', '/tmp', 'idle', 'x', 'x', 'x', ?)`,
      )
      .run(engB);
    expect((await del('AR', engB)).json().error.code).toBe('engine_in_use');
  });

  it('lets the only binding go, and the project falls back to the global default', async () => {
    await put('AR', engB);
    expect((await del('AR', engB)).statusCode).toBe(204);
    expect(registry.projectEngine('AR')).toBe(engA);
    expect(engineEntries('AR')).toBeGreaterThan(0);
  });
});
