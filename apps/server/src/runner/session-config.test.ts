import { chmod, lstat, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProcessRecord, ScopeProcessSource, StartSessionSpec } from '../contracts';
import {
  SessionConfigError,
  createSessionConfigStore,
  denySessionConfigRoots,
  writeHookConfig,
  writeSessionFile,
} from './session-config';
import type { OwnerRecord } from './session-config';
import { buildSessionPolicy } from '../../test/helpers/session-policy';
import { testConfig } from '../../test/helpers/test-template';
import { buildSettings } from './providers/claude/args';
import { silentLogger, tempDirs } from './test-helpers';

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

const TOKEN = 'tok-0123456789abcdef-canary';
const NOW = 1_800_000_000_000;
const RUNNER_PID = 4242;

function processRecord(over: Partial<ProcessRecord> & { pid: number }): ProcessRecord {
  return {
    ppid: 1,
    pgid: null,
    uid: process.getuid?.() ?? 501,
    rssBytes: 0,
    cpuSeconds: 0,
    cpuPercent: 0,
    startedAt: NOW,
    args: 'unrelated',
    ...over,
  };
}

function fakeProcesses(
  records: ProcessRecord[] | null,
  marks: Record<number, Record<string, string>> = {},
): ScopeProcessSource {
  return {
    processes: async () => records,
    envValues: async (pids) => new Map(pids.filter((pid) => marks[pid]).map((pid) => [pid, marks[pid]!])),
  } as ScopeProcessSource;
}

async function fresh(options: { processes?: ScopeProcessSource; uid?: number | null } = {}) {
  const base = await dirs.make('pm-run-');
  const root = path.join(base, 'run');
  const store = createSessionConfigStore({
    root,
    logger: silentLogger(),
    instanceTag: 'test',
    now: () => NOW,
    uid: options.uid === undefined ? (process.getuid?.() ?? null) : options.uid,
    ...(options.processes ? { processes: options.processes } : {}),
  });
  return { base, root, store };
}

/** Writes a folder the way a runner of another process would have left it. */
async function leftover(root: string, name: string, owner: Partial<OwnerRecord> | null) {
  const dir = path.join(root, name);
  await mkdir(dir, { mode: 0o700 });
  await writeFile(path.join(dir, 'hook.curl'), `url = "http://127.0.0.1:1/hooks/${TOKEN}"\n`);
  if (owner)
    await writeFile(
      path.join(dir, 'owner.json'),
      JSON.stringify({
        version: 1,
        sessionId: name.split('.')[0],
        instanceTag: 'test',
        runnerPid: 99_999,
        runnerStartedAt: NOW - 60_000,
        createdAt: NOW - 30_000,
        ...owner,
      }),
    );
  return dir;
}

describe('private session files', () => {
  it('writes a file with mode 0600, exclusively, and refuses a symlink or an existing file', async () => {
    const dir = await dirs.make();
    const file = await writeSessionFile(dir, 'a.json', '{}');
    expect(await readFile(file, 'utf8')).toBe('{}');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await expect(writeSessionFile(dir, 'a.json', 'again')).rejects.toBeInstanceOf(SessionConfigError);
    await symlink(path.join(dir, 'elsewhere'), path.join(dir, 'link.json'));
    await expect(writeSessionFile(dir, 'link.json', 'x')).rejects.toBeInstanceOf(SessionConfigError);
    await expect(writeSessionFile(dir, '../escape', 'x')).rejects.toBeInstanceOf(SessionConfigError);
    await expect(writeSessionFile('relative', 'a', 'x')).rejects.toBeInstanceOf(SessionConfigError);
  });

  it('writes the forwarder target as one curl line, per event when asked', async () => {
    const dir = await dirs.make();
    const plain = await writeHookConfig(dir, `http://127.0.0.1:4700/hooks/${TOKEN}`);
    expect(path.basename(plain)).toBe('hook.curl');
    expect(await readFile(plain, 'utf8')).toBe(`url = "http://127.0.0.1:4700/hooks/${TOKEN}"\n`);
    const event = await writeHookConfig(dir, `http://127.0.0.1:4700/hooks/${TOKEN}/`, 'PreToolUse');
    expect(path.basename(event)).toBe('hook-PreToolUse.curl');
    expect(await readFile(event, 'utf8')).toBe(`url = "http://127.0.0.1:4700/hooks/${TOKEN}/PreToolUse"\n`);
    expect((await stat(event)).mode & 0o777).toBe(0o600);
  });

  it.each([
    ['not a URL', 'not a url'],
    ['a file URL', 'file:///etc/passwd'],
    ['credentials in the URL', 'http://user:pw@127.0.0.1/hooks/x'],
    ['a quote', 'http://127.0.0.1/hooks/"x'],
    ['a backslash', 'http://127.0.0.1/hooks/\\x'],
    ['a newline', 'http://127.0.0.1/hooks/x\nurl = "http://evil"'],
    ['a fragment', 'http://127.0.0.1/hooks/x#y'],
  ])('refuses %s without quoting it', async (_name, url) => {
    const dir = await dirs.make();
    const err = await writeHookConfig(dir, url).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionConfigError);
    expect((err as Error).message).not.toContain('evil');
    expect((err as Error).message).not.toContain('passwd');
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('the session configuration store', () => {
  it('creates a private root and a 0700 folder with an owner record per session', async () => {
    const { root, store } = await fresh();
    const canonical = await store.prepare();
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect(canonical).toBe(root);
    const a = await store.allocate('ses_1');
    const b = await store.allocate('ses_1');
    expect(a.path).not.toBe(b.path);
    expect(path.dirname(a.path)).toBe(root);
    expect(path.basename(a.path)).toMatch(/^ses_1\.[0-9a-f]{16}$/);
    expect((await stat(a.path)).mode & 0o777).toBe(0o700);
    const owner = JSON.parse(await readFile(path.join(a.path, 'owner.json'), 'utf8'));
    expect(owner).toMatchObject({
      version: 1,
      sessionId: 'ses_1',
      instanceTag: 'test',
      runnerPid: process.pid,
    });
    expect((await stat(path.join(a.path, 'owner.json'))).mode & 0o777).toBe(0o600);
  });

  it('removes a folder with its files, and again without failing', async () => {
    const { store } = await fresh();
    const session = await store.allocate('ses_1');
    await writeSessionFile(session.path, 'claude-mcp.json', `{"url":"http://x/mcp/${TOKEN}"}`);
    await session.remove();
    await expect(lstat(session.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(session.remove()).resolves.toBeUndefined();
  });

  it('refuses a session id that cannot name a folder', async () => {
    const { store } = await fresh();
    for (const id of ['', '../x', 'a/b', 'a.b', 'a b'])
      await expect(store.allocate(id)).rejects.toBeInstanceOf(SessionConfigError);
  });

  it('refuses a root that is a symlink, is not private or is not a directory', async () => {
    const base = await dirs.make();
    const logger = silentLogger();
    const target = await dirs.make();
    await symlink(target, path.join(base, 'linked'));
    await expect(
      createSessionConfigStore({ root: path.join(base, 'linked'), logger }).prepare(),
    ).rejects.toBeInstanceOf(SessionConfigError);
    const open = path.join(base, 'open');
    await mkdir(open, { mode: 0o755 });
    await chmod(open, 0o755);
    const err = await createSessionConfigStore({ root: open, logger })
      .prepare()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionConfigError);
    expect((err as Error).message).not.toContain(base);
    await writeFile(path.join(base, 'file'), '');
    await expect(
      createSessionConfigStore({ root: path.join(base, 'file'), logger }).prepare(),
    ).rejects.toBeInstanceOf(SessionConfigError);
    await expect(createSessionConfigStore({ root: 'relative/run', logger }).prepare()).rejects.toBeInstanceOf(
      SessionConfigError,
    );
  });

  it('names the canonical root when the app home is reached through a symlink', async () => {
    const real = await dirs.make();
    const via = path.join(await dirs.make(), 'home');
    await symlink(real, via);
    const store = createSessionConfigStore({ root: path.join(via, 'run'), logger: silentLogger() });
    expect(await store.prepare()).toBe(path.join(real, 'run'));
  });
});

describe('the start-up sweep', () => {
  const GONE_RUNNER = [processRecord({ pid: 1, startedAt: 0, uid: 0 })];

  it('removes the folder of a runner that is gone and keeps everything it cannot prove orphaned', async () => {
    const { root, store } = await fresh({ processes: fakeProcesses(GONE_RUNNER) });
    await store.prepare();
    await leftover(root, 'ses_old.0123456789abcdef', {});
    await leftover(root, 'ses_nomark.0123456789abcdef', null);
    await leftover(root, 'ses_other.0123456789abcdef', { sessionId: 'ses_different' });
    await writeFile(path.join(root, 'stray-file'), '');
    await mkdir(path.join(root, 'empty-leftover'), { mode: 0o700 });
    const result = await store.sweep();
    expect(result.removed.sort()).toEqual(['empty-leftover', 'ses_old.0123456789abcdef']);
    expect(result.kept.sort()).toEqual([
      'ses_nomark.0123456789abcdef',
      'ses_other.0123456789abcdef',
      'stray-file',
    ]);
    expect((await readdir(root)).sort()).toEqual([
      'ses_nomark.0123456789abcdef',
      'ses_other.0123456789abcdef',
      'stray-file',
    ]);
  });

  it('never touches a folder of a running session, nor one whose runner is alive', async () => {
    const processes = fakeProcesses([processRecord({ pid: 7777, startedAt: NOW - 60_000 }), ...GONE_RUNNER]);
    const { root, store } = await fresh({ processes });
    await store.prepare();
    const mine = await store.allocate('ses_mine');
    const alive = await leftover(root, 'ses_alive.0123456789abcdef', { runnerPid: 7777 });
    const result = await store.sweep();
    expect(result.removed).toEqual([]);
    await expect(lstat(mine.path)).resolves.toBeTruthy();
    await expect(lstat(alive)).resolves.toBeTruthy();
  });

  it('treats a reused pid as a different process', async () => {
    const processes = fakeProcesses([processRecord({ pid: 7777, startedAt: NOW + 3_600_000 })], {
      7777: { PROJECTMAN_SESSION_ID: 'ses_unrelated' },
    });
    const { root, store } = await fresh({ processes });
    await store.prepare();
    await leftover(root, 'ses_reused.0123456789abcdef', { runnerPid: 7777 });
    expect((await store.sweep()).removed).toEqual(['ses_reused.0123456789abcdef']);
  });

  it('keeps a folder that a process still names, or whose session still has a process', async () => {
    const base = await dirs.make('pm-run-');
    const root = path.join(base, 'run');
    const named = path.join(root, 'ses_named.0123456789abcdef');
    const store = createSessionConfigStore({
      root,
      logger: silentLogger(),
      now: () => NOW,
      processes: fakeProcesses(
        [
          processRecord({ pid: 5001, args: `claude --settings ${named}/claude-settings.json` }),
          processRecord({ pid: 5002 }),
        ],
        { 5002: { PROJECTMAN_SESSION_ID: 'ses_marked' } },
      ),
    });
    await store.prepare();
    await leftover(root, 'ses_named.0123456789abcdef', { createdAt: NOW - 1_000 });
    await leftover(root, 'ses_marked.0123456789abcdef', { createdAt: NOW - 1_000 });
    await leftover(root, 'ses_free.0123456789abcdef', { createdAt: NOW - 1_000 });
    const result = await store.sweep();
    expect(result.kept.sort()).toEqual(['ses_marked.0123456789abcdef', 'ses_named.0123456789abcdef']);
    expect(result.removed).toEqual(['ses_free.0123456789abcdef']);
  });

  it('keeps everything when the processes or their environments cannot be observed', async () => {
    for (const processes of [undefined, fakeProcesses(null), fakeProcesses([processRecord({ pid: 5002 })])]) {
      const { root, store } = await fresh(processes ? { processes } : {});
      await store.prepare();
      await leftover(root, 'ses_old.0123456789abcdef', { createdAt: NOW - 1_000 });
      const result = await store.sweep();
      expect(result.removed).toEqual([]);
      expect(result.kept).toEqual(['ses_old.0123456789abcdef']);
    }
  });

  it('keeps everything when the user id is unknown', async () => {
    const { root, store } = await fresh({ processes: fakeProcesses(GONE_RUNNER), uid: null });
    await store.prepare();
    await leftover(root, 'ses_old.0123456789abcdef', {});
    expect((await store.sweep()).removed).toEqual([]);
  });

  it('does not follow a symlink in the root', async () => {
    const { root, store } = await fresh({ processes: fakeProcesses(GONE_RUNNER) });
    await store.prepare();
    const outside = await dirs.make();
    await writeFile(path.join(outside, 'precious'), 'keep');
    await symlink(outside, path.join(root, 'ses_link.0123456789abcdef'));
    const result = await store.sweep();
    expect(result.removed).toEqual([]);
    expect(await readFile(path.join(outside, 'precious'), 'utf8')).toBe('keep');
  });
});

describe('denySessionConfigRoots', () => {
  const spec = (over: Partial<StartSessionSpec> = {}): StartSessionSpec => ({
    sessionId: 'ses_1',
    claudeSessionId: '0b8a3c2e-1f5d-4c4e-9a7b-2d6e8f1a3b5c',
    resume: false,
    cwd: '/work',
    displayName: 'Anna',
    appendSystemPrompt: '',
    mcpUrl: 'http://127.0.0.1:1/mcp/t',
    allowedTools: [],
    ...over,
  });

  it('extends the sandbox lists once and does not change the given spec', () => {
    const given = spec({
      sandbox: { allowWrite: ['/work'], denyRead: ['/secret'], denyWrite: [], network: 'none' } as never,
    });
    const out = denySessionConfigRoots(given, ['/home/run', '/real/run', '/home/run']);
    expect(out.sandbox?.denyRead).toEqual(['/secret', '/home/run', '/real/run']);
    expect(out.sandbox?.denyWrite).toEqual(['/home/run', '/real/run']);
    expect(given.sandbox?.denyRead).toEqual(['/secret']);
  });

  it('reaches the file-tool rules and the shell sandbox of the Claude settings, for a policy', () => {
    const cwd = '/work/task';
    const policy = buildSessionPolicy({
      config: testConfig(),
      role: 'developer',
      task: { repo: 'web' },
      permissionMode: 'acceptEdits',
      placement: { kind: 'task_worktree', path: cwd },
    });
    const given = spec({
      cwd,
      policy,
      sandbox: { allowWrite: [cwd], allowedDomains: [], allowLocalBinding: true },
    });
    const out = denySessionConfigRoots(given, ['/home/projectman/run', '/real/projectman/run']);
    const settings = buildSettings({
      hookUrl: 'http://127.0.0.1:1/hooks/t',
      hookConfigPath: '/real/projectman/run/ses_1.0123456789abcdef/hook.curl',
      allowedTools: [],
      policy: out.policy,
      sandbox: out.sandbox,
      permissionTimeoutMs: 1000,
    });
    for (const root of ['/home/projectman/run', '/real/projectman/run']) {
      expect(settings.permissions.deny).toContain(`Read(/${root}/**)`);
      expect(settings.permissions.deny).toContain(`Edit(/${root}/**)`);
      expect(settings.sandbox?.filesystem.denyRead).toContain(root);
      expect(settings.sandbox?.filesystem.denyWrite).toContain(root);
    }
    // The given spec is untouched.
    expect(given.policy?.filesystem.deniedPaths ?? []).not.toContain('/home/projectman/run');
    expect(out.policy?.filesystem.deniedPaths).toContain('/home/projectman/run');
  });

  it('adds exact Claude deny rules for a spec without a policy', () => {
    const out = denySessionConfigRoots(spec({ deniedTools: ['Bash(rm:*)'] }), ['/home/run']);
    expect(out.deniedTools).toContain('Bash(rm:*)');
    expect(out.deniedTools).toContain('Read(//home/run/**)');
    expect(out.deniedTools).toContain('Edit(//home/run/**)');
  });
});
