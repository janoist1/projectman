import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate } from '../src/db';
import { migrations } from '../src/db/migrations';

const pause = {
  id: 'pau_1',
  scope: 'project' as const,
  projectKey: 'AR',
  kind: 'manual' as const,
  source: 'app' as const,
  reason: null,
  requestedBy: null,
  requestedAt: '2026-10-03T08:00:00.000Z',
  forceAfterMs: 300_000,
};

describe('pauses migration (PM-219)', () => {
  it('adds the tables to a database from before them, with one open pause per scope', () => {
    const db = new Database(':memory:');
    try {
      for (const migration of migrations.filter((item) => item.version <= 30)) db.exec(migration.sql);
      db.pragma('user_version = 30');
      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');`);
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(31);
      const { pauses } = createRepositories(db);
      expect(pauses.open()).toEqual([]);

      pauses.insert(pause);
      pauses.insert({ ...pause, id: 'pau_2', scope: 'instance', projectKey: null });
      expect(pauses.open().map((p) => p.id)).toEqual(['pau_1', 'pau_2']);
      expect(pauses.findOpen('project', 'AR')?.id).toBe('pau_1');
      expect(pauses.findOpen('instance', null)?.id).toBe('pau_2');
      expect(pauses.findOpen('project', 'OTHER')).toBeNull();
      // A scope has at most one open pause, and a project pause names its project.
      expect(() => pauses.insert({ ...pause, id: 'pau_3' })).toThrow();
      expect(() => pauses.insert({ ...pause, id: 'pau_3', projectKey: null })).toThrow();

      expect(pauses.close('pau_1', '2026-10-03T09:00:00.000Z', null)).toBe(true);
      expect(pauses.close('pau_1', '2026-10-03T09:00:00.000Z', null)).toBe(false);
      expect(pauses.get('pau_1')?.resumedAt).toBe('2026-10-03T09:00:00.000Z');
      pauses.insert({ ...pause, id: 'pau_3' });
      expect(pauses.findOpen('project', 'AR')?.id).toBe('pau_3');
    } finally {
      db.close();
    }
  });

  it('keeps one open row per session and loads it into the session', () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');`);
      const repos = createRepositories(db);
      repos.sessions.insert({
        id: 'ses_1',
        projectKey: 'AR',
        member: 'dev',
        workItem: { type: 'general' },
        claudeSessionId: '11111111-1111-4111-8111-111111111111',
        cwd: '/tmp',
        branch: null,
        transcriptPath: null,
        state: 'working',
        activity: null,
        startedAt: '2026-10-03T08:00:00.000Z',
        lastActivityAt: '2026-10-03T08:00:00.000Z',
        endedAt: null,
      });
      expect(repos.sessions.get('ses_1')?.pause).toBeUndefined();

      repos.pauses.insert(pause);
      repos.pauses.insertSession({
        sessionId: 'ses_1',
        pauseId: 'pau_1',
        projectKey: 'AR',
        since: '2026-10-03T08:00:01.000Z',
        point: null,
        tool: null,
        waitingFor: 'Bash',
        pausedAt: null,
        needsRestart: false,
      });
      expect(repos.sessions.get('ses_1')?.pause).toEqual({
        since: '2026-10-03T08:00:01.000Z',
        point: null,
        tool: null,
      });
      expect(() =>
        repos.pauses.insertSession({
          sessionId: 'ses_1',
          pauseId: 'pau_1',
          projectKey: 'AR',
          since: '2026-10-03T08:00:02.000Z',
          point: null,
          tool: null,
          waitingFor: null,
          pausedAt: null,
          needsRestart: false,
        }),
      ).toThrow();

      repos.pauses.updateSession('ses_1', {
        point: 'after_tool',
        tool: 'Bash',
        pausedAt: '2026-10-03T08:00:05.000Z',
        needsRestart: true,
      });
      expect(repos.pauses.openSession('ses_1')).toMatchObject({
        point: 'after_tool',
        tool: 'Bash',
        needsRestart: true,
      });
      expect(repos.pauses.openSessionsOfProject('AR')).toHaveLength(1);
      expect(repos.pauses.openSessionsOfProject('OTHER')).toEqual([]);

      expect(repos.pauses.closeSession('ses_1', '2026-10-03T09:00:00.000Z')).toBe(true);
      expect(repos.pauses.closeSession('ses_1', '2026-10-03T09:00:00.000Z')).toBe(false);
      expect(repos.sessions.get('ses_1')?.pause).toBeUndefined();
      expect(repos.pauses.openSessions()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
