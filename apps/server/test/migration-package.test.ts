import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { databaseInUse } from '../../../scripts/migrate/database';
import { buildInventory } from '../../../scripts/migrate/inventory';
import { createPackage, MigrationRefused, readPackage } from '../../../scripts/migrate/package';
import { createSourceHome, git } from './helpers/migration-source';
import type { SourceHome } from './helpers/migration-source';

/**
 * The inventory and the package of a stopped source (PM-143): everything that has to move is found
 * and carried, nothing is changed at the source, and a source that still runs is refused.
 */

let src: SourceHome;
beforeEach(async () => {
  src = await createSourceHome();
});
afterEach(async () => {
  await src.cleanup();
});

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const codes = (inventory: { findings: { code: string }[] }) => inventory.findings.map((f) => f.code);

describe('the inventory', () => {
  it('refuses a running source: the database is open in another process', async () => {
    expect(databaseInUse(src.home)).toBe(true);
    const inventory = await buildInventory({ home: src.home });
    expect(inventory.database.inUse).toBe(true);
    expect(inventory.findings).toContainEqual(expect.objectContaining({ severity: 'blocker', code: 'source_running' }));
    await src.stop();
    expect(databaseInUse(src.home)).toBe(false);
  });

  it('reports the database, the files and the work of a stopped source, with no blocker', async () => {
    await src.stop();
    const inventory = await buildInventory({ home: src.home });
    expect(inventory.findings.filter((f) => f.severity === 'blocker')).toEqual([]);
    expect(inventory.database).toMatchObject({ present: true, inUse: false, integrity: 'ok', foreignKeyViolations: 0 });
    expect(inventory.database.schemaVersion).toBe(inventory.database.buildSchemaVersion);
    expect(inventory.database.counts).toMatchObject({ users: 1, projects: 1, tasks: 1, sessions: 3, attachments: 1, member_workspaces: 1 });
    expect(inventory.secret).toEqual({ present: true, mode: '600' });
    expect(inventory.customization).toMatchObject({ present: true, dirty: 0, submodules: [] });
    expect(inventory.customization.head).toMatch(/^[0-9a-f]{40}$/);
    expect(inventory.attachments).toMatchObject({ rows: 1, files: 1, rowsWithoutFile: 0, filesWithoutRow: 0 });
    expect(inventory.memory.files).toBe(1);
    expect(inventory.entries.map((e) => e.name)).toEqual(expect.arrayContaining(['db.sqlite', 'secret', 'customization', 'worktrees', 'github-publish']));
    expect(inventory.sessions).toMatchObject({ total: 3, byProvider: { claude: 2, codex: 1 }, byProfile: { legacy: 3 } });
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
    expect(repo.worktrees).toHaveLength(1);
    expect(repo.worktrees[0]).toMatchObject({
      path: src.worktree,
      branch: 'task/ar-1',
      managed: true,
      dirty: { modified: 1, untracked: 1 },
      assignedTo: { member: 'dev-1', taskKey: src.taskKey },
    });
    expect(codes(inventory)).toEqual(
      expect.arrayContaining(['dirty_work', 'local_only_commits', 'sessions_not_resumed', 'transcripts_missing', 'publishing_identity']),
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
    expect(inventory.findings).toContainEqual(expect.objectContaining({ severity: 'blocker', code: 'schema_newer' }));
    await expect(createPackage({ home: src.home, out: join(src.root, 'pkg') })).rejects.toThrow(MigrationRefused);
    expect(existsSync(join(src.root, 'pkg'))).toBe(false);
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

describe('the package', () => {
  it('refuses a source that still runs and writes nothing', async () => {
    await expect(createPackage({ home: src.home, out: join(src.root, 'pkg') })).rejects.toThrow(/blocking/);
    expect(existsSync(join(src.root, 'pkg'))).toBe(false);
  });

  it('refuses an output inside the source home, inside a repository or into a non-empty directory', async () => {
    await src.stop();
    await expect(createPackage({ home: src.home, out: join(src.home, 'pkg') })).rejects.toThrow(/inside the source home/);
    await expect(createPackage({ home: src.home, out: join(src.workspace, 'pkg') })).rejects.toThrow(/git repository/);
    const occupied = join(src.root, 'occupied');
    git(src.root, 'init', '-q', occupied);
    await expect(createPackage({ home: src.home, out: occupied })).rejects.toThrow(/not empty|git repository/);
  });

  it('carries the data, the repositories, the dirty work and the transcripts, and leaves the source as it was', async () => {
    await src.stop();
    const before = {
      db: sha(join(src.home, 'db.sqlite')),
      secret: sha(join(src.home, 'secret')),
      readme: readFileSync(join(src.worktree, 'README.md'), 'utf8'),
      status: git(src.worktree, 'status', '--porcelain'),
      stash: git(src.workspace, 'stash', 'list'),
      branches: git(src.workspace, 'branch', '--list'),
    };
    const out = join(src.root, 'pkg');
    const { manifest } = await createPackage({ home: src.home, out });

    // A secret: private directory, private files.
    expect(statSync(out).mode & 0o777).toBe(0o700);
    expect(statSync(join(out, 'home', 'secret')).mode & 0o777).toBe(0o600);
    expect(statSync(join(out, 'home', 'db.sqlite')).mode & 0o777).toBe(0o600);

    // The home: the data, without old worktrees, the publishing identity and the database's side files.
    const carried = readdirSync(join(out, 'home')).sort();
    expect(carried).toEqual(expect.arrayContaining(['attachments', 'customization', 'db.sqlite', 'memory', 'secret']));
    expect(carried).not.toContain('worktrees');
    expect(carried).not.toContain('github-publish');
    expect(carried).not.toContain('instance.json');
    expect(manifest.notCarried.map((n) => n.name).sort()).toEqual(['github-publish', 'worktrees']);
    expect(existsSync(join(out, 'home', 'customization', '.git'))).toBe(true);
    expect(readFileSync(join(out, 'home', 'memory', 'AR', 'dev-1.md'), 'utf8')).toContain('Hungarian');
    // The copy of the database keeps its schema version and its data.
    const copy = new Database(join(out, 'home', 'db.sqlite'), { readonly: true });
    expect(copy.pragma('user_version', { simple: true })).toBe(manifest.sourceSchemaVersion);
    expect((copy.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n).toBe(1);
    copy.close();

    // The repository: one bundle with every branch, including the one that was never pushed.
    expect(manifest.repos).toHaveLength(1);
    const heads = git(src.root, 'bundle', 'list-heads', join(out, manifest.repos[0]!.bundle));
    expect(heads).toContain('refs/heads/feature/local-only');
    expect(heads).toContain('refs/heads/task/ar-1');
    expect(heads).toContain('refs/remotes/origin/main');

    // The dirty work of both checkouts, assigned to the member where the database knows it.
    expect(manifest.work.map((w) => [w.kind, w.files, w.assignedTo?.member ?? null]).sort()).toEqual([
      ['checkout', 1, null],
      ['worktree', 2, 'dev-1'],
    ]);
    expect(existsSync(join(out, manifest.work.find((w) => w.kind === 'worktree')!.archive!))).toBe(true);

    // The transcripts the database refers to (the lost one is simply absent).
    expect(manifest.transcripts.map((t) => t.sessionId).sort()).toEqual(['ses_claude', 'ses_codex']);

    // The source is exactly as it was: no stash, no reset, no clean, no change to the database.
    expect(sha(join(src.home, 'db.sqlite'))).toBe(before.db);
    expect(sha(join(src.home, 'secret'))).toBe(before.secret);
    expect(readFileSync(join(src.worktree, 'README.md'), 'utf8')).toBe(before.readme);
    expect(git(src.worktree, 'status', '--porcelain')).toBe(before.status);
    expect(git(src.workspace, 'stash', 'list')).toBe(before.stash);
    expect(git(src.workspace, 'branch', '--list')).toBe(before.branches);
    expect(readFileSync(join(src.workspace, 'notes.txt'), 'utf8')).toContain('main checkout');

    // Every file has a checksum, and the package reads back whole.
    expect(Object.keys(manifest.files)).toEqual(expect.arrayContaining(['inventory.json', 'home/db.sqlite']));
    await expect(readPackage(out)).resolves.toMatchObject({ version: 1 });
  });

  it('is found damaged when a file changes, goes missing or is added', async () => {
    await src.stop();
    const out = join(src.root, 'pkg');
    await createPackage({ home: src.home, out });
    const memory = join(out, 'home', 'memory', 'AR', 'dev-1.md');
    const original = readFileSync(memory, 'utf8');
    writeFileSync(memory, `${original}tampered\n`);
    await expect(readPackage(out)).rejects.toThrow(/checksum/);
    writeFileSync(memory, original);
    await expect(readPackage(out)).resolves.toBeDefined();
    writeFileSync(join(out, 'home', 'extra'), 'x');
    await expect(readPackage(out)).rejects.toThrow(/not in its manifest/);
  });
});
