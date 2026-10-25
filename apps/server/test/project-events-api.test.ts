import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ProjectChangeEventsResponse,
  decodeProjectEventCursor,
  encodeProjectEventCursor,
  routes,
} from '@projectman/shared';
import type { ProjectChangeEvent } from '@projectman/shared';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

const AT = '2026-10-17T10:00:00.000Z';
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('project change events API (PM-761)', () => {
  let h: AppHarness;
  let cookie: string;
  let now: Date;
  beforeEach(async () => {
    now = new Date(AT);
    h = await createAppHarness({ now: () => now });
    cookie = await setupOwner(h.app);
    await createProject(h, cookie);
  });
  afterEach(async () => h.close());

  const events = (query = '', auth: { cookie?: string; bearer?: string } = { cookie }, project = 'AR') =>
    h.app.inject({
      method: 'GET',
      url: `${routes.projectEvents(project)}${query ? `?${query}` : ''}`,
      headers: auth.bearer ? { authorization: `Bearer ${auth.bearer}` } : { cookie: auth.cookie ?? '' },
    });
  const page = async (query = '', auth?: { cookie?: string; bearer?: string }, project = 'AR') => {
    const response = await events(query, auth, project);
    expect(response.statusCode, response.body).toBe(200);
    return ProjectChangeEventsResponse.parse(response.json());
  };
  const createTask = async (title: string, project = 'AR') => {
    const response = await inject(h.app, 'POST', routes.tasks(project), cookie, { title });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().key as string;
  };
  const legacyKey = async (expiresInDays?: number) => {
    const response = await inject(h.app, 'POST', routes.integratorKey(), cookie, {
      ...(expiresInDays === undefined ? {} : { expiresInDays }),
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().secret as string;
  };
  const appendMany = (count: number, project = 'AR') => {
    const { repos } = h.app.projectman;
    repos.transaction(() => {
      for (let i = 0; i < count; i += 1)
        repos.projectChanges.append(project, 'task', `${project}-bulk-${i}`, AT);
    });
  };

  it('refuses a reader without a login', async () => {
    const response = await h.app.inject({ method: 'GET', url: `${routes.projectEvents('AR')}?waitMs=0` });
    expect(response.statusCode).toBe(401);
  });

  it('starts at the beginning of the journal, and carries what committed with its entity only', async () => {
    const key = await createTask('First card');
    const first = await page('waitMs=0');
    expect(first.events.length).toBeGreaterThan(0);
    const task = first.events.filter((event) => event.kind === 'task' && event.entityId === key);
    expect(task.length).toBeGreaterThan(0);
    for (const event of first.events) {
      expect(Object.keys(event).sort()).toEqual(['at', 'cursor', 'entityId', 'kind', 'projectKey']);
      expect(event.projectKey).toBe('AR');
    }
    expect(first.nextCursor).toBe(first.events.at(-1)!.cursor);
    // Nothing is new after the last cursor, and the answer keeps the position.
    const none = await page(`after=${first.nextCursor}&waitMs=0`);
    expect(none).toEqual({ events: [], nextCursor: first.nextCursor });
    expect(JSON.stringify(first)).not.toContain('First card');
  });

  it('pages above the limit of one page without a gap or a repeat', async () => {
    const start = await page('waitMs=0&limit=500');
    appendMany(1200);
    const seen: ProjectChangeEvent[] = [];
    let cursor = start.nextCursor;
    for (let guard = 0; guard < 10; guard += 1) {
      const next = await page(`after=${cursor}&waitMs=0&limit=500`);
      if (next.events.length === 0) break;
      expect(next.events.length).toBeLessThanOrEqual(500);
      seen.push(...next.events);
      cursor = next.nextCursor;
    }
    expect(seen).toHaveLength(1200);
    expect(seen.map((event) => event.entityId)).toEqual(
      Array.from({ length: 1200 }, (_, i) => `AR-bulk-${i}`),
    );
    const seqs = seen.map((event) => decodeProjectEventCursor(event.cursor)!.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(1200);
    // A smaller page continues from where the cursor says.
    const small = await page(`after=${seen[9]!.cursor}&waitMs=0&limit=3`);
    expect(small.events.map((event) => event.entityId)).toEqual(['AR-bulk-10', 'AR-bulk-11', 'AR-bulk-12']);
  });

  it('keeps the projects apart', async () => {
    const before = (await page('waitMs=0')).events.length;
    const { repos, domain } = h.app.projectman;
    repos.projects.insert({
      key: 'BR',
      name: 'other',
      templateId: null,
      configVersion: 'v1',
      createdAt: AT,
      updatedAt: AT,
    });
    appendMany(2, 'BR');
    expect((await page('waitMs=0')).events).toHaveLength(before);
    const other = domain.changes.read('BR', undefined, 100);
    expect(other.events.filter((event) => event.entityId?.startsWith('BR-bulk'))).toHaveLength(2);
    for (const event of other.events) expect(event.projectKey).toBe('BR');
    // A cursor is for the project that issued it.
    const wrong = await events(`after=${other.nextCursor}&waitMs=0`);
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('invalid_event_cursor');
  });

  it('refuses a cursor that is malformed, foreign, from another journal, or ahead of this one', async () => {
    const good = await page('waitMs=0');
    const decoded = decodeProjectEventCursor(good.nextCursor)!;
    const bad = async (after: string, status: number, code: string) => {
      const response = await events(`after=${encodeURIComponent(after)}&waitMs=0`);
      expect(response.statusCode, after).toBe(status);
      expect(response.json().error.code, after).toBe(code);
    };
    await bad('not a cursor', 400, 'invalid_event_cursor');
    await bad(Buffer.from('{"version":1}').toString('base64url'), 400, 'invalid_event_cursor');
    const raw = (seq: string) =>
      Buffer.from(
        JSON.stringify({ version: 1, generation: decoded.generation, projectKey: 'AR', seq }),
      ).toString('base64url');
    for (const seq of ['1e3', '-1', '01', '99999999999999999999', '9007199254740992', ' 1'])
      await bad(raw(seq), 400, 'invalid_event_cursor');
    await bad(encodeProjectEventCursor({ ...decoded, projectKey: 'BR' }), 400, 'invalid_event_cursor');
    await bad(encodeProjectEventCursor({ ...decoded, generation: 'deadbeef' }), 409, 'event_cursor_expired');
    // A position past the end belongs to a journal that was restored to an earlier state.
    await bad(encodeProjectEventCursor({ ...decoded, seq: decoded.seq + 1000 }), 409, 'event_cursor_expired');
    for (const query of ['limit=0', 'limit=501', 'waitMs=-1', 'waitMs=25001', 'limit=x']) {
      const response = await events(query);
      expect(response.statusCode, query).toBe(400);
    }
  });

  it('announces a configuration version once: the recovery that finds it already there stays quiet', async () => {
    const { repos, domain } = h.app.projectman;
    const configuration = () =>
      domain.changes.read('AR', undefined, 500).events.filter((event) => event.kind === 'configuration');
    // The record is behind git, as after a crash between the commit and the record.
    repos.projects.update('AR', { name: 'Stale', configVersion: 'stale', updatedAt: AT });
    const before = configuration().length;
    await domain.projects.syncFromStore();
    expect(configuration()).toHaveLength(before + 1);
    await domain.projects.syncFromStore();
    expect(configuration()).toHaveLength(before + 1);
    expect(configuration().at(-1)!.entityId).toBeNull();
  });

  it('writes the journal for a change that no facade announces on the bus', async () => {
    const { repos, domain } = h.app.projectman;
    const before = domain.changes.read('AR', undefined, 500).events.length;
    // A repository write with no facade and no bus event in front of it.
    repos.timeline.insert({
      id: 'tl-direct',
      projectKey: 'AR',
      taskKey: null,
      sessionId: null,
      actor: { kind: 'system', handle: null },
      type: 'config_changed',
      data: { version: 'v9', message: 'direct' },
      createdAt: AT,
    });
    const after = domain.changes.read('AR', undefined, 500).events;
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)!.kind).toBe('timeline');
  });

  it('lets every member read, clients included (PM-79)', async () => {
    const client = await addHumanAndLogin(h.app, { handle: 'cli', access: 'client' });
    const developer = await addHumanAndLogin(h.app, { handle: 'dev1', access: 'developer' });
    expect((await events('waitMs=0', { cookie: client })).statusCode).toBe(200);
    expect((await events('waitMs=0', { cookie: developer })).statusCode).toBe(200);
  });

  it('wakes a waiting reader when a change commits, and the entry is the one that committed', async () => {
    const start = await page('waitMs=0');
    const waiting = events(`after=${start.nextCursor}&waitMs=10000`);
    await sleep(100);
    const key = await createTask('Wakes the reader');
    const response = await waiting;
    expect(response.statusCode, response.body).toBe(200);
    const body = ProjectChangeEventsResponse.parse(response.json());
    expect(body.events.some((event) => event.kind === 'task' && event.entityId === key)).toBe(true);
    // Whatever the reader got, the next read from its cursor continues without a repeat.
    const next = await page(`after=${body.nextCursor}&waitMs=0&limit=500`);
    for (const event of next.events) expect(body.events.map((e) => e.cursor)).not.toContain(event.cursor);
  });

  it('returns an empty page at the end of the wait', async () => {
    const start = await page('waitMs=0');
    const started = Date.now();
    const body = await page(`after=${start.nextCursor}&waitMs=300`);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(body).toEqual({ events: [], nextCursor: start.nextCursor });
  });

  it('continues from the same cursor after a restart of the server', async () => {
    await createTask('Before');
    const before = await page('waitMs=0');
    const key = await createTask('While it was away');
    const app = await h.relaunch({});
    const response = await app.inject({
      method: 'GET',
      url: `${routes.projectEvents('AR')}?after=${before.nextCursor}&waitMs=0`,
      headers: { cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = ProjectChangeEventsResponse.parse(response.json());
    expect(body.events.some((event) => event.kind === 'task' && event.entityId === key)).toBe(true);
    expect(decodeProjectEventCursor(body.nextCursor)!.generation).toBe(
      decodeProjectEventCursor(before.nextCursor)!.generation,
    );
  });

  it('answers 401 to a reader whose key is revoked during the wait', async () => {
    const secret = await legacyKey();
    const start = await page('waitMs=0', { bearer: secret });
    const waiting = events(`after=${start.nextCursor}&waitMs=10000`, { bearer: secret });
    await sleep(100);
    const revoked = await inject(h.app, 'DELETE', routes.integratorKey(), cookie);
    expect(revoked.statusCode, revoked.body).toBeLessThan(300);
    const started = Date.now();
    const response = await waiting;
    expect(response.statusCode, response.body).toBe(401);
    expect(response.json().error.code).toBe('integrator_key_invalid');
    expect(Date.now() - started).toBeLessThan(5000);
    // A revoked key reads nothing, with or without a wait.
    expect((await events('waitMs=0', { bearer: secret })).statusCode).toBe(401);
  });

  it('answers 401 to a reader whose key expires during the wait', async () => {
    const secret = await legacyKey(30);
    const start = await page('waitMs=0', { bearer: secret });
    const waiting = events(`after=${start.nextCursor}&waitMs=10000`, { bearer: secret });
    await sleep(100);
    now = new Date(now.getTime() + 31 * 24 * 3600 * 1000);
    const response = await waiting;
    expect(response.statusCode, response.body).toBe(401);
    expect(response.json().error.code).toBe('integrator_key_invalid');
  });

  it('answers a reader who lost access during the wait with the refusal, not the entries', async () => {
    const member = await addHumanAndLogin(h.app, { handle: 'dev1', access: 'developer' });
    const start = await page('waitMs=0', { cookie: member });
    const waiting = events(`after=${start.nextCursor}&waitMs=10000`, { cookie: member });
    await sleep(100);
    const removed = await inject(h.app, 'DELETE', routes.removeHuman('AR', 'dev1'), cookie);
    expect(removed.statusCode, removed.body).toBe(204);
    const response = await waiting;
    expect([401, 403, 404]).toContain(response.statusCode);
    expect(response.body).not.toContain('"events"');
  });

  it('does not hold the shutdown up with a waiting reader', async () => {
    const start = await page('waitMs=0');
    const waiting = events(`after=${start.nextCursor}&waitMs=25000`);
    await sleep(100);
    const started = Date.now();
    await h.app.close();
    const response = await waiting.catch(() => null);
    expect(Date.now() - started).toBeLessThan(5000);
    if (response) expect(response.statusCode).not.toBe(200);
    // `afterEach` closes the harness; a second close of an already closed app is harmless.
  });
});
