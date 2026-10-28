import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runEngineCli } from '../../../scripts/engine/commands';
import type { EngineCliIo } from '../../../scripts/engine/commands';
import { defaultExec, findWorktrees, listedWorktrees } from '../../../scripts/engine/move-work-root';
import type { Exec } from '../../../scripts/engine/move-work-root';
import { loadEngineConfig } from '../src/engine-link/engine-config';
import { WORK_ROOT_MARKER } from '../src/engine-host';

const KEY = 'machine-key-0123456789abcdef';

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  );

/** PM-846: `npm run engine -- move-work-root`, on real git repositories in temp directories. */
describe('engine move-work-root', () => {
  let base: string;
  let home: string;
  let repo: string;
  let workRoot: string;
  let worktree: string;
  let clone: string;
  let out: string[];
  let err: string[];
  let running: Set<number>;
  let exec: Exec;

  const run = (...argv: string[]) => {
    const io: EngineCliIo = {
      env: {},
      cwd: base,
      tmpdir: path.join(base, 'system-tmp'),
      readStdin: async () => `${KEY}\n`,
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      startEngine: async () => 0,
      isRunning: (pid) => running.has(pid),
      exec: (file, args) => exec(file, args),
    };
    return runEngineCli([...argv, '--home', home], io);
  };
  const worktreeList = () => git(repo, 'worktree', 'list', '--porcelain');

  beforeEach(async () => {
    base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'engine-move-')));
    home = path.join(base, 'home');
    const workspace = path.join(base, 'projects');
    repo = path.join(workspace, 'projectman');
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(repo, 'README.md'), 'hello\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');

    out = [];
    err = [];
    running = new Set();
    exec = defaultExec;
    await run('init', '--cloud', 'https://cloud.example.com', '--id', 'eng_aaaaaaaaaaaa');
    await run('project', 'set', 'PM', workspace);
    await run('repo', 'add', 'PM', 'projectman', repo);

    // A task worktree with an uncommitted file, and a member workspace (a standalone clone).
    worktree = path.join(home, 'worktrees', 'PM', 'PM-1-projectman');
    mkdirSync(path.dirname(worktree), { recursive: true });
    git(repo, 'worktree', 'add', '-q', '-b', 'PM-1-work', worktree);
    writeFileSync(path.join(worktree, 'draft.txt'), 'not committed\n');
    clone = path.join(home, 'workspaces', 'claude', 'projectman');
    mkdirSync(path.dirname(clone), { recursive: true });
    git(base, 'clone', '-q', '--no-local', repo, clone);

    workRoot = path.join(home, 'work');
    mkdirSync(workRoot);
    writeFileSync(path.join(workRoot, WORK_ROOT_MARKER), '');
    out.length = 0;
    err.length = 0;
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('copies the directories, repairs the git links, renames the old ones and writes workRoot', async () => {
    expect(await run('move-work-root', workRoot)).toBe(0);

    const moved = path.join(workRoot, 'worktrees', 'PM', 'PM-1-projectman');
    expect(worktreeList()).toContain(`worktree ${moved}\n`);
    expect(worktreeList()).not.toContain(`worktree ${worktree}\n`);
    expect(readFileSync(path.join(moved, 'draft.txt'), 'utf8')).toBe('not committed\n');
    expect(git(moved, 'status', '--porcelain')).toBe('?? draft.txt\n');
    expect(git(path.join(workRoot, 'workspaces', 'claude', 'projectman'), 'status', '--porcelain')).toBe('');
    expect(existsSync(path.join(home, 'worktrees'))).toBe(false);
    expect(existsSync(path.join(home, 'workspaces'))).toBe(false);
    expect(existsSync(path.join(home, 'worktrees.pre-PM-846', 'PM', 'PM-1-projectman', 'draft.txt'))).toBe(
      true,
    );
    expect(existsSync(path.join(home, 'workspaces.pre-PM-846', 'claude', 'projectman'))).toBe(true);
    expect(loadEngineConfig(home).workRoot).toBe(workRoot);
    expect(out.join('\n')).toContain('worktrees.pre-PM-846');
  });

  it('refuses a second move once workRoot is set', async () => {
    expect(await run('move-work-root', workRoot)).toBe(0);
    expect(await run('move-work-root', workRoot)).toBe(1);
    expect(err.join('\n')).toContain('work_root_set');
  });

  it('refuses while the engine runs', async () => {
    writeFileSync(
      path.join(home, 'engine-status.json'),
      JSON.stringify({
        pid: 4242,
        bootId: '0123456789abcdef',
        startedAt: '2026-10-09T09:50:00Z',
        connection: 'connected',
        updatedAt: '2026-10-09T09:59:50Z',
        attempts: 1,
        pendingEvents: 0,
        droppedEvents: 0,
        running: [],
      }),
    );
    running.add(4242);
    expect(await run('move-work-root', workRoot)).toBe(1);
    expect(err.join('\n')).toContain('engine_running');
    expect(existsSync(path.join(home, 'worktrees'))).toBe(true);
    expect(loadEngineConfig(home).workRoot).toBeUndefined();
  });

  it('refuses a target that already holds worktrees', async () => {
    mkdirSync(path.join(workRoot, 'worktrees', 'old'), { recursive: true });
    expect(await run('move-work-root', workRoot)).toBe(1);
    expect(err.join('\n')).toContain('target_not_empty');
    expect(loadEngineConfig(home).workRoot).toBeUndefined();
  });

  it('refuses a volume without the marker, a relative path and an outside path', async () => {
    rmSync(path.join(workRoot, WORK_ROOT_MARKER));
    expect(await run('move-work-root', workRoot)).toBe(1);
    expect(err.join('\n')).toContain('work_root_invalid');
    expect(await run('move-work-root', 'work')).toBe(1);
    const outside = path.join(base, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, WORK_ROOT_MARKER), '');
    expect(await run('move-work-root', outside)).toBe(1);
    expect(err.join('\n')).toContain('must lie inside the engine home');
    expect(existsSync(path.join(home, 'worktrees'))).toBe(true);
  });

  it('leaves engine.json and the old directories alone when a repair fails, and points git back', async () => {
    exec = (file, args) =>
      file === 'git' && args[0] === '-C' && args[1]!.startsWith(workRoot) && args.includes('repair')
        ? Promise.reject(new Error('repair failed'))
        : defaultExec(file, args);

    expect(await run('move-work-root', workRoot)).toBe(1);

    expect(err.join('\n')).toContain('repair failed');
    expect(loadEngineConfig(home).workRoot).toBeUndefined();
    expect(existsSync(worktree)).toBe(true);
    expect(existsSync(path.join(home, 'worktrees.pre-PM-846'))).toBe(false);
    expect(worktreeList()).toContain(`worktree ${worktree}\n`);
  });

  it('stops before writing engine.json when a worktree still points at the old directory', async () => {
    // A repair that does nothing: the copy is in place but git has not been told.
    exec = (file, args) =>
      file === 'git' && args.includes('repair') ? Promise.resolve('') : defaultExec(file, args);

    expect(await run('move-work-root', workRoot)).toBe(1);

    expect(err.join('\n')).toContain('worktree_not_repaired');
    expect(loadEngineConfig(home).workRoot).toBeUndefined();
    expect(existsSync(path.join(home, 'worktrees'))).toBe(true);
  });

  it('exits 2 without a path', async () => {
    expect(await run('move-work-root')).toBe(2);
    expect(err.join('\n')).toContain('usage');
  });

  it('lists the worktrees below a directory and the live entries of a porcelain listing', () => {
    expect(findWorktrees(path.join(home, 'worktrees'))).toEqual([worktree]);
    expect(findWorktrees(path.join(home, 'nothing'))).toEqual([]);
    expect(
      listedWorktrees(
        'worktree /a\nHEAD x\nbranch refs/heads/main\n\nworktree /b\nHEAD y\ndetached\nprunable gitdir file points to non-existent location\n\n',
      ),
    ).toEqual(['/a']);
  });
});
