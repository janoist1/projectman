import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rmdir, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDirs } from './test-helpers';
import { defaultClaudeConfigPath, ensureWorkspaceTrusted, isTrusted, trustKeyFor, withTrust } from './trust';

const run = promisify(execFile);
const dirs = tempDirs();
afterEach(() => dirs.cleanup());

async function gitRepo(dir: string): Promise<void> {
  await run('git', ['init', '-q', dir]);
  await run('git', [
    '-C',
    dir,
    '-c',
    'user.email=t@t',
    '-c',
    'user.name=t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init',
  ]);
}

async function configWith(content: unknown): Promise<string> {
  const file = path.join(await dirs.make('claude-home-'), '.claude.json');
  await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2), {
    mode: 0o600,
  });
  return file;
}

describe('defaultClaudeConfigPath', () => {
  it('follows CLAUDE_CONFIG_DIR, else the home directory', () => {
    expect(defaultClaudeConfigPath({ CLAUDE_CONFIG_DIR: '/x/cfg' })).toBe('/x/cfg/.claude.json');
    expect(defaultClaudeConfigPath({})).toBe(path.join(os.homedir(), '.claude.json'));
  });
});

describe('trustKeyFor', () => {
  it('uses the folder itself outside a repository', async () => {
    const dir = await dirs.make();
    expect(await trustKeyFor(dir)).toEqual({ key: dir, inRepo: false });
  });

  it('uses the repository root, and the main checkout for a worktree', async () => {
    const repo = await dirs.make('repo-');
    await gitRepo(repo);
    await mkdir(path.join(repo, 'pkg'));
    expect(await trustKeyFor(path.join(repo, 'pkg'))).toEqual({ key: repo, inRepo: true });

    const worktree = path.join(await dirs.make('wt-'), 'task');
    await run('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'task', worktree]);
    expect(await trustKeyFor(worktree)).toEqual({ key: repo, inRepo: true });
  });
});

describe('isTrusted / withTrust', () => {
  it('lets a trusted parent cover folders outside repositories only', () => {
    const config = { projects: { '/work': { hasTrustDialogAccepted: true } } };
    expect(isTrusted(config, '/work/a/b', false)).toBe(true);
    expect(isTrusted(config, '/work/a/b', true)).toBe(false);
    expect(isTrusted(config, '/other', false)).toBe(false);
  });

  it('adds only the flag, keeping every other key', () => {
    const config = {
      numStartups: 3,
      projects: { '/a': { allowedTools: ['x'], lastCost: 1 } },
      oauthAccount: { id: 1 },
    };
    const next = withTrust(withTrust(config, '/a'), '/b');
    expect(next).toEqual({
      numStartups: 3,
      projects: {
        '/a': { allowedTools: ['x'], lastCost: 1, hasTrustDialogAccepted: true },
        '/b': {
          allowedTools: [],
          mcpContextUris: [],
          enabledMcpjsonServers: [],
          disabledMcpjsonServers: [],
          hasClaudeMdExternalIncludesApproved: false,
          hasClaudeMdExternalIncludesWarningShown: false,
          hasTrustDialogAccepted: true,
        },
      },
      oauthAccount: { id: 1 },
    });
    expect(config.projects['/a']).not.toHaveProperty('hasTrustDialogAccepted');
  });
});

describe('ensureWorkspaceTrusted', () => {
  it('records trust with a minimal, atomic change and no leftovers', async () => {
    const cwd = await dirs.make('ws-');
    const file = await configWith({
      numStartups: 1,
      projects: { '/elsewhere': { hasTrustDialogAccepted: true } },
    });
    expect(await ensureWorkspaceTrusted(file, cwd)).toEqual({ result: 'trusted', key: cwd });

    const text = await readFile(file, 'utf8');
    const config = JSON.parse(text);
    expect(config.numStartups).toBe(1);
    expect(config.projects['/elsewhere']).toEqual({ hasTrustDialogAccepted: true });
    expect(config.projects[cwd].hasTrustDialogAccepted).toBe(true);
    expect(text.startsWith('{\n  "numStartups": 1')).toBe(true);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(path.dirname(file))).toEqual(['.claude.json']);

    expect(await ensureWorkspaceTrusted(file, cwd)).toEqual({ result: 'already_trusted', key: cwd });
  });

  it('leaves a missing or unparseable config alone', async () => {
    const cwd = await dirs.make('ws-');
    const missing = path.join(await dirs.make(), '.claude.json');
    expect((await ensureWorkspaceTrusted(missing, cwd)).result).toBe('skipped');
    await expect(stat(missing)).rejects.toThrow();

    const broken = await configWith('{"projects": ');
    expect((await ensureWorkspaceTrusted(broken, cwd)).result).toBe('skipped');
    expect(await readFile(broken, 'utf8')).toBe('{"projects": ');
  });

  it('waits for Claude Code’s lock, and takes over a stale one', async () => {
    const cwd = await dirs.make('ws-');
    const file = await configWith({ projects: {} });
    const lock = `${file}.lock`;

    await mkdir(lock);
    const pending = ensureWorkspaceTrusted(file, cwd);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(JSON.parse(await readFile(file, 'utf8')).projects).toEqual({});
    await rmdir(lock);
    expect((await pending).result).toBe('trusted');
    await expect(stat(lock)).rejects.toThrow();

    const other = await dirs.make('ws-');
    await mkdir(lock);
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    expect((await ensureWorkspaceTrusted(file, other)).result).toBe('trusted');
    await expect(stat(lock)).rejects.toThrow();
  });

  it('never persists trust for the home directory', async () => {
    const file = await configWith({ projects: {} });
    const outcome = await ensureWorkspaceTrusted(file, os.homedir());
    expect(outcome.result).toBe('skipped');
    expect(JSON.parse(await readFile(file, 'utf8')).projects).toEqual({});
  });
});
