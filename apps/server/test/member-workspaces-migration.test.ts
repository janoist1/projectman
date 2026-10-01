import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate, schemaVersion } from '../src/db';
import { migrations } from '../src/db/migrations';

describe('member workspaces migration (PM-138)', () => {
  it('adds the tables beside older sessions, which keep reading as they were, and holds one reservation', () => {
    const db = new Database(':memory:');
    try {
      // A database as the build before this migration left it, with a worktree-era session.
      for (const migration of migrations.filter((item) => item.version <= 11)) db.exec(migration.sql);
      db.pragma('user_version = 11');
      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');
        INSERT INTO tasks (id, project_key, key, seq, title, description, stage_id, status, visibility, created_by, created_at, updated_at)
        VALUES ('tsk_example', 'AR', 'AR-1', 1, 'Example task', 'An example', 'development', 'active', 'internal', 'owner', '2026-01-01', '2026-01-01');
        INSERT INTO sessions (id, project_key, member, work_item_type, work_item_ref, claude_session_id, cwd, branch, state, started_at, last_activity_at)
        VALUES ('ses_example', 'AR', 'dev-1', 'task', 'AR-1', '0b7c6a1e-8f7b-4c1e-9d55-0d8c0f4e7a11', '/home/worktrees/AR/AR-1-web', 'AR-1-example', 'exited', '2026-01-01', '2026-01-01');`);

      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      const repos = createRepositories(db);
      expect(repos.sessions.get('ses_example')).toMatchObject({
        cwd: '/home/worktrees/AR/AR-1-web',
        branch: 'AR-1-example',
        state: 'exited',
      });
      // Nothing is inferred from older sessions: no workspace, reservation or binding.
      expect(repos.memberWorkspaces.find('AR', 'dev-1', 'web')).toBeNull();
      expect(repos.memberWorkspaces.bindingsOfTask('AR', 'AR-1')).toEqual([]);

      const ws = {
        id: 'wsp_1',
        projectKey: 'AR',
        member: 'dev-1',
        repo: 'web',
        path: '/w/repo',
        generation: 1,
        createdAt: '2026-01-02',
      };
      repos.memberWorkspaces.insert(ws);
      // One workspace per project x member x repository.
      expect(() => repos.memberWorkspaces.insert({ ...ws, id: 'wsp_2' })).toThrow();
      repos.memberWorkspaces.hold('wsp_1', {
        sessionId: 'ses_example',
        taskKey: 'AR-1',
        pid: null,
        since: '2026-01-02',
      });
      repos.memberWorkspaces.setHolderPid('wsp_1', 'ses_example', 4242);
      expect(repos.memberWorkspaces.heldBy('ses_example')[0]?.holder).toEqual({
        sessionId: 'ses_example',
        taskKey: 'AR-1',
        pid: 4242,
        since: '2026-01-02',
      });
      // Another session cannot release it.
      repos.memberWorkspaces.release('wsp_1', 'ses_other');
      expect(repos.memberWorkspaces.get('wsp_1')?.holder?.sessionId).toBe('ses_example');
      repos.memberWorkspaces.release('wsp_1', 'ses_example');
      expect(repos.memberWorkspaces.get('wsp_1')?.holder).toBeNull();

      const binding = {
        projectKey: 'AR',
        taskKey: 'AR-1',
        member: 'cr',
        workspaceId: 'wsp_1',
        kind: 'review' as const,
        branch: null,
        baseCommit: 'a'.repeat(40),
        sourcePath: '/w/repo',
        sourceRef: 'refs/heads/AR-1-example',
        sourceCommit: 'b'.repeat(40),
        round: 1,
        refresh: false,
        generation: 1,
        createdAt: '2026-01-02',
        updatedAt: '2026-01-02',
      };
      repos.memberWorkspaces.saveBinding(binding);
      expect(repos.memberWorkspaces.requestReviewRound('AR', 'AR-1', 'dev-1')).toBe(0);
      expect(repos.memberWorkspaces.requestReviewRound('AR', 'AR-1')).toBe(1);
      expect(repos.memberWorkspaces.binding('AR', 'AR-1', 'cr', 'wsp_1')).toEqual({
        ...binding,
        refresh: true,
      });
      // A second run applies nothing and keeps what was stored.
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(repos.memberWorkspaces.findByPath('/w/repo')?.id).toBe('wsp_1');
    } finally {
      db.close();
    }
  });
});
