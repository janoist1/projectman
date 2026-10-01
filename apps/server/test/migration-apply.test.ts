import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { routes } from '@projectman/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyPackage, applyPendingWork, readPendingWork } from '../../../scripts/migrate/apply';
import { activateHome, retireHome } from '../../../scripts/migrate/instance';
import { MigrationRefused, createPackage } from '../../../scripts/migrate/package';
import { parsePathMapping } from '../../../scripts/migrate/paths';
import { verifyHome } from '../../../scripts/migrate/verify';
import { buildApp } from '../src/app';
import { instanceRole } from '../src/instance';
import { createTranscriptReader } from '../src/runner/transcript/reader';
import { createFakeMcp, createFakeRunnerModule, FakeGithub } from './helpers/fakes';
import { createSourceHome, git, OWNER_LOGIN } from './helpers/migration-source';
import type { SourceHome } from './helpers/migration-source';

/**
 * The move onto the new machine (PM-143): a package becomes a standby copy with translated paths,
 * the repositories come from their bundles, the old machine's uncommitted work waits as pending, and
 * only one copy is ever active.
 */

// Each test builds a real home, repositories and a package: slow when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let src: SourceHome;
let pkg: string;
let target: string;
let vmRepo: string;
const apps: FastifyInstance[] = [];

beforeEach(async () => {
  src = await createSourceHome();
  await src.stop();
  pkg = join(src.root, 'pkg');
  target = join(src.root, 'vm', 'data');
  vmRepo = join(src.root, 'vm', 'repos', 'AR');
  await createPackage({ home: src.home, out: pkg });
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  await src.cleanup();
});

const mapping = () => [parsePathMapping(`${src.workspace}=${vmRepo}`)];
const start = async (home: string) => {
  const runner = createFakeRunnerModule();
  const app = await buildApp({
    home,
    logger: false,
    modules: {
      createRunnerModule: (opts) => runner.create(opts),
      createMcpModule: (opts) => createFakeMcp().create(opts),
      github: new FakeGithub(),
    },
  });
  apps.push(app);
  await app.ready();
  return app;
};
const dbRows = <T>(home: string, sql: string): T[] => {
  const db = new Database(join(home, 'db.sqlite'), { readonly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
};

describe('applying a package', () => {
  it('makes a standby copy: paths translated, repositories placed, nothing started', async () => {
    const report = await applyPackage({ packageDir: pkg, targetHome: target, mappings: mapping() });

    expect(statSync(target).mode & 0o777).toBe(0o700);
    expect(statSync(join(target, 'secret')).mode & 0o777).toBe(0o600);
    expect(instanceRole(target)).toBe('standby');
    expect(report.schema.target).toBe(report.schema.source);

    // The configuration names the new workspace, and the change is a commit of the copy's history.
    expect(report.configRewrites).toEqual([{ project: 'AR', from: src.workspace, to: vmRepo }]);
    expect(readFileSync(join(target, 'customization', 'projects', 'AR', 'project.yaml'), 'utf8')).toContain(
      vmRepo,
    );
    expect(git(join(target, 'customization'), 'log', '-1', '--format=%s')).toContain('workspace paths');
    expect(git(join(target, 'customization'), 'status', '--porcelain')).toBe('');

    // The database: the stored paths follow the mapping; the old home maps onto the new one.
    const sessions = dbRows<{ id: string; cwd: string; transcript_path: string | null }>(
      target,
      'SELECT id, cwd, transcript_path FROM sessions ORDER BY id',
    );
    expect(sessions.find((s) => s.id === 'ses_codex')!.cwd).toBe(vmRepo);
    expect(sessions.find((s) => s.id === 'ses_claude')!.cwd).toBe(join(target, 'worktrees', 'AR', 'AR-1'));
    expect(dbRows<{ path: string }>(target, 'SELECT path FROM member_workspaces')[0]!.path).toBe(
      join(target, 'workspaces', 'AR', 'dev-1', 'web'),
    );
    expect(
      dbRows<{ source_path: string }>(target, 'SELECT source_path FROM task_workspace_bindings')[0]!
        .source_path,
    ).toBe(vmRepo);

    // Conversations stay as history: their transcripts are carried and the rows point at the copies.
    const claude = sessions.find((s) => s.id === 'ses_claude')!;
    expect(claude.transcript_path).toBe(join(target, 'migrated', 'transcripts', 'ses_claude', 'abc.jsonl'));
    expect(readFileSync(claude.transcript_path!, 'utf8')).toContain('Opening prompt');
    expect(report.transcriptsCarried).toBe(2);
    expect(report.sessionsNotResumed).toBe(3);
    expect(report.findings.map((f) => f.code)).toContain('transcripts_not_carried');

    // The repository is rebuilt from its bundle: every branch (also the one never pushed), at the old branch.
    expect(report.reposRestored).toEqual([
      expect.objectContaining({ project: 'AR', name: 'web', path: vmRepo }),
    ]);
    expect(git(vmRepo, 'branch', '--format=%(refname:short)').trim().split('\n').sort()).toEqual([
      'feature/local-only',
      'main',
      'task/ar-1',
    ]);
    expect(git(vmRepo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    expect(git(vmRepo, 'status', '--porcelain')).toBe('');
    expect(git(vmRepo, 'show', 'feature/local-only:local.txt')).toContain('only on this machine');
    expect(git(vmRepo, 'remote', 'get-url', 'origin').trim()).toBe(src.remote);
    expect(git(vmRepo, 'rev-parse', 'refs/remotes/origin/main')).toBe(
      git(src.workspace, 'rev-parse', 'refs/remotes/origin/main'),
    );

    // What must not move did not: no old worktree, no publishing identity.
    expect(existsSync(join(target, 'worktrees', 'AR'))).toBe(false);
    expect(existsSync(join(target, 'github-publish'))).toBe(false);

    // The old machine's uncommitted work is pending, assigned to the member where it is known.
    expect(report.pendingWork).toBe(2);
    expect(
      readPendingWork(target)
        .map((w) => [w.kind, w.state, w.assignedTo?.member ?? null, w.mappedPath === null])
        .sort(),
    ).toEqual([
      ['checkout', 'pending', null, false],
      ['worktree', 'pending', 'dev-1', false],
    ]);

    const verified = await verifyHome({ home: target, checkPaths: true });
    expect(verified.findings.filter((f) => f.severity === 'blocker')).toEqual([]);
    expect(verified.ok).toBe(true);
  });

  it('never overwrites a home, never fills an existing repository and says what no mapping covers', async () => {
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'something'), 'x');
    await expect(applyPackage({ packageDir: pkg, targetHome: target, mappings: mapping() })).rejects.toThrow(
      /not empty/,
    );
    rmSync(target, { recursive: true });

    // An existing, non-empty repository is left alone; an unmapped repository is not placed.
    mkdirSync(vmRepo, { recursive: true });
    writeFileSync(join(vmRepo, 'precious.txt'), 'mine');
    const report = await applyPackage({ packageDir: pkg, targetHome: target, mappings: mapping() });
    expect(report.reposRestored).toEqual([]);
    expect(report.reposSkipped).toEqual([
      expect.objectContaining({ reason: expect.stringContaining('not empty') }),
    ]);
    expect(readFileSync(join(vmRepo, 'precious.txt'), 'utf8')).toBe('mine');
    expect(report.findings.map((f) => f.code)).toContain('repo_not_placed');

    rmSync(target, { recursive: true });
    const unmapped = await applyPackage({ packageDir: pkg, targetHome: target, mappings: [] });
    expect(unmapped.configRewrites).toEqual([]);
    expect(unmapped.reposSkipped[0]!.reason).toMatch(/no path mapping/);
    expect(unmapped.findings).toContainEqual(expect.objectContaining({ code: 'unmapped_path' }));
    // The old paths are kept as they were (history of the old machine), never guessed.
    expect(readFileSync(join(target, 'customization', 'projects', 'AR', 'project.yaml'), 'utf8')).toContain(
      src.workspace,
    );
    // Where the old path does not exist on this machine, verify refuses the copy.
    rmSync(src.workspace, { recursive: true, force: true });
    const verified = await verifyHome({ home: target, checkPaths: true });
    expect(verified.ok).toBe(false);
    expect(verified.findings.map((f) => f.code)).toEqual(
      expect.arrayContaining(['workspace_missing', 'repo_missing']),
    );
  });

  it('refuses a damaged package before it writes anything', async () => {
    writeFileSync(join(pkg, 'home', 'memory', 'AR', 'dev-1.md'), 'changed');
    await expect(applyPackage({ packageDir: pkg, targetHome: target, mappings: mapping() })).rejects.toThrow(
      MigrationRefused,
    );
    expect(existsSync(target)).toBe(false);
  });

  it('carries a registered submodule of the customization repository (the documents of a project) whole', async () => {
    // PM-148: documents live in their own repository, registered in the customization repository.
    const documents = join(src.root, 'documents-AR');
    mkdirSync(documents);
    git(documents, 'init', '-q', '-b', 'main');
    writeFileSync(join(documents, 'plan.md'), '# Plan\n');
    git(documents, 'add', '-A');
    git(documents, 'commit', '-q', '-m', 'First document');
    const customization = join(src.home, 'customization');
    git(customization, 'submodule', 'add', '-q', documents, 'documents/AR');
    git(customization, 'commit', '-q', '-m', 'Register the documents of AR');
    const second = join(src.root, 'pkg-with-documents');
    await createPackage({ home: src.home, out: second });
    await applyPackage({ packageDir: second, targetHome: target, mappings: mapping() });
    const moved = join(target, 'customization');
    expect(readFileSync(join(moved, 'documents', 'AR', 'plan.md'), 'utf8')).toBe('# Plan\n');
    expect(git(join(moved, 'documents', 'AR'), 'log', '-1', '--format=%s').trim()).toBe('First document');
    expect(git(moved, 'submodule', 'status').trim()).toMatch(/^[0-9a-f]{40} documents\/AR/);
    const verified = await verifyHome({ home: target, checkPaths: true });
    expect(verified.findings.filter((f) => f.severity === 'blocker')).toEqual([]);
  });

  it('moves a workspace that holds several repositories, and says what lies beside them', async () => {
    // The workspace is the parent directory, the repository a folder in it (like a client project).
    const parent = join(src.root, 'Dev');
    const file = join(src.home, 'customization', 'projects', 'AR', 'project.yaml');
    const yaml = readFileSync(file, 'utf8');
    expect(yaml).toContain(`workspacePath: ${src.workspace}`);
    writeFileSync(
      file,
      yaml
        .replace(`workspacePath: ${src.workspace}`, `workspacePath: ${parent}`)
        .replace('path: .', 'path: acme'),
    );
    writeFileSync(join(parent, 'stray.txt'), 'not in a repository\n');
    const second = join(src.root, 'pkg-multi');
    const { inventory } = await createPackage({ home: src.home, out: second });
    expect(inventory.findings).toContainEqual(
      expect.objectContaining({
        code: 'workspace_extra_content',
        message: expect.stringContaining('stray.txt'),
      }),
    );
    expect(inventory.projects[0]!.repos[0]).toMatchObject({ path: src.workspace, isGit: true });

    const vmWorkspace = join(src.root, 'vm', 'workspace-AR');
    const report = await applyPackage({
      packageDir: second,
      targetHome: target,
      mappings: [parsePathMapping(`${parent}=${vmWorkspace}`)],
    });
    expect(report.configRewrites).toEqual([{ project: 'AR', from: parent, to: vmWorkspace }]);
    expect(report.reposRestored[0]).toMatchObject({ path: join(vmWorkspace, 'acme') });
    expect(
      git(join(vmWorkspace, 'acme'), 'branch', '--format=%(refname:short)').trim().split('\n').sort(),
    ).toContain('feature/local-only');
    expect(existsSync(join(vmWorkspace, 'stray.txt'))).toBe(false);
    expect((await verifyHome({ home: target, checkPaths: true })).ok).toBe(true);
  });
});

describe('pending work', () => {
  it('goes only into a clean checkout of the same commit, with a person naming where', async () => {
    await applyPackage({ packageDir: pkg, targetHome: target, mappings: mapping() });
    const item = readPendingWork(target).find((w) => w.kind === 'worktree')!;
    const other = readPendingWork(target).find((w) => w.kind === 'checkout')!;

    // Another commit, a dirty checkout and a missing id are all refused.
    const wrongPlace = join(src.root, 'vm', 'wrong');
    git(vmRepo, 'worktree', 'add', '-q', '--detach', wrongPlace, 'feature/local-only');
    await expect(applyPendingWork(target, item.id, wrongPlace)).rejects.toThrow(/check out that commit/);
    await expect(applyPendingWork(target, '999', wrongPlace)).rejects.toThrow(/no pending work/);
    const place = join(src.root, 'vm', 'place');
    git(vmRepo, 'worktree', 'add', '-q', '--detach', place, item.head!);
    writeFileSync(join(place, 'in-the-way.txt'), 'x');
    await expect(applyPendingWork(target, item.id, place)).rejects.toThrow(/not clean/);
    rmSync(join(place, 'in-the-way.txt'));

    const done = await applyPendingWork(target, item.id, place);
    expect(done).toMatchObject({ state: 'applied', appliedInto: place });
    expect(readFileSync(join(place, 'README.md'), 'utf8')).toContain('half-done change');
    expect(readFileSync(join(place, 'scratch.txt'), 'utf8')).toBe('untracked work\n');
    await expect(applyPendingWork(target, item.id, place)).rejects.toThrow(/already applied/);
    expect(readPendingWork(target).find((w) => w.id === other.id)!.state).toBe('pending');
  });
});

describe('the migrated copy as a running server', () => {
  it(
    'keeps the logins and the data, shows them as a standby, and starts no AI until it is activated',
    { timeout: 60_000 },
    async () => {
      const report = await applyPackage({ packageDir: pkg, targetHome: target, mappings: mapping() });
      expect(report.schema.target).toBeGreaterThan(0);

      const app = await start(target);
      // The cookie secret and the accounts moved: the owner logs in with the same password.
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: OWNER_LOGIN.email, password: OWNER_LOGIN.password },
      });
      expect(login.statusCode).toBe(200);
      const cookie = String(login.headers['set-cookie']).split(';')[0]!;
      const tasks = await app.inject({ url: routes.tasks('AR'), headers: { cookie } });
      expect(JSON.stringify(tasks.json())).toContain('Acme checkout');
      // The configuration loaded with the new workspace.
      expect((await app.projectman.domain.projects.config('AR')).project.workspacePath).toBe(vmRepo);
      // The attachment moved with its row.
      const attachment = (
        await app.inject({ url: routes.taskAttachments('AR', src.taskKey), headers: { cookie } })
      ).json<{ attachments: { id: string }[] }>().attachments;
      expect(attachment).toHaveLength(1);
      const content = await app.inject({
        url: routes.attachmentContent('AR', src.taskKey, attachment[0]!.id),
        headers: { cookie },
      });
      expect(content.statusCode).toBe(200);
      // The old conversation's history is still readable from its carried transcript.
      const row = app.projectman.domain.sessions.get('AR', 'ses_claude');
      const chat = await createTranscriptReader().read(row.transcriptPath!, {
        provider: 'claude',
        self: 'dev-1',
        cwd: row.cwd,
      });
      expect(JSON.stringify(chat)).toContain('Opening prompt of the old conversation');

      // As a standby it starts no AI session.
      const refused = await app.inject({
        method: 'POST',
        url: routes.startTask('AR', src.taskKey),
        headers: { cookie },
        payload: { assignee: 'dev-1' },
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ error: { code: 'instance_standby' } });
      await app.close();
      apps.length = 0;

      // Releasing it needs the other installation to be retired, and a person to say so.
      expect(() => activateHome({ home: target })).toThrow(/name the other installation/);
      expect(() => activateHome({ home: target, otherHome: src.home })).toThrow(/not retired/);
      retireHome(src.home, 'moved to the VM');
      activateHome({ home: target, otherHome: src.home });
      expect(instanceRole(target)).toBe('active');
      // The old home never starts again by mistake.
      await expect(start(src.home)).rejects.toThrow(/retired/);
      const again = await start(target);
      const started = await again.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: OWNER_LOGIN.email, password: OWNER_LOGIN.password },
      });
      const cookie2 = String(started.headers['set-cookie']).split(';')[0]!;
      const session = await again.inject({
        method: 'POST',
        url: routes.startTask('AR', src.taskKey),
        headers: { cookie: cookie2 },
        payload: { assignee: 'dev-1' },
      });
      // (A sandbox that forbids pseudo-terminals makes the start itself fail, but not as a refusal.)
      expect(session.statusCode === 200 || session.json().error.code !== 'instance_standby').toBe(true);
    },
  );

  it('refuses to retire or activate a home a server still has open', { timeout: 60_000 }, async () => {
    await applyPackage({ packageDir: pkg, targetHome: target, mappings: mapping() });
    await start(target);
    expect(() => retireHome(target, 'x')).toThrow(/stop it first/);
    expect(() => activateHome({ home: target, confirmSourceRetired: true })).toThrow(/stop it first/);
  });

  it('migrates an older database to this build in the copy', async () => {
    // The package's database is rewound to schema 12 by dropping what 13 to 15 added.
    const dbFile = join(pkg, 'home', 'db.sqlite');
    const db = new Database(dbFile);
    db.exec(
      'DROP TABLE task_workspace_bindings; DROP TABLE member_workspaces; ALTER TABLE sessions DROP COLUMN execution_profile; ALTER TABLE task_links DROP COLUMN author_source;',
    );
    db.pragma('user_version = 12');
    db.close();
    // Rebuild the manifest's checksums for the edited file.
    const { sha256File } = await import('../../../scripts/migrate/package');
    const manifestPath = join(pkg, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.files['home/db.sqlite'] = { sha256: await sha256File(dbFile), bytes: statSync(dbFile).size };
    manifest.sourceSchemaVersion = 12;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const report = await applyPackage({ packageDir: pkg, targetHome: target, mappings: mapping() });
    expect(report.schema.source).toBe(12);
    expect(report.schema.target).toBeGreaterThan(12);
    expect(dbRows<{ n: number }>(target, 'SELECT count(*) AS n FROM tasks')[0]!.n).toBe(1);
  });
});
