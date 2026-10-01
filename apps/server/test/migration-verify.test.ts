import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyPackage } from '../../../scripts/migrate/apply';
import { createPackage } from '../../../scripts/migrate/package';
import { parsePathMapping } from '../../../scripts/migrate/paths';
import { verifyHome } from '../../../scripts/migrate/verify';
import { createSourceHome } from './helpers/migration-source';
import type { SourceHome } from './helpers/migration-source';

/**
 * `verify` is what a restored backup and a migrated copy have to pass (PM-143), and the CLI is how a
 * person runs the whole move: these tests break one thing at a time and expect it named.
 */

// Each test builds a real home, repositories and a package: slow when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let src: SourceHome;
let home: string;
beforeEach(async () => {
  src = await createSourceHome();
  await src.stop();
  const pkg = join(src.root, 'pkg');
  home = join(src.root, 'vm', 'data');
  await createPackage({ home: src.home, out: pkg });
  await applyPackage({
    packageDir: pkg,
    targetHome: home,
    mappings: [parsePathMapping(`${src.workspace}=${src.workspace}`)],
  });
});
afterEach(async () => {
  await src.cleanup();
});

const blockers = async (checkPaths = true) =>
  (await verifyHome({ home, checkPaths })).findings
    .filter((f) => f.severity === 'blocker')
    .map((f) => f.code);

describe('verify', () => {
  it('passes a whole copy', async () => {
    const result = await verifyHome({ home, checkPaths: true });
    expect(result).toMatchObject({ ok: true, role: 'standby' });
    expect(result.schemaVersion).toBeGreaterThan(0);
  });

  it('names a missing or loose cookie secret: a start would invent one and end every login', async () => {
    chmodSync(join(home, 'secret'), 0o644);
    expect(await blockers()).toContain('secret_mode');
    rmSync(join(home, 'secret'));
    expect(await blockers()).toContain('secret_missing');
  });

  it('names a home that others can read', async () => {
    chmodSync(home, 0o755);
    expect(await blockers()).toContain('home_mode');
  });

  it('names attachment rows whose file is gone: the database and the files are not from one backup', async () => {
    const stored = join(home, 'attachments', 'AR', src.taskKey);
    for (const name of readdirSync(stored)) rmSync(join(stored, name));
    expect(await blockers()).toContain('attachments_missing_files');
  });

  it('names a damaged marker, a project that does not load and a customization repository that is no repository', async () => {
    writeFileSync(join(home, 'instance.json'), '{broken');
    expect(await blockers()).toContain('instance_marker_invalid');
    rmSync(join(home, 'instance.json'));
    const projectFile = join(home, 'customization', 'projects', 'AR', 'team.yaml');
    const original = readFileSync(projectFile, 'utf8');
    writeFileSync(projectFile, 'members: not-a-list\n');
    expect(await blockers()).toContain('project_config_invalid');
    writeFileSync(projectFile, original);
    rmSync(join(home, 'customization', '.git'), { recursive: true, force: true });
    expect(await blockers()).toContain('customization_not_git');
  });

  it('refuses a database from a newer build: an older build must never start on it', async () => {
    const db = new Database(join(home, 'db.sqlite'));
    db.pragma('user_version = 999');
    db.close();
    expect(await blockers()).toContain('schema_newer');
  });

  it('can skip the machine paths for a backup checked on another machine', async () => {
    rmSync(src.workspace, { recursive: true, force: true });
    expect(await blockers(true)).toEqual(expect.arrayContaining(['workspace_missing']));
    expect(await blockers(false)).toEqual([]);
  });
});

describe('the command line', { timeout: 60_000 }, () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const cli = join(root, 'scripts', 'migrate', 'cli.ts');
  // tsx's loader without its command: the command opens a socket for its watcher, which sandboxes refuse.
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], { encoding: 'utf8', cwd: root });

  it('reports a home, a verification and the role, with exit status 0', () => {
    const verify = run('verify', '--home', home);
    expect(verify.status, verify.stderr).toBe(0);
    expect(verify.stdout).toContain('OK');
    const status = run('instance', 'status', '--home', home);
    expect(status.stdout).toContain('standby');
    const inventory = run('inventory', '--home', home);
    expect(inventory.stdout).toContain('Inventory of');
  });

  it('exits 1 on a refusal and 2 on wrong usage, and never prints the secret', () => {
    const secret = readFileSync(join(home, 'secret'), 'utf8').trim();
    rmSync(join(home, 'secret'));
    const broken = run('verify', '--home', home);
    expect(broken.status).toBe(1);
    expect(broken.stdout).toContain('secret_missing');
    expect(broken.stdout + broken.stderr).not.toContain(secret);
    const refused = run('package', '--home', home, '--out', join(src.root, 'again'));
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('REFUSED');
    expect(run('verify').status).toBe(2);
    expect(run('nonsense').status).toBe(2);
    expect(run('instance', 'activate', '--home', home).status).toBe(1);
  });

  it('is usable as shown in the docs: help is the header of the file', () => {
    expect(execFileSync('head', ['-n', '4', cli], { encoding: 'utf8' })).toContain('The move tool');
  });
});
