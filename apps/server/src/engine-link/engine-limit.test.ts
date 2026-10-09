import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnginePaths, MachineProbe, ProcessRecord } from '../contracts';
import { createEngineLimit } from './engine-limit';
import type { EngineLimit } from './engine-limit';
import type { ResolvedEngineConfig } from './engine-config';
import type { EngineMethod } from './methods';

const TOKEN = 'abcdefgh12345678';

describe('engine local limit', () => {
  let base: string;
  let home: string;
  let userHome: string;
  let workspace: string;
  let repo: string;
  let worktrees: string;
  let outside: string;
  let processes: ProcessRecord[] | null;
  let markers: Map<number, Record<string, string>>;
  let sessionPids: number[];
  let probe: MachineProbe & { signal: ReturnType<typeof vi.fn> };

  const record = (pid: number, ppid: number, overrides: Partial<ProcessRecord> = {}): ProcessRecord => ({
    pid,
    ppid,
    args: '',
    uid: 501,
    rssBytes: 0,
    cpuSeconds: 0,
    cpuPercent: 0,
    startedAt: 1000,
    ...overrides,
  });

  const paths = (): EnginePaths => ({
    userHome,
    home,
    worktreesRoot: worktrees,
    workspacesRoot: null,
    installDir: null,
    sessionFoldersRoot: path.join(home, 'session-folders'),
    sessionTmpRoot: path.join(home, 'tmp'),
    claudeTmpRoots: [],
    browsersDir: path.join(home, 'browsers'),
    heavyLockDir: path.join(home, 'heavy', 'lock'),
    gitExcludesFile: null,
  });

  const config = (overrides: Partial<ResolvedEngineConfig> = {}): ResolvedEngineConfig => ({
    schemaVersion: 1,
    cloudUrl: 'https://cloud.example.com',
    engineId: 'eng_aaaaaaaaaaaa',
    name: 'mac',
    keyFile: path.join(home, 'engine.key'),
    projects: [{ project: 'PM', workspacePath: workspace }],
    repos: [{ project: 'PM', repo: 'projectman', path: repo, fullTestCommand: 'npm test' }],
    maxPermissionMode: 'auto',
    allowRemoteTerminalInput: true,
    ...overrides,
  });

  const make = (overrides: Partial<ResolvedEngineConfig> = {}): EngineLimit =>
    createEngineLimit({
      config: config(overrides),
      home,
      userHome,
      paths: paths(),
      instanceTag: 'a'.repeat(16),
      transcriptRoots: [path.join(userHome, '.claude', 'projects')],
      tmpdir: path.join(base, 'os-tmp'),
      probe,
      sessionPids: () => sessionPids,
      selfPid: 99,
      selfUid: 501,
    });

  const refused = async (limit: EngineLimit, method: EngineMethod, params: unknown, code: string) => {
    await expect(limit.check(method, params as never)).rejects.toMatchObject({ code });
  };

  const sandbox = (overrides: Record<string, unknown> = {}) => ({
    allowWrite: [workspace],
    allowRead: [],
    denyRead: [],
    denyWrite: [],
    allowedDomains: [],
    ...overrides,
  });
  const start = (overrides: Record<string, unknown> = {}) => ({
    sessionId: 's1',
    provider: 'claude',
    cwd: repo,
    ...overrides,
  });

  beforeEach(() => {
    base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'engine-limit-')));
    home = path.join(base, 'home');
    userHome = path.join(base, 'user');
    workspace = path.join(base, 'work');
    repo = path.join(workspace, 'projectman');
    worktrees = path.join(home, 'worktrees');
    outside = path.join(base, 'elsewhere');
    for (const dir of [home, userHome, repo, worktrees, outside, path.join(home, 'member-caches')])
      mkdirSync(dir, { recursive: true });
    processes = [];
    markers = new Map();
    sessionPids = [];
    probe = {
      machine: async () => ({}) as never,
      processes: async () => processes,
      envValues: async (pids: number[]) =>
        new Map(pids.flatMap((pid) => (markers.has(pid) ? [[pid, markers.get(pid)!]] : []))) as never,
      signal: vi.fn(() => 'sent' as const),
    };
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  describe('session.start', () => {
    it('accepts a session inside the registered workspace', async () => {
      const limit = make();
      const result = (await limit.check('session.start', start({ permissionMode: 'auto' }) as never)) as {
        cwd: string;
      };
      expect(result.cwd).toBe(repo);
    });

    it('refuses a working directory outside the roots', async () => {
      await refused(make(), 'session.start', start({ cwd: outside }), 'path_outside_roots');
    });

    it('refuses a relative working directory and one with a NUL byte', async () => {
      const limit = make();
      await refused(limit, 'session.start', start({ cwd: 'projectman' }), 'path_outside_roots');
      await refused(limit, 'session.start', start({ cwd: `${repo}\0/../../etc` }), 'path_outside_roots');
    });

    it('refuses a path that leaves the workspace through ..', async () => {
      await refused(
        make(),
        'session.start',
        start({ cwd: path.join(repo, '..', '..', 'elsewhere') }),
        'path_outside_roots',
      );
    });

    it('refuses a symbolic link inside the workspace that points outside', async () => {
      symlinkSync(outside, path.join(workspace, 'link'));
      await refused(
        make(),
        'session.start',
        start({ cwd: path.join(workspace, 'link') }),
        'path_outside_roots',
      );
    });

    it('refuses an additional directory and a writable root outside the roots', async () => {
      const limit = make();
      await refused(
        limit,
        'session.start',
        start({ additionalDirectories: [outside] }),
        'path_outside_roots',
      );
      await refused(limit, 'session.start', start({ writableRoots: [userHome] }), 'path_outside_roots');
    });

    it('refuses bypassPermissions always, and a mode above the configured limit', async () => {
      await refused(
        make(),
        'session.start',
        start({ permissionMode: 'bypassPermissions' }),
        'permission_mode_too_high',
      );
      const limited = make({ maxPermissionMode: 'acceptEdits' });
      await refused(limited, 'session.start', start({ permissionMode: 'auto' }), 'permission_mode_too_high');
      await expect(
        limited.check('session.start', start({ permissionMode: 'acceptEdits' }) as never),
      ).resolves.toBeDefined();
    });

    it('refuses a policy that asks for full access or sits outside the roots', async () => {
      const policy = (overrides: Record<string, unknown>) => ({
        permissions: { claude: 'default', sandbox: 'workspace-write', ...(overrides.permissions as object) },
        placement: { path: repo },
        filesystem: { writableRoots: [repo], ...(overrides.filesystem as object) },
      });
      const limit = make();
      await refused(
        limit,
        'session.start',
        start({ policy: policy({ permissions: { sandbox: 'danger-full-access' } }) }),
        'permission_mode_too_high',
      );
      await refused(
        limit,
        'session.start',
        start({ policy: policy({ filesystem: { writableRoots: [userHome] } }) }),
        'path_outside_roots',
      );
    });

    it('refuses a sandbox that lets a command out, or sets PATH or a billing key', async () => {
      const limit = make();
      await refused(
        limit,
        'session.start',
        start({ sandbox: sandbox({ excludedCommands: ['rm'] }) }),
        'command_not_allowed',
      );
      await refused(
        limit,
        'session.start',
        start({ sandbox: sandbox({ env: { PATH: '/tmp/evil' } }) }),
        'invalid_params',
      );
      await refused(
        limit,
        'session.start',
        start({ sandbox: sandbox({ env: { NODE_OPTIONS: '--require x' } }) }),
        'invalid_params',
      );
      await refused(
        limit,
        'session.start',
        start({ sandbox: sandbox({ env: { ANTHROPIC_API_KEY: 'x' } }) }),
        'invalid_params',
      );
      await refused(
        limit,
        'session.start',
        start({ sandbox: sandbox({ allowRead: [userHome] }) }),
        'path_outside_roots',
      );
    });

    it('adds the credential places to the sandbox denials, and builds one when the cloud sent none', async () => {
      const limit = make();
      const given = (await limit.check('session.start', start({ sandbox: sandbox() }) as never)) as {
        sandbox: { denyRead: string[]; denyWrite: string[]; deniedEnvVars: string[] };
      };
      expect(given.sandbox.denyRead).toContain(path.join(userHome, '.ssh'));
      expect(given.sandbox.denyWrite).toContain(path.join(userHome, '.claude', 'settings.json'));
      expect(given.sandbox.deniedEnvVars.length).toBeGreaterThan(0);
      const built = (await limit.check('session.start', start() as never)) as {
        sandbox: { allowWrite: string[]; denyRead: string[] };
      };
      expect(built.sandbox.allowWrite).toContain(repo);
      expect(built.sandbox.denyRead).toContain(path.join(userHome, '.ssh'));
    });
  });

  it('refuses terminal input when the engine disabled it', async () => {
    const params = { sessionId: 's1', data: 'x' };
    await expect(make().check('terminal.input', params as never)).resolves.toEqual(params);
    await refused(
      make({ allowRemoteTerminalInput: false }),
      'terminal.input',
      params,
      'terminal_input_disabled',
    );
  });

  describe('transcripts', () => {
    it('reads from the CLIs’ transcript folders and the roots only', async () => {
      const limit = make();
      const inTranscripts = path.join(userHome, '.claude', 'projects', 'x', 'a.jsonl');
      await expect(
        limit.check('transcript.has_content', { path: inTranscripts } as never),
      ).resolves.toBeDefined();
      await refused(
        limit,
        'transcript.has_content',
        { path: path.join(userHome, '.ssh', 'id_rsa') },
        'path_outside_roots',
      );
      await refused(
        limit,
        'transcript.summary',
        { path: path.join(outside, 'a.jsonl') },
        'path_outside_roots',
      );
      await refused(
        limit,
        'transcript.read',
        { path: path.join(outside, 'a.jsonl'), uploadToken: TOKEN },
        'path_outside_roots',
      );
    });

    it('refuses a confinement outside the roots and an upload token that is not a token', async () => {
      const limit = make();
      const file = path.join(userHome, '.claude', 'projects', 'x', 'a.jsonl');
      await refused(limit, 'transcript.summary', { path: file, confineTo: outside }, 'path_outside_roots');
      await refused(limit, 'transcript.read', { path: file, uploadToken: '../x' }, 'invalid_params');
      await expect(
        limit.check('transcript.read', { path: file, uploadToken: TOKEN } as never),
      ).resolves.toBeDefined();
    });
  });

  describe('worktrees and workspaces', () => {
    const projectConfig = (repoName = 'projectman', extra = '') => ({
      project: {
        key: 'PM',
        workspacePath: '/cloud/path',
        repos: [{ name: repoName, path: `/cloud/${repoName}${extra}` }],
      },
    });

    it('replaces the cloud’s paths with the registered ones', async () => {
      const [arg] = (await make().check('worktree.ensureForTask', [
        { project: projectConfig(), repoName: 'projectman', taskKey: 'PM-1' },
      ] as never)) as unknown as Array<{
        project: { project: { workspacePath: string; repos: Array<{ path: string }> } };
      }>;
      expect((arg!.project as never as { project: { workspacePath: string } }).project.workspacePath).toBe(
        workspace,
      );
      expect(
        (arg!.project as never as { project: { repos: Array<{ path: string }> } }).project.repos[0]!.path,
      ).toBe(repo);
    });

    it('refuses a repo or a project that is not registered', async () => {
      const limit = make();
      await refused(
        limit,
        'worktree.ensureForTask',
        [{ project: projectConfig('other'), repoName: 'other' }],
        'repo_not_registered',
      );
      await refused(limit, 'workspace.home', [{ projectKey: 'XX' }], 'repo_not_registered');
      await refused(
        limit,
        'workspace.ensure',
        [{ project: projectConfig('other'), repoName: 'other' }],
        'repo_not_registered',
      );
    });

    it('removes a worktree only below the worktrees root', async () => {
      const limit = make();
      await expect(
        limit.check('worktree.remove', [{ path: path.join(worktrees, 'PM', 'PM-1') }] as never),
      ).resolves.toBeDefined();
      await refused(limit, 'worktree.remove', [{ path: worktrees }], 'path_outside_roots');
      await refused(limit, 'worktree.remove', [{ path: repo }], 'path_outside_roots');
      await refused(
        limit,
        'worktree.remove',
        [{ path: path.join(worktrees, '..', 'user') }],
        'path_outside_roots',
      );
    });

    it('limits the paths of worktree and git queries', async () => {
      const limit = make();
      await refused(limit, 'worktree.head', [outside], 'path_outside_roots');
      await refused(limit, 'worktree.status', [outside], 'path_outside_roots');
      await refused(limit, 'worktree.refreshDependencies', [outside], 'path_outside_roots');
      await refused(limit, 'host.resolve_git_dir', { repoPath: outside }, 'path_outside_roots');
      await refused(limit, 'workspace.resolveSource', [{ path: outside }], 'path_outside_roots');
      await refused(
        limit,
        'session.assert_workspace_config',
        { provider: 'claude', cwd: outside },
        'path_outside_roots',
      );
    });
  });

  describe('full test and screenshots', () => {
    const fullTest = (overrides: Record<string, unknown> = {}) => ({
      spec: {
        command: 'npm test',
        cwd: repo,
        sandbox: { allowRead: [], denyRead: [], denyWrite: [], allowWrite: [] },
        ...overrides,
      },
    });
    const shots = (overrides: Record<string, unknown> = {}) => ({
      spec: {
        cwd: repo,
        sessionDir: path.join(home, 'session-folders', 's1'),
        args: [path.join(repo, 'scenario.json'), '--widths', '390,1280', '--full-page'],
        sandbox: { allowRead: [], denyRead: [], denyWrite: [], allowWrite: [] },
        ...overrides,
      },
    });

    it('runs only the command configured for a registered repo', async () => {
      const limit = make();
      await expect(limit.check('full_test.run', fullTest() as never)).resolves.toBeDefined();
      await refused(limit, 'full_test.run', fullTest({ command: 'rm -rf ~' }), 'command_not_allowed');
      await refused(
        make({ repos: [{ project: 'PM', repo: 'projectman', path: repo }] }),
        'full_test.run',
        fullTest(),
        'command_not_allowed',
      );
      await refused(limit, 'full_test.run', fullTest({ cwd: outside }), 'path_outside_roots');
    });

    it('adds the credential places to the test sandbox denials', async () => {
      const result = (await make().check('full_test.run', fullTest() as never)) as {
        spec: { sandbox: { denyRead: string[] } };
      };
      expect(result.spec.sandbox.denyRead).toContain(path.join(userHome, '.ssh'));
    });

    it('accepts the screenshot arguments the server builds and nothing else', async () => {
      const limit = make();
      await expect(limit.check('screenshots.run', shots() as never)).resolves.toBeDefined();
      const bad = (args: string[]) =>
        refused(limit, 'screenshots.run', shots({ args }), 'command_not_allowed');
      await bad([path.join(repo, 's.json'), '--out', '/etc']);
      await bad([path.join(repo, 's.json'), '--machine']);
      await bad(['--widths', '390']);
      await bad([path.join(repo, 's.json'), '--widths', 'x']);
      await bad([]);
      await refused(
        limit,
        'screenshots.run',
        shots({ args: [path.join(outside, 's.json')] }),
        'path_outside_roots',
      );
      await refused(limit, 'screenshots.run', shots({ cwd: outside }), 'path_outside_roots');
      await refused(limit, 'screenshots.run', shots({ browsersDir: outside }), 'path_outside_roots');
    });
  });

  describe('host and files', () => {
    it('limits host queries to the roots', async () => {
      const limit = make();
      await refused(limit, 'host.is_directory', { path: outside }, 'path_outside_roots');
      await refused(limit, 'host.realpath', { path: userHome }, 'path_outside_roots');
      await refused(limit, 'host.is_real_directory', { dir: '/etc' }, 'path_outside_roots');
      await refused(limit, 'host.prepare_portable_paths', { paths: [repo, outside] }, 'path_outside_roots');
      await expect(limit.check('host.is_directory', { path: repo } as never)).resolves.toBeDefined();
    });

    it('prepares a member sandbox directory only at member-caches/<project>/<member>', async () => {
      const limit = make();
      const dir = (...parts: string[]) => ({ dir: path.join(home, 'member-caches', ...parts) });
      await expect(
        limit.check('host.prepare_member_sandbox_dir', dir('PM', 'dev') as never),
      ).resolves.toBeDefined();
      await refused(limit, 'host.prepare_member_sandbox_dir', dir('PM'), 'path_outside_roots');
      await refused(limit, 'host.prepare_member_sandbox_dir', dir('PM', 'dev', 'x'), 'path_outside_roots');
      await refused(limit, 'host.prepare_member_sandbox_dir', dir('pm', 'dev'), 'path_outside_roots');
      await refused(
        limit,
        'host.prepare_member_sandbox_dir',
        dir('PM', '..', '..', 'work'),
        'path_outside_roots',
      );
      await refused(
        limit,
        'host.prepare_member_sandbox_dir',
        { dir: path.join(outside, 'PM', 'dev') },
        'path_outside_roots',
      );
    });

    it('makes a session folder only inside the roots', async () => {
      const limit = make();
      await expect(
        limit.check('folders.make', {
          sessionId: 's1',
          dir: path.join(home, 'session-folders', 's1'),
        } as never),
      ).resolves.toBeDefined();
      await refused(
        limit,
        'folders.make',
        { sessionId: 's1', dir: path.join(outside, 's1') },
        'path_outside_roots',
      );
      await refused(
        limit,
        'folders.make',
        { sessionId: 's1', dir: path.join(home, 'session-folders', 's1'), tmpDir: outside },
        'path_outside_roots',
      );
    });

    it('resolves scenarios and lists images only inside the roots', async () => {
      const limit = make();
      await refused(
        limit,
        'files.resolve_scenario',
        { roots: { cwd: outside, sessionDir: home } },
        'path_outside_roots',
      );
      await refused(
        limit,
        'files.resolve_scenario',
        { roots: { cwd: repo, sessionDir: outside } },
        'path_outside_roots',
      );
      await refused(limit, 'files.list_images', { dir: userHome }, 'path_outside_roots');
    });

    it('exports files only from the directories of a session that started here', async () => {
      const limit = make();
      const params = (root: string, sessionId = 's1') => ({ sessionId, root, uploadToken: TOKEN });
      await refused(limit, 'files.export', params(repo), 'path_outside_roots');
      await limit.check('session.start', start() as never);
      await expect(limit.check('files.export', params(repo) as never)).resolves.toBeDefined();
      await refused(limit, 'files.export', params(workspace), 'path_outside_roots');
      await refused(limit, 'files.export', params(userHome), 'path_outside_roots');
      await refused(limit, 'files.export', params(repo, 's2'), 'path_outside_roots');
      await refused(limit, 'files.export', { ...params(repo), uploadToken: 'x/../y' }, 'invalid_params');
    });

    it('materializes an attachment only under the cache and by a plain name', async () => {
      const limit = make();
      const params = (name: string, extra: Record<string, unknown> = {}) => ({
        projectKey: 'PM',
        taskKey: 'PM-1',
        name,
        downloadToken: TOKEN,
        ...extra,
      });
      await expect(limit.check('files.materialize', params('shot.png') as never)).resolves.toBeDefined();
      expect(limit.cachePath('PM', 'PM-1', 'shot.png')).toBe(
        path.join(home, 'attachments-cache', 'PM', 'PM-1', 'shot.png'),
      );
      for (const name of ['../x', 'a/b', '..', '.', '', 'a\\b', 'x\0y'])
        await refused(limit, 'files.materialize', params(name), 'invalid_params');
      await refused(limit, 'files.materialize', params('a.png', { projectKey: '../x' }), 'invalid_params');
      await refused(limit, 'files.materialize', params('a.png', { taskKey: 'PM-1/../..' }), 'invalid_params');
      await refused(
        limit,
        'files.materialize',
        params('a.png', { downloadToken: 'short' }),
        'invalid_params',
      );
    });

    it('checks the branch export upload token', async () => {
      await refused(
        make(),
        'workspace.export_branch',
        {
          uploadToken: 'no/token',
          key: { project: { project: { key: 'PM', repos: [] } }, repoName: 'projectman' },
        },
        'invalid_params',
      );
    });
  });

  describe('machine.signal', () => {
    it('refuses pid 1, the engine itself and a process it cannot list', async () => {
      const limit = make();
      await expect(limit.signal(1, 'SIGTERM')).rejects.toMatchObject({ code: 'signal_not_allowed' });
      await expect(limit.signal(99, 'SIGKILL')).rejects.toMatchObject({ code: 'signal_not_allowed' });
      processes = null;
      await expect(limit.signal(500, 'SIGTERM')).rejects.toMatchObject({ code: 'signal_not_allowed' });
      expect(probe.signal).not.toHaveBeenCalled();
    });

    it('signals a process in a running session’s tree', async () => {
      processes = [record(10, 1), record(11, 10), record(12, 11)];
      sessionPids = [10];
      await expect(make().signal(12, 'SIGTERM')).resolves.toBe('sent');
      expect(probe.signal).toHaveBeenCalledWith(12, 'SIGTERM');
    });

    it('refuses a process of another user, even inside a tree', async () => {
      processes = [record(10, 1), record(11, 10, { uid: 0 })];
      sessionPids = [10];
      await expect(make().signal(11, 'SIGTERM')).rejects.toMatchObject({ code: 'signal_not_allowed' });
      expect(probe.signal).not.toHaveBeenCalled();
    });

    it('refuses a process outside every session’s tree unless it carries this engine’s marker', async () => {
      processes = [record(10, 1), record(300, 1)];
      sessionPids = [10];
      const limit = make();
      await expect(limit.signal(300, 'SIGTERM')).rejects.toMatchObject({ code: 'signal_not_allowed' });
      markers.set(300, { PROJECTMAN_INSTANCE: 'f'.repeat(16) });
      await expect(limit.signal(300, 'SIGTERM')).rejects.toMatchObject({ code: 'signal_not_allowed' });
      markers.set(300, { PROJECTMAN_INSTANCE: 'a'.repeat(16) });
      await expect(limit.signal(300, 'SIGTERM')).resolves.toBe('sent');
    });

    it('reports a process that is gone without signalling', async () => {
      processes = [record(10, 1)];
      sessionPids = [10];
      await expect(make().signal(77, 'SIGTERM')).resolves.toBe('gone');
      expect(probe.signal).not.toHaveBeenCalled();
    });

    it('does not signal when the pid was taken by another process meanwhile', async () => {
      sessionPids = [10];
      const limit = make();
      let calls = 0;
      probe.processes = async () => {
        calls += 1;
        return [record(10, 1), record(11, 10, { startedAt: calls === 1 ? 1000 : 2000 })];
      };
      await expect(limit.signal(11, 'SIGKILL')).rejects.toMatchObject({ code: 'signal_not_allowed' });
      expect(probe.signal).not.toHaveBeenCalled();
    });
  });

  it('keeps the home-wide places out of the roots', () => {
    const roots = make().roots();
    expect(roots).toContain(workspace);
    expect(roots).toContain(worktrees);
    expect(roots).not.toContain(home);
    expect(roots).not.toContain(userHome);
  });
});
