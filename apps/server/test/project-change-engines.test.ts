import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus } from '../src/core/base';
import { createRepositories, migrate } from '../src/db';
import type { Repositories } from '../src/db';
import { EngineRegistry } from '../src/runtime/sessions';
import type { EngineHelloMetadata } from '../src/runtime/sessions';
import { capturingLogger } from './helpers/fakes';

const AT = '2026-10-17T10:00:00.000Z';

describe('engine registry in the project change journal (PM-761)', () => {
  let db: Database.Database;
  let repos: Repositories;
  let registry: EngineRegistry;
  let woken: string[];
  let now: Date;
  let bus: ReturnType<typeof createEventBus>;

  const addProject = (key: string) =>
    db
      .prepare(
        `INSERT INTO projects (key, name, template_id, config_version, created_at, updated_at) VALUES (?, ?, NULL, 'v1', ?, ?)`,
      )
      .run(key, `Project ${key}`, AT, AT);
  const addSession = (project: string, engineId: string) =>
    db
      .prepare(
        `INSERT INTO sessions (id, project_key, member, work_item_type, work_item_ref, claude_session_id, cwd, state, state_since,
           started_at, last_activity_at, engine_id)
         VALUES (?, ?, 'dev', 'task', ?, 'c', '/tmp', 'running', ?, ?, ?, ?)`,
      )
      .run(`s-${project}-${engineId}`, project, `${project}-1`, AT, AT, AT, engineId);
  const engineEntries = (project: string) =>
    repos.projectChanges
      .list(project, 0, 500)
      .filter((row) => row.kind === 'engine')
      .map((row) => row.entityId);

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    repos = createRepositories(db);
    now = new Date(AT);
    bus = createEventBus(capturingLogger().logger);
    registry = new EngineRegistry({
      repos,
      bus,
      version: 'test',
      now: () => now,
    });
    woken = [];
    registry.useJournalWake((key) => woken.push(key));
    repos.users.insert({ id: 'usr_t', name: 't', email: 't@example.test', passwordHash: '', createdAt: AT });
    addProject('AR');
    addProject('BR');
  });
  afterEach(() => db.close());

  it('names the default engine in every project, in the transaction of the write', () => {
    const { engine } = registry.create('Mac', 'usr_t');
    expect(engine.isDefault).toBe(true);
    expect(engineEntries('AR')).toEqual([engine.id]);
    expect(engineEntries('BR')).toEqual([engine.id]);
    expect([...woken].sort()).toEqual(['AR', 'BR']);
  });

  it('names an engine that is not the default only in the projects with a session on it', () => {
    const first = registry.create('First', 'usr_t').engine;
    const second = registry.create('Second', 'usr_t').engine;
    addSession('AR', second.id);
    woken.length = 0;
    registry.seen(second.id, '10.0.0.1', {
      hostname: 'host',
      platform: 'darwin',
      version: 'test',
      providers: [],
    });
    // Creating the second engine reached no project (it is not the default and has no session); its first sight reaches AR.
    expect(engineEntries('AR')).toEqual([first.id, second.id]);
    expect(engineEntries('BR')).toEqual([first.id]);
    expect(woken).toEqual(['AR']);
  });

  it('reaches the projects of both engines when the default moves, and of the default that is revoked', () => {
    const first = registry.create('First', 'usr_t').engine;
    const second = registry.create('Second', 'usr_t').engine;
    addSession('BR', second.id);
    const before = (project: string) => engineEntries(project).length;
    const arBefore = before('AR');
    const brBefore = before('BR');
    registry.setDefault(second.id);
    // The old default concerned every project, the new one every project too.
    expect(before('AR') - arBefore).toBe(2);
    expect(before('BR') - brBefore).toBe(2);
    registry.revoke(second.id, 'usr_t');
    expect(before('AR') - arBefore).toBe(3);
    expect(before('BR') - brBefore).toBe(3);
    expect(engineEntries('AR').slice(arBefore)).toEqual([first.id, second.id, second.id]);
  });

  it('does not journal the online flag or a heartbeat of the last-seen time', () => {
    const hello: EngineHelloMetadata = {
      hostname: 'host',
      platform: 'darwin',
      version: 'test',
      providers: [],
    };
    const { engine } = registry.create('Mac', 'usr_t');
    registry.seen(engine.id, '10.0.0.1', hello);
    const count = engineEntries('AR').length;
    registry.setOnline(engine.id, true);
    registry.setOnline(engine.id, false);
    now = new Date(Date.parse(AT) + 5 * 60_000);
    registry.seen(engine.id, '10.0.0.1', hello);
    registry.seen(engine.id, '10.0.0.1');
    expect(engineEntries('AR')).toHaveLength(count);
    // A hello that says something new is a change.
    registry.seen(engine.id, '10.0.0.1', { ...hello, version: 'newer' });
    expect(engineEntries('AR')).toHaveLength(count + 1);
  });

  it('journals a rename and announces it, and refuses a revoked engine (PM-1077)', () => {
    const { engine } = registry.create('Mac', 'usr_t');
    const announced: string[] = [];
    bus.subscribe((event) => {
      if (event.type === 'engine_changed') announced.push(event.engine.name);
    });
    const count = engineEntries('AR').length;
    const renamed = registry.rename(engine.id, 'Studio', 'usr_t');
    expect(renamed).toMatchObject({ name: 'Studio', ownedByMe: true });
    expect(engineEntries('AR')).toHaveLength(count + 1);
    expect(announced).toEqual(['Studio']);
    registry.revoke(engine.id, 'usr_t');
    expect(() => registry.rename(engine.id, 'Late', 'usr_t')).toThrow(
      expect.objectContaining({ code: 'engine_revoked' }),
    );
  });

  it('leaves neither the engine nor the entries behind when the write fails', () => {
    registry.create('Mac', 'usr_t');
    const count = repos.projectChanges.head('AR');
    expect(() => registry.create('Other', 'usr_missing')).toThrow();
    expect(registry.list()).toHaveLength(1);
    expect(repos.projectChanges.head('AR')).toBe(count);
    expect(woken).toHaveLength(2);
  });
});
