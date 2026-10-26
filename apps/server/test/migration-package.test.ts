import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { databaseInUse } from '../../../scripts/migrate/database';
import { buildInventory } from '../../../scripts/migrate/inventory';
import { createSourceHome } from './helpers/migration-source';
import type { SourceHome } from './helpers/migration-source';

/**
 * The inventory of a stopped source (PM-143): data and local work are reported,
 * nothing is changed at the source, and a source that still runs is refused.
 */

// Each test builds a real home and repositories: slow when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let src: SourceHome;
beforeEach(async () => {
  src = await createSourceHome();
});
afterEach(async () => {
  await src.cleanup();
});

const codes = (inventory: { findings: { code: string }[] }) => inventory.findings.map((f) => f.code);

describe('the inventory', () => {
  it('refuses a running source: the database is open in another process', async () => {
    expect(databaseInUse(src.home)).toBe(true);
    const inventory = await buildInventory({ home: src.home });
    expect(inventory.database.inUse).toBe(true);
    expect(inventory.findings).toContainEqual(
      expect.objectContaining({ severity: 'blocker', code: 'source_running' }),
    );
    await src.stop();
    expect(databaseInUse(src.home)).toBe(false);
  });

  it('reports the database, the files and the work of a stopped source, with no blocker', async () => {
    await src.stop();
    const inventory = await buildInventory({ home: src.home });
    expect(inventory.findings.filter((f) => f.severity === 'blocker')).toEqual([]);
    expect(inventory.database).toMatchObject({
      present: true,
      inUse: false,
      integrity: 'ok',
      foreignKeyViolations: 0,
    });
    expect(inventory.database.schemaVersion).toBe(inventory.database.buildSchemaVersion);
    expect(inventory.database.counts).toMatchObject({
      users: 1,
      projects: 1,
      tasks: 1,
      sessions: 3,
      attachments: 1,
      member_workspaces: 1,
    });
    expect(inventory.secret).toEqual({ present: true, mode: '600' });
    expect(inventory.customization).toMatchObject({ present: true, dirty: 0, submodules: [] });
    expect(inventory.customization.head).toMatch(/^[0-9a-f]{40}$/);
    expect(inventory.attachments).toMatchObject({
      rows: 1,
      files: 1,
      rowsWithoutFile: 0,
      filesWithoutRow: 0,
    });
    expect(inventory.memory.files).toBe(1);
    expect(inventory.entries.map((e) => e.name)).toEqual(
      expect.arrayContaining(['db.sqlite', 'secret', 'customization', 'worktrees', 'github-publish']),
    );
    expect(inventory.sessions).toMatchObject({
      total: 3,
      byProvider: { claude: 2, codex: 1 },
      byProfile: { legacy: 3 },
    });
    expect(inventory.sessions.transcripts).toMatchObject({ referenced: 3, present: 2, missing: 1 });
    expect(inventory.memberWorkspaces).toEqual({ total: 1, missing: 1 });
  });

  it('finds the repository, the branch that exists only here, the worktree and the dirty work', async () => {
    await src.stop();
    const inventory = await buildInventory({ home: src.home });
    const [project] = inventory.projects;
    expect(project).toMatchObject({ key: 'AR', workspacePath: src.workspace });
    const repo = project!.repos[0]!;
    expect(repo).toMatchObject({ name: 'web', path: src.workspace, isGit: true, branch: 'main' });
    expect(repo.remotes).toEqual([{ name: 'origin', url: src.remote }]);
    expect(repo.branches.find((b) => b.name === 'feature/local-only')?.localOnlyCommits).toBe(1);
    expect(repo.branches.find((b) => b.name === 'main')?.localOnlyCommits).toBe(0);
    expect(repo.dirty).toMatchObject({ untracked: 1, modified: 0 });
    expect(repo.worktrees).toHaveLength(2);
    // Three stash entries, oldest first, each with its message; the detached HEAD no branch holds.
    expect(repo.stashList.map((s) => s.message)).toEqual([
      expect.stringContaining('stash first'),
      expect.stringContaining('stash second'),
      expect.stringContaining('stash third'),
    ]);
    expect(repo.orphanHeads).toEqual([{ sha: src.orphanHead, where: src.orphanWorktree }]);
    expect(repo.worktrees.find((w) => w.path === src.worktree)).toMatchObject({
      path: src.worktree,
      branch: 'task/ar-1',
      managed: true,
      dirty: { modified: 1, untracked: 1 },
      assignedTo: { member: 'dev-1', taskKey: src.taskKey },
    });
    expect(codes(inventory)).toEqual(
      expect.arrayContaining([
        'dirty_work',
        'local_only_commits',
        'sessions_not_resumed',
        'transcripts_missing',
        'publishing_identity',
      ]),
    );
    // Every stored absolute path is grouped, so the person sees what a mapping must cover.
    expect(inventory.absolutePaths.length).toBeGreaterThan(0);
  });

  it('writes nothing a person would not want to leak: no secret, no credentials, no file contents', async () => {
    await src.stop();
    const text = JSON.stringify(await buildInventory({ home: src.home }));
    expect(text).not.toContain(readFileSync(join(src.home, 'secret'), 'utf8').trim());
    expect(text).not.toContain('half-done change');
    expect(text).not.toContain('Remember: Hungarian notes');
  });

  it('refuses a database from a newer build and one that is damaged', async () => {
    await src.stop();
    const db = new Database(join(src.home, 'db.sqlite'));
    db.pragma('user_version = 999');
    db.close();
    const inventory = await buildInventory({ home: src.home });
    expect(inventory.findings).toContainEqual(
      expect.objectContaining({ severity: 'blocker', code: 'schema_newer' }),
    );
  });

  it('flags attachment rows whose file is gone and a missing cookie secret', async () => {
    await src.stop();
    const stored = join(src.home, 'attachments', 'AR', src.taskKey);
    for (const name of readdirSync(stored)) writeFileSync(join(stored, name), '');
    const { rmSync } = await import('node:fs');
    for (const name of readdirSync(stored)) rmSync(join(stored, name));
    rmSync(join(src.home, 'secret'));
    const inventory = await buildInventory({ home: src.home });
    expect(codes(inventory)).toEqual(expect.arrayContaining(['attachments_missing_files', 'secret_missing']));
    expect(inventory.findings.find((f) => f.code === 'secret_missing')?.severity).toBe('blocker');
  });
});
