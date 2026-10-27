import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnginePaths, MachineProbe, ProcessRecord } from '../contracts';
import { newId } from '../kernel';
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
    pgid: null,
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
    repos: [
      { project: 'PM', repo: 'projectman', path: repo, fullTestCommand: 'npm test', workspaceSetup: null },
    ],
    maxPermissionMode: 'auto',
    allowRemoteTerminalInput: true,
    ...overrides,
  });

  const make = (
    overrides: Partial<ResolvedEngineConfig> = {},
    pathOverrides: Partial<EnginePaths> = {},
  ): EngineLimit =>
    createEngineLimit({
      config: config(overrides),
      home,
      userHome,
      paths: { ...paths(), ...pathOverrides },
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
  /** A session policy for a task worktree; each section is merged with what the case changes. */
  const policy = (overrides: Record<string, unknown> = {}) => ({
    permissions: { claude: 'default', sandbox: 'workspace-write', ...(overrides.permissions as object) },
    placement: { kind: 'read_only', path: repo, ...(overrides.placement as object) },
    filesystem: {
      readableRoots: [repo],
      writableRoots: [repo],
      protectedPaths: [],
      ...(overrides.filesystem as object),
    },
  });
  const start = (overrides: Record<string, unknown> = {}) => ({
    sessionId: 's1',
    provider: 'claude',
    cwd: repo,
    policy: policy(),
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
      signal: vi.fn(async () => 'sent' as const),
    };
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  describe('session.start', () => {
    const worktreeStart = (provider: 'codex' | 'nanogpt' = 'codex') => {
      const cwd = path.join(worktrees, 'PM', 'own');
      return start({
        provider,
        cwd,
        policy: {
          ...policy({
            placement: { kind: 'task_worktree', path: cwd },
            filesystem: { readableRoots: [cwd], writableRoots: [] },
            permissions: { sandbox: 'read-only' },
          }),
          access: 'task_worktree',
        },
        sandbox: sandbox({
          allowWrite: [],
          allowRead: [cwd],
          portable: {
            allowWrite: [],
            env: {},
            readBoundary: {
              deniedRoots: [],
              allowedPaths: [{ path: cwd, kind: 'directory' }],
            },
          },
        }),
      });
    };

    it.each(['codex', 'nanogpt'] as const)(
      'keeps the existing %s worktree start when the optional boundary is absent',
      async (provider) => {
        const input = worktreeStart(provider);
        const checked = await make().check('session.start', { ...input, sandbox: undefined } as never);
        expect(checked.sandbox?.portable?.readBoundary).toBeUndefined();
        expect(checked.policy?.filesystem.deniedPaths).toContain(path.join(home, 'secret'));
      },
    );

    it('adds its own homes while preserving an own checkout underneath app home', async () => {
      const input = worktreeStart();
      const checked = await make().check('session.start', input as never);
      expect(checked.sandbox?.portable?.readBoundary).toEqual({
        deniedRoots: [userHome, home],
        allowedPaths: [{ path: input.cwd, kind: 'directory' }],
      });
    });

    it('closes the Claude transcripts for a Claude session with a boundary, and keeps only the engine’s own copy of it (PM-425)', async () => {
      const input = { ...worktreeStart(), provider: 'claude' as const };
      const hubCopy = { deniedRoots: [], allowedPaths: [{ path: outside, kind: 'directory' as const }] };
      const checked = await make().check('session.start', {
        ...input,
        policy: {
          ...input.policy,
          filesystem: { ...input.policy.filesystem, readBoundary: hubCopy },
        },
      } as never);
      const transcripts = path.join(userHome, '.claude', 'projects');
      expect(checked.sandbox?.denyRead).toContain(transcripts);
      expect(checked.policy?.filesystem.deniedPaths).toContain(transcripts);
      expect(checked.policy?.filesystem.readBoundary).toEqual(checked.sandbox?.portable?.readBoundary);
      expect(checked.policy?.filesystem.readBoundary?.allowedPaths).not.toContainEqual({
        path: outside,
        kind: 'directory',
      });
    });

    it('rejects an explicitly malformed boundary for a read-only placement', async () => {
      await refused(
        make(),
        'session.start',
        start({
          provider: 'codex',
          policy: { ...policy(), access: 'read_only' },
          sandbox: sandbox({ portable: { allowWrite: [], env: {}, readBoundary: null } }),
        }),
        'invalid_params',
      );
    });

    it.each([false, true])(
      'checks private writable directories against engine roots (shared=%s)',
      async (shared) => {
        const input = worktreeStart();
        const tmp = shared ? paths().sessionTmpRoot! : path.join(paths().sessionTmpRoot!, 'own');
        const folder = path.join(paths().sessionFoldersRoot!, 'own');
        const request = {
          ...input,
          policy: {
            ...policy({
              placement: { kind: 'task_worktree', path: input.cwd },
              filesystem: { readableRoots: [input.cwd] },
            }),
            access: 'task_worktree',
          },
          sandbox: sandbox({
            allowWrite: [folder],
            portable: {
              allowWrite: [folder],
              env: { PROJECTMAN_SESSION_DIR: folder },
              tmpDir: tmp,
              readBoundary: {
                deniedRoots: [],
                allowedPaths: [input.cwd, tmp, folder].map((path) => ({ path, kind: 'directory' })),
              },
            },
          }),
        };
        if (shared) await refused(make(), 'session.start', request, 'path_outside_roots');
        else {
          const checked = await make().check('session.start', request as never);
          expect(checked.sandbox?.portable?.tmpDir).toBe(tmp);
          expect(checked.sandbox?.portable?.readBoundary?.deniedRoots).toEqual(
            expect.arrayContaining([userHome, home]),
          );
        }
      },
    );

    it.each(['home', 'collector', 'symlink', 'relative'] as const)(
      'refuses a %s boundary exception',
      async (variant) => {
        const input = worktreeStart();
        const link = path.join(worktrees, 'escape');
        symlinkSync(outside, link);
        const target =
          variant === 'home'
            ? userHome
            : variant === 'collector'
              ? worktrees
              : variant === 'symlink'
                ? link
                : 'relative';
        const changed = {
          ...input,
          sandbox: sandbox({
            allowWrite: [],
            portable: {
              allowWrite: [],
              env: {},
              readBoundary: {
                deniedRoots: [],
                allowedPaths: [{ path: target, kind: 'directory' }],
              },
            },
          }),
        };
        await refused(
          make(),
          'session.start',
          changed,
          variant === 'relative' ? 'invalid_params' : 'path_outside_roots',
        );
      },
    );

    it('drops optional exceptions that physically point into engine secrets', async () => {
      const input = worktreeStart();
      const link = path.join(worktrees, 'key-link');
      symlinkSync(path.join(home, 'secret'), link);
      const checked = await make().check('session.start', {
        ...input,
        sandbox: sandbox({
          allowWrite: [link],
          allowRead: [input.cwd, link],
          portable: {
            allowWrite: [link],
            env: {},
            readBoundary: {
              deniedRoots: [],
              allowedPaths: [
                { path: input.cwd, kind: 'directory' },
                { path: link, kind: 'file' },
              ],
            },
          },
        }),
      } as never);
      expect(checked.sandbox?.portable?.readBoundary?.allowedPaths).toEqual([
        { path: input.cwd, kind: 'directory' },
      ]);
      expect(checked.sandbox?.allowRead).toEqual([input.cwd]);
      expect(checked.sandbox?.allowWrite).toEqual([]);
      expect(checked.sandbox?.portable?.allowWrite).toEqual([]);
    });

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

    describe('the paths of a policy', () => {
      const gitDir = () => path.join(repo, '.git');
      const taskWorktree = (overrides: Record<string, unknown> = {}) => ({
        kind: 'task_worktree',
        path: path.join(worktrees, 'PM', 'PM-1'),
        gitDir: gitDir(),
        worktreeGitDir: path.join(gitDir(), 'worktrees', 'PM-1'),
        ...overrides,
      });
      const reviewCopy = (overrides: Record<string, unknown> = {}) => ({
        kind: 'review_copy',
        path: path.join(worktrees, 'PM', 'review'),
        gitDir: path.join(worktrees, 'PM', 'review.git'),
        ...overrides,
      });

      it('accepts the paths of a task worktree and of a review copy under the engine’s roots', async () => {
        const limit = make();
        await expect(
          limit.check('session.start', start({ policy: policy({ placement: taskWorktree() }) }) as never),
        ).resolves.toBeDefined();
        await expect(
          limit.check(
            'session.start',
            start({
              policy: policy({
                placement: reviewCopy({ cacheDir: path.join(home, 'member-caches', 'c') }),
                filesystem: { sessionFoldersRoot: path.join(home, 'session-folders') },
              }),
            }) as never,
          ),
        ).resolves.toBeDefined();
      });

      it('accepts a merge-fix worktree on an engine with member workspaces', async () => {
        const limit = make({}, { workspacesRoot: path.join(home, 'workspaces') });
        const fix = path.join(worktrees, 'PM', '_merge-fix', 'PM-1-projectman');
        const placement = taskWorktree({ path: fix, mergeFix: { branch: 'merge-fix/PM-1' } });
        const result = await limit.check(
          'session.start',
          start({
            cwd: fix,
            policy: policy({ placement, filesystem: { readableRoots: [fix], writableRoots: [fix] } }),
          }) as never,
        );
        expect(result).toMatchObject({ cwd: fix, policy: { placement } });
      });

      it('lets a task session read its card’s attachments cache, and only that cache (PM-667)', async () => {
        const limit = make();
        const cache = path.join(home, 'attachments-cache', 'PM', 'PM-1');
        await expect(
          limit.check(
            'session.start',
            start({
              policy: policy({ placement: taskWorktree(), filesystem: { readOnlyPaths: [cache] } }),
            }) as never,
          ),
        ).resolves.toBeDefined();
        // The cache is read, never a place to work in: it is not a working directory root.
        await refused(
          limit,
          'session.start',
          start({ cwd: cache, policy: policy({ placement: taskWorktree() }) }),
          'path_outside_roots',
        );
      });

      it.each([
        ['a readable root', () => ({ filesystem: { readableRoots: [repo, userHome] } })],
        ['a read-only path', () => ({ filesystem: { readOnlyPaths: [path.join(userHome, '.ssh')] } })],
        ['the session folders root', () => ({ filesystem: { sessionFoldersRoot: userHome } })],
        ['the session folder', () => ({ filesystem: { sessionFolder: outside } })],
        ['the placement', () => ({ placement: { path: outside } })],
        ['the git directory of a review copy', () => ({ placement: reviewCopy({ gitDir: userHome }) })],
        ['its cache directory', () => ({ placement: reviewCopy({ cacheDir: userHome }) })],
        ['its temporary directory', () => ({ placement: reviewCopy({ tempDir: outside }) })],
      ])('refuses %s outside the roots', async (_name, overrides) => {
        await refused(
          make(),
          'session.start',
          start({ policy: policy(overrides() as never) }),
          'path_outside_roots',
        );
      });

      it('takes the git directories of a task worktree only from a registered repo', async () => {
        const limit = make();
        const refusedPlacement = (placement: Record<string, unknown>) =>
          refused(limit, 'session.start', start({ policy: policy({ placement }) }), 'path_outside_roots');
        // Another place under the roots, but not a registered repo’s git directory.
        await refusedPlacement(taskWorktree({ gitDir: path.join(worktrees, 'other.git') }));
        // The worktree’s admin directory must lie in the repository’s own `worktrees` folder.
        await refusedPlacement(taskWorktree({ worktreeGitDir: path.join(worktrees, 'admin') }));
        await refusedPlacement(taskWorktree({ gitDir: undefined }));
        // A link out of the roots does not pass as the repository’s git directory.
        symlinkSync(userHome, path.join(workspace, 'escape'));
        await refusedPlacement(taskWorktree({ gitDir: path.join(workspace, 'escape') }));
      });
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
      expect(given.sandbox.denyWrite).toContain(path.join(userHome, '.ssh'));
      expect(given.sandbox.denyWrite).toContain(path.join(userHome, '.claude', 'settings.json'));
      expect(given.sandbox.deniedEnvVars.length).toBeGreaterThan(0);
      const built = (await limit.check('session.start', start() as never)) as {
        sandbox: { allowWrite: string[]; denyRead: string[] };
      };
      expect(built.sandbox.allowWrite).toContain(repo);
      expect(built.sandbox.denyRead).toContain(path.join(userHome, '.ssh'));
    });

    describe('the user’s own files under the home folder (PM-731)', () => {
      const excludes = () => path.join(userHome, 'global-ignore');
      const reads = () => [
        path.join(userHome, '.gitconfig'),
        path.join(userHome, '.config', 'git'),
        path.join(userHome, '.claude', 'shell-snapshots'),
        excludes(),
      ];
      beforeEach(() => {
        mkdirSync(path.join(userHome, '.config', 'git'), { recursive: true });
        mkdirSync(path.join(userHome, '.claude', 'shell-snapshots'), { recursive: true });
        mkdirSync(path.join(userHome, '.ssh'), { recursive: true });
        writeFileSync(excludes(), '*.log\n');
        writeFileSync(path.join(userHome, '.gitconfig'), `[core]\n\texcludesfile = ${excludes()}\n`);
      });

      it('reads the three home places and the global excludes file, in every read position', async () => {
        const limit = make();
        for (const file of reads()) {
          await expect(
            limit.check('session.start', start({ sandbox: sandbox({ allowRead: [file] }) }) as never),
          ).resolves.toBeDefined();
          await expect(
            limit.check(
              'session.start',
              start({
                policy: policy({ filesystem: { readableRoots: [repo, file], readOnlyPaths: [file] } }),
              }) as never,
            ),
          ).resolves.toBeDefined();
          await expect(limit.check('host.realpath', { path: file } as never)).resolves.toBeDefined();
        }
      });

      it('never writes them, nor the home as a whole, nor another place under it', async () => {
        const limit = make();
        for (const file of [
          ...reads(),
          userHome,
          path.join(userHome, '.claude'),
          path.join(userHome, '.ssh'),
        ]) {
          await refused(limit, 'session.start', start({ cwd: file }), 'path_outside_roots');
          await refused(
            limit,
            'session.start',
            start({ sandbox: sandbox({ allowWrite: [file] }) }),
            'path_outside_roots',
          );
          await refused(
            limit,
            'session.start',
            start({ sandbox: sandbox({ portable: { allowWrite: [file] } }) }),
            'path_outside_roots',
          );
          await refused(
            limit,
            'session.start',
            start({ additionalDirectories: [file] }),
            'path_outside_roots',
          );
          await refused(limit, 'session.start', start({ writableRoots: [file] }), 'path_outside_roots');
          await refused(
            limit,
            'session.start',
            start({ policy: policy({ filesystem: { writableRoots: [file] } }) }),
            'path_outside_roots',
          );
          await refused(
            limit,
            'session.start',
            start({ policy: policy({ placement: { path: file } }) }),
            'path_outside_roots',
          );
          await refused(limit, 'host.prepare_portable_paths', { paths: [file] }, 'path_outside_roots');
        }
      });

      it('reads no other place under the home', async () => {
        const limit = make();
        for (const other of [
          userHome,
          path.join(userHome, '.claude'),
          path.join(userHome, '.claude', 'settings.json'),
          path.join(userHome, '.config'),
          path.join(userHome, '.ssh', 'id_rsa'),
        ])
          await refused(
            limit,
            'session.start',
            start({ sandbox: sandbox({ allowRead: [other] }) }),
            'path_outside_roots',
          );
      });

      it('does not follow a link to a credential place, nor an excludes file that is one', async () => {
        const target = path.join(userHome, '.ssh');
        rmSync(path.join(userHome, '.claude', 'shell-snapshots'), { recursive: true });
        symlinkSync(target, path.join(userHome, '.claude', 'shell-snapshots'));
        writeFileSync(path.join(target, 'id_rsa'), 'key');
        writeFileSync(path.join(userHome, '.gitconfig'), `[core]\n\texcludesfile = ${target}/id_rsa\n`);
        const limit = make();
        for (const file of [
          path.join(userHome, '.claude', 'shell-snapshots'),
          path.join(userHome, '.claude', 'shell-snapshots', 'id_rsa'),
          path.join(target, 'id_rsa'),
        ])
          await refused(
            limit,
            'session.start',
            start({ sandbox: sandbox({ allowRead: [file] }) }),
            'path_outside_roots',
          );
        // The reads of the user's real files stay.
        await expect(
          limit.check(
            'session.start',
            start({ sandbox: sandbox({ allowRead: [path.join(userHome, '.gitconfig')] }) }) as never,
          ),
        ).resolves.toBeDefined();
      });
    });

    describe('the denials of a write (PM-731)', () => {
      const denied = async (limit: EngineLimit, denyWrite: string[]) =>
        (
          (await limit.check('session.start', start({ sandbox: sandbox({ denyWrite }) }) as never)) as {
            sandbox: { denyWrite: string[] };
          }
        ).sandbox.denyWrite;
      const names = () => ['', '-wal', '-shm', '-journal'].map((end) => path.join(home, `db.sqlite${end}`));

      it('names the four database files and holds no database pattern, whatever the cloud sent', async () => {
        const limit = make();
        for (const incoming of [
          [],
          [path.join(home, 'db.sqlite*')],
          [path.join(home, 'db.sqlite*'), '/x/y*'],
        ]) {
          const list = await denied(limit, incoming);
          expect(list).toEqual(expect.arrayContaining(names()));
          expect(list.filter((entry) => /db\.sqlite\*$/.test(entry))).toEqual([]);
          expect(list.filter((entry) => entry.startsWith(path.join(home, 'db.sqlite')))).toHaveLength(4);
        }
        const built = (await limit.check('session.start', start() as never)) as {
          sandbox: { denyWrite: string[] };
        };
        expect(built.sandbox.denyWrite).toEqual(expect.arrayContaining(names()));
        expect(built.sandbox.denyWrite.filter((entry) => entry.endsWith('*'))).toEqual([]);
      });

      it('leaves any other entry of the cloud as it was, wildcard or not', async () => {
        const list = await denied(make(), ['/x/y*', '/x/*.lock', '/x/plain']);
        expect(list).toEqual(expect.arrayContaining(['/x/y*', '/x/*.lock', '/x/plain']));
      });

      it('applies to a screenshot run as well', async () => {
        const run = (await make().check('screenshots.run', {
          spec: {
            cwd: repo,
            sessionDir: path.join(home, 'session-folders', 's'),
            args: [path.join(repo, 'scenario.json')],
            sandbox: {
              allowRead: [],
              allowWrite: [],
              denyRead: [],
              denyWrite: [path.join(home, 'db.sqlite*')],
            },
          },
        } as never)) as { spec: { sandbox: { denyWrite: string[] } } };
        expect(run.spec.sandbox.denyWrite).toEqual(expect.arrayContaining(names()));
        expect(run.spec.sandbox.denyWrite.filter((entry) => entry.endsWith('*'))).toEqual([]);
      });
    });

    describe('the engine’s own secrets', () => {
      const keyFile = () => path.join(home, 'engine.key');
      const headersFile = () => path.join(base, 'keys', 'headers.json');
      const withHeaders = () => make({ linkHeadersFile: headersFile() });

      it('never lets a session read or change the machine key and the link headers', async () => {
        const given = (await withHeaders().check(
          'session.start',
          start({ sandbox: sandbox() }) as never,
        )) as { sandbox: { denyRead: string[]; denyWrite: string[] } };
        for (const file of [keyFile(), headersFile()]) {
          expect(given.sandbox.denyRead).toContain(file);
          expect(given.sandbox.denyWrite).toContain(file);
        }
        const built = (await withHeaders().check('session.start', start() as never)) as {
          sandbox: { denyRead: string[]; denyWrite: string[] };
        };
        expect(built.sandbox.denyRead).toContain(keyFile());
        expect(built.sandbox.denyWrite).toContain(headersFile());
      });

      it('lets a session read but never change the configuration and the status file', async () => {
        const given = (await make().check('session.start', start({ sandbox: sandbox() }) as never)) as {
          sandbox: { denyRead: string[]; denyWrite: string[] };
        };
        for (const file of [path.join(home, 'engine.json'), path.join(home, 'engine-status.json')]) {
          expect(given.sandbox.denyWrite).toContain(file);
          expect(given.sandbox.denyRead).not.toContain(file);
        }
      });

      it('puts them in the denied paths of a policy', async () => {
        const result = (await withHeaders().check(
          'session.start',
          start({ provider: 'codex', policy: policy() }) as never,
        )) as { policy: { filesystem: { deniedPaths: string[] } } };
        expect(result.policy.filesystem.deniedPaths).toEqual(
          expect.arrayContaining([keyFile(), headersFile(), path.join(userHome, '.ssh')]),
        );
      });

      it.each(['claude', 'codex', 'nanogpt', 'gemini'])(
        'refuses a %s session without a policy, and accepts it with one',
        async (provider) => {
          const limit = make();
          await refused(limit, 'session.start', start({ provider, policy: undefined }), 'invalid_params');
          await expect(
            limit.check('session.start', start({ provider, policy: policy() }) as never),
          ).resolves.toBeDefined();
        },
      );
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
    it('binds every merge-fix operation to the registered engine repository and rejects ref injection', async () => {
      const limit = make();
      for (const method of [
        'worktree.ensureMergeFix',
        'worktree.findMergeFix',
        'worktree.removeMergeFix',
        'worktree.listMergeFixes',
      ] as const) {
        const [arg] = await limit.check(method, [
          { project: projectConfig(), repoName: 'projectman', taskKey: 'PM-1', commit: 'a'.repeat(40) },
        ] as never);
        expect(arg.project.project.workspacePath).toBe(workspace);
        expect(arg.project.project.repos[0]!.path).toBe(repo);
        await refused(
          limit,
          method,
          [{ project: projectConfig('other'), repoName: 'other', taskKey: 'PM-1', commit: 'a'.repeat(40) }],
          'repo_not_registered',
        );
      }
      await refused(
        limit,
        'worktree.ensureMergeFix',
        [{ project: projectConfig(), repoName: 'projectman', taskKey: 'PM-1', commit: '--help' }],
        'invalid_params',
      );
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

    it('binds dependency preparation to the engine repository and exposes only copies of its read denials', async () => {
      const limit = make({ linkHeadersFile: path.join(home, 'link-headers.json') });
      const key = { project: projectConfig(), repoName: 'projectman', member: 'dev' };
      const [bound] = await limit.check('workspace.prepareDependencies', [key] as never);
      expect(bound.project.project.workspacePath).toBe(workspace);
      expect(bound.project.project.repos[0]?.path).toBe(repo);
      await refused(
        limit,
        'workspace.prepareDependencies',
        [{ ...key, repoName: 'other' }],
        'repo_not_registered',
      );
      await refused(
        limit,
        'workspace.prepareDependencies',
        [{ ...key, project: { project: { key: 'XX' } } }],
        'repo_not_registered',
      );
      const sensitive = limit.sensitiveRead();
      expect(sensitive).toContain(path.join(home, 'engine.key'));
      expect(sensitive).toContain(path.join(home, 'link-headers.json'));
      expect(sensitive).toContain(path.join(userHome, '.ssh'));
      sensitive.length = 0;
      expect(limit.sensitiveRead().length).toBeGreaterThan(0);
    });

    it('hands a task commit over only for a registered repo and a full object id (PM-739)', async () => {
      const limit = make();
      const key = { project: projectConfig(), repoName: 'projectman', member: 'dev' };
      const commit = 'a'.repeat(40);
      const [arg, taskKey, branch, handed] = (await limit.check('workspace.publishTaskBranch', [
        key,
        'PM-1',
        'PM-1-work',
        commit,
      ] as never)) as unknown as [
        { project: { project: { workspacePath: string; repos: Array<{ path: string }> } } },
        string,
        string,
        string,
      ];
      expect(arg.project.project.workspacePath).toBe(workspace);
      expect(arg.project.project.repos[0]!.path).toBe(repo);
      expect([taskKey, branch, handed]).toEqual(['PM-1', 'PM-1-work', commit]);
      for (const bad of ['--help', 'refs/heads/main', 'a'.repeat(12), `${commit}\n`]) {
        await refused(
          limit,
          'workspace.publishTaskBranch',
          [key, 'PM-1', 'PM-1-work', bad],
          'invalid_params',
        );
      }
      await refused(
        limit,
        'workspace.publishTaskBranch',
        [{ project: projectConfig('other'), repoName: 'other', member: 'dev' }, 'PM-1', 'PM-1-work', commit],
        'repo_not_registered',
      );
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
        make({ repos: [{ project: 'PM', repo: 'projectman', path: repo, workspaceSetup: null }] }),
        'full_test.run',
        fullTest(),
        'command_not_allowed',
      );
      await refused(limit, 'full_test.run', fullTest({ cwd: outside }), 'path_outside_roots');
    });

    it('passes the dependency preparation request of a registered merge repo on, and refuses others (PM-681)', async () => {
      const ref = { projectKey: 'PM', repo: 'projectman' };
      const npmCi = { ref, mergeId: newId('merge') };
      const cwd = path.join(worktrees, '_merge', npmCi.mergeId);
      mkdirSync(cwd, { recursive: true });
      const limit = make({
        repos: [
          {
            project: 'PM',
            repo: 'projectman',
            path: repo,
            fullTestCommand: 'npm test',
            mergeBranch: 'main',
            workspaceSetup: null,
          },
        ],
      });
      const result = (await limit.check(
        'full_test.run',
        fullTest({ npmCi, cwd, requireHeavyLock: true }) as never,
      )) as {
        spec: { npmCi?: unknown };
      };
      expect(result.spec.npmCi).toEqual(npmCi);
      await refused(
        limit,
        'full_test.run',
        fullTest({ npmCi: { ref: { projectKey: 'XX', repo: 'nope' }, mergeId: npmCi.mergeId } }),
        'repo_not_registered',
      );
      await refused(limit, 'full_test.run', fullTest({ npmCi: { ref, mergeId: '../x' } }), 'invalid_params');
      for (const overrides of [{ cwd: repo }, { requireHeavyLock: false }, { requireHeavyLock: undefined }]) {
        await refused(
          limit,
          'full_test.run',
          fullTest({ npmCi, cwd, requireHeavyLock: true, ...overrides }),
          'invalid_params',
        );
      }
      const alias = path.join(worktrees, '_merge', newId('merge'));
      symlinkSync(cwd, alias);
      await refused(
        limit,
        'full_test.run',
        fullTest({ npmCi: { ref, mergeId: path.basename(alias) }, cwd: alias, requireHeavyLock: true }),
        'invalid_params',
      );
      const wrongCommand = make({
        repos: [
          {
            project: 'PM',
            repo: 'projectman',
            path: repo,
            fullTestCommand: 'npm run check',
            mergeBranch: 'main',
            workspaceSetup: null,
          },
          {
            project: 'PM',
            repo: 'other',
            path: workspace,
            fullTestCommand: 'npm test',
            mergeBranch: 'main',
            workspaceSetup: null,
          },
        ],
      });
      await refused(
        wrongCommand,
        'full_test.run',
        fullTest({ npmCi, cwd, requireHeavyLock: true }),
        'command_not_allowed',
      );
      await refused(
        make(),
        'full_test.run',
        fullTest({ npmCi, cwd, requireHeavyLock: true }),
        'merge_not_allowed',
      );
    });

    it('passes a GitHub Actions merge check on without a checkout path, and refuses a wrong one (PM-915)', async () => {
      const ref = { projectKey: 'PM', repo: 'projectman' };
      const githubActions = {
        ref,
        mergeId: newId('merge'),
        repo: 'owner/projectman',
        base: 'main',
        commit: 'a'.repeat(40),
        workflow: 'merge-check.yml',
      };
      const check = (overrides: Record<string, unknown> = {}) =>
        fullTest({ cwd: 'github-actions:owner/projectman', githubActions, ...overrides });
      const limit = make({
        repos: [
          {
            project: 'PM',
            repo: 'projectman',
            path: repo,
            fullTestCommand: 'npm test',
            mergeBranch: 'main',
            workspaceSetup: null,
          },
        ],
      });
      await expect(limit.check('full_test.run', check() as never)).resolves.toBeDefined();
      // A review pin's full mode (PM-909) is the same one commit to the same one branch.
      await expect(
        limit.check('full_test.run', check({ githubActions: { ...githubActions, all: true } }) as never),
      ).resolves.toBeDefined();
      await refused(
        limit,
        'full_test.run',
        check({ githubActions: { ...githubActions, base: 'dev' } }),
        'merge_not_allowed',
      );
      await refused(
        limit,
        'full_test.run',
        check({ githubActions: { ...githubActions, commit: 'main' } }),
        'invalid_params',
      );
      await refused(limit, 'full_test.run', check({ cwd: repo }), 'invalid_params');
      await refused(limit, 'full_test.run', check({ requireHeavyLock: true }), 'invalid_params');
    });

    it('keeps the engine’s key and configuration out of the test and screenshot sandboxes', async () => {
      const limit = make({ linkHeadersFile: path.join(base, 'keys', 'headers.json') });
      type Denials = { spec: { sandbox: { denyRead: string[]; denyWrite?: string[] } } };
      const test = (await limit.check('full_test.run', fullTest() as never)) as unknown as Denials;
      const shot = (await limit.check('screenshots.run', shots() as never)) as unknown as Denials;
      for (const { spec } of [test, shot])
        expect(spec.sandbox.denyRead).toEqual(
          expect.arrayContaining([
            path.join(home, 'engine.key'),
            path.join(base, 'keys', 'headers.json'),
            path.join(userHome, '.ssh'),
          ]),
        );
      // The test writes only its run directory; the screenshots keep the configuration read-only too.
      expect(shot.spec.sandbox.denyWrite).toEqual(
        expect.arrayContaining([path.join(home, 'engine.key'), path.join(home, 'engine.json')]),
      );
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

    it('puts a message file only into the folder of a session this engine made one for, by a plain name (PM-518)', async () => {
      const limit = make();
      const params = (name: string, extra: Record<string, unknown> = {}) => ({
        sessionId: 's1',
        name,
        downloadToken: TOKEN,
        sha256: 'a'.repeat(64),
        size: 10,
        ...extra,
      });
      await refused(limit, 'files.materialize_into_session', params('msa_1-a.pdf'), 'invalid_params');
      await limit.check('folders.make', {
        sessionId: 's1',
        dir: path.join(home, 'session-folders', 's1'),
      } as never);
      await expect(
        limit.check('files.materialize_into_session', params('msa_1-a.pdf') as never),
      ).resolves.toBeDefined();
      for (const name of ['../x', 'a/b', '..', '.', '', 'a\\b', 'x\0y', 'x'.repeat(256)])
        await refused(limit, 'files.materialize_into_session', params(name), 'invalid_params');
      await refused(
        limit,
        'files.materialize_into_session',
        params('a.pdf', { sessionId: 's2' }),
        'invalid_params',
      );
      await refused(
        limit,
        'files.materialize_into_session',
        params('a.pdf', { downloadToken: 'short' }),
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

  describe('merge.*', () => {
    const ref = { projectKey: 'PM', repo: 'projectman' };
    const sha = 'a'.repeat(40);
    const other = 'b'.repeat(40);
    const mergeId = newId('merge'); // what the domain makes, not a hand-written id (PM-551)
    const merging = (overrides: Partial<ResolvedEngineConfig> = {}) =>
      make({
        repos: [
          {
            project: 'PM',
            repo: 'projectman',
            path: repo,
            fullTestCommand: 'npm test',
            mergeBranch: 'main',
            workspaceSetup: null,
          },
        ],
        ...overrides,
      });

    it('accepts well-formed calls for a repo with a mergeBranch', async () => {
      const limit = merging();
      const calls: [EngineMethod, Record<string, unknown>][] = [
        ['merge.prepare', { ref, base: 'main', commit: sha }],
        ['merge.is_ancestor', { ref, ancestor: sha, commit: other }],
        ['merge.build', { ref, onto: sha, commit: other, message: 'Merge PM-1' }],
        ['merge.checkout_conflicts', { ref, base: 'main', changed: ['a.txt'] }],
        ['merge.checkout_for_check', { ref, mergeId, mergeCommit: sha, depsFrom: repo }],
        ['merge.checkout_for_check', { ref, mergeId, mergeCommit: sha, depsFrom: null }],
        [
          'merge.checkout_for_check',
          { ref, mergeId, mergeCommit: sha, depsFrom: null, allowDependencyInstall: true },
        ],
        [
          'merge.checkout_for_check',
          { ref, mergeId, mergeCommit: sha, depsFrom: path.join(worktrees, 'PM-1') },
        ],
        ['merge.release_check', { ref, mergeId }],
        ['merge.push', { ref, base: 'main', mergeCommit: sha }],
        ['merge.remote_tags', { ref, base: 'main' }],
        ['merge.push_tag', { ref, base: 'main', tag: 'v2026.1.2', commit: sha }],
        ['merge.advance', { ref, base: 'main', from: sha, to: other }],
        ['merge.read_file', { ref, at: { commit: sha }, path: 'docs/decisions.md' }],
        ['merge.read_file', { ref, at: { base: 'main' }, path: 'ROADMAP.md' }],
        ['merge.list_paths', { ref, base: 'main' }],
        [
          'merge.changed_paths',
          {
            ref,
            base: 'main',
            items: [
              { id: 'PM-1', at: { branch: 'PM-1-card' } },
              { id: 'PM-2', at: { commit: sha } },
              { id: 'PM-3', at: { merge: other } },
            ],
          },
        ],
        [
          'merge.commit_files',
          { ref, onto: sha, files: [{ path: 'docs/a.md', text: 'x' }], message: 'Docs' },
        ],
        [
          'merge.commit_files',
          {
            ref,
            onto: sha,
            files: [
              { path: 'a.md', text: 'x'.repeat(1024 * 1024) },
              { path: 'b.md', text: '' },
            ],
            message: 'Docs',
          },
        ],
      ];
      for (const [method, params] of calls)
        await expect(limit.check(method, params as never), method).resolves.toBeDefined();
    });

    it('refuses a document read or commit with a bad path, too much text, too many files or a bad id', async () => {
      const limit = merging();
      for (const bad of ['/abs', '../x', 'a/../b', '.git/config', 'a\\b', '', 'a//b', './a', 'a\0b']) {
        await refused(limit, 'merge.read_file', { ref, at: { commit: sha }, path: bad }, 'invalid_params');
        await refused(
          limit,
          'merge.commit_files',
          { ref, onto: sha, files: [{ path: bad, text: 'x' }], message: 'm' },
          'invalid_params',
        );
      }
      const commit = (files: { path: string; text: string }[], message = 'm', onto = sha) =>
        refused(limit, 'merge.commit_files', { ref, onto, files, message }, 'invalid_params');
      await commit([{ path: 'a.md', text: 'x'.repeat(1024 * 1024 + 1) }]);
      await commit([{ path: 'a.md', text: 'é'.repeat(600 * 1024) }]); // under 1 MiB in characters, over in bytes
      await commit([{ path: 'a.md', text: 'a\0b' }]);
      await commit([]);
      await commit([
        { path: 'a.md', text: '' },
        { path: 'b.md', text: '' },
        { path: 'c.md', text: '' },
      ]);
      await commit([
        { path: 'a.md', text: '1' },
        { path: 'a.md', text: '2' },
      ]);
      await commit([{ path: 'a.md', text: 'x' }], '   ');
      await commit([{ path: 'a.md', text: 'x' }], 'a\0b');
      await commit([{ path: 'a.md', text: 'x' }], 'm', 'main');
      await refused(
        limit,
        'merge.read_file',
        { ref, at: { commit: 'main' }, path: 'a.md' },
        'invalid_params',
      );
      await refused(limit, 'merge.read_file', { ref, at: { base: '--x' }, path: 'a.md' }, 'invalid_params');
      await refused(
        limit,
        'merge.read_file',
        { ref, at: { base: 'develop' }, path: 'a.md' },
        'merge_not_allowed',
      );
    });

    it('refuses a path read with a bad base, branch name or commit id', async () => {
      const limit = merging();
      await refused(limit, 'merge.list_paths', { ref, base: '--x' }, 'invalid_params');
      await refused(limit, 'merge.list_paths', { ref, base: 'develop' }, 'merge_not_allowed');
      const changed = (base: string, at: Record<string, string>) =>
        refused(limit, 'merge.changed_paths', { ref, base, items: [{ id: 'PM-1', at }] }, 'invalid_params');
      await changed('--x', { branch: 'a' });
      for (const branch of ['--x', 'HEAD', 'a..b', '@{-1}', 'a b', '']) await changed('main', { branch });
      await changed('main', { commit: 'main' });
      await changed('main', { merge: 'main' });
      await changed('main', { merge: 'HEAD^1' });
      await refused(
        limit,
        'merge.changed_paths',
        {
          ref,
          base: 'develop',
          items: [{ id: 'PM-1', at: { commit: sha } }],
        },
        'merge_not_allowed',
      );
    });

    it('refuses every call for a repo without a mergeBranch', async () => {
      const limit = make();
      const calls: [EngineMethod, Record<string, unknown>][] = [
        ['merge.prepare', { ref, base: 'main', commit: sha }],
        ['merge.is_ancestor', { ref, ancestor: sha, commit: other }],
        ['merge.build', { ref, onto: sha, commit: other, message: 'm' }],
        ['merge.checkout_conflicts', { ref, base: 'main', changed: [] }],
        ['merge.checkout_for_check', { ref, mergeId, mergeCommit: sha, depsFrom: null }],
        ['merge.release_check', { ref, mergeId }],
        ['merge.push', { ref, base: 'main', mergeCommit: sha }],
        ['merge.remote_tags', { ref, base: 'main' }],
        ['merge.push_tag', { ref, base: 'main', tag: 'v1', commit: sha }],
        ['merge.advance', { ref, base: 'main', from: sha, to: other }],
        ['merge.read_file', { ref, at: { base: 'main' }, path: 'a.md' }],
        ['merge.read_file', { ref, at: { commit: sha }, path: 'a.md' }],
        ['merge.commit_files', { ref, onto: sha, files: [{ path: 'a.md', text: 'x' }], message: 'm' }],
        ['merge.list_paths', { ref, base: 'main' }],
        ['merge.changed_paths', { ref, base: 'main', items: [] }],
      ];
      for (const [method, params] of calls) await refused(limit, method, params, 'merge_not_allowed');
    });

    it('refuses an unregistered repo or project', async () => {
      const limit = merging();
      await refused(
        limit,
        'merge.prepare',
        { ref: { projectKey: 'PM', repo: 'other' }, base: 'main', commit: sha },
        'repo_not_registered',
      );
      await refused(
        limit,
        'merge.release_check',
        { ref: { projectKey: 'XX', repo: 'projectman' }, mergeId },
        'repo_not_registered',
      );
    });

    it('refuses any base but the configured mergeBranch, and bases that are not branch names', async () => {
      const limit = merging();
      for (const base of ['develop', 'release/1', 'refs/heads/main'])
        await refused(limit, 'merge.push', { ref, base, mergeCommit: sha }, 'merge_not_allowed');
      for (const base of ['HEAD', '--upload-pack=x', '@{-1}', 'a b', '']) {
        await refused(limit, 'merge.prepare', { ref, base, commit: sha }, 'invalid_params');
        await refused(limit, 'merge.advance', { ref, base, from: sha, to: other }, 'invalid_params');
      }
    });

    it('refuses anything that is not a commit id, a merge id or a commit message', async () => {
      const limit = merging();
      await refused(limit, 'merge.prepare', { ref, base: 'main', commit: 'main' }, 'invalid_params');
      await refused(limit, 'merge.push', { ref, base: 'main', mergeCommit: '--force' }, 'invalid_params');
      for (const tag of ['--force', 'a b', '', 'v1..2'])
        await refused(limit, 'merge.push_tag', { ref, base: 'main', tag, commit: sha }, 'invalid_params');
      await refused(
        limit,
        'merge.push_tag',
        { ref, base: 'main', tag: 'v1', commit: 'main' },
        'invalid_params',
      );
      await refused(limit, 'merge.advance', { ref, base: 'main', from: sha, to: 'HEAD' }, 'invalid_params');
      await refused(limit, 'merge.is_ancestor', { ref, ancestor: 'x', commit: sha }, 'invalid_params');
      await refused(
        limit,
        'merge.build',
        { ref, onto: sha, commit: other, message: '   ' },
        'invalid_params',
      );
      await refused(
        limit,
        'merge.build',
        { ref, onto: sha, commit: other, message: 'a\0b' },
        'invalid_params',
      );
      await refused(limit, 'merge.release_check', { ref, mergeId: '../x' }, 'invalid_params');
      await refused(
        limit,
        'merge.checkout_for_check',
        { ref, mergeId: 'x/../y', mergeCommit: sha, depsFrom: null },
        'invalid_params',
      );
      await refused(
        limit,
        'merge.checkout_conflicts',
        { ref, base: 'main', changed: ['a\0b'] },
        'invalid_params',
      );
    });

    it('bounds the dependencies source to the worktrees root or the bound repository', async () => {
      const limit = merging();
      await refused(
        limit,
        'merge.checkout_for_check',
        { ref, mergeId, mergeCommit: sha, depsFrom: outside },
        'path_outside_roots',
      );
      await refused(
        limit,
        'merge.checkout_for_check',
        { ref, mergeId, mergeCommit: sha, depsFrom: userHome },
        'path_outside_roots',
      );
      await refused(
        limit,
        'merge.checkout_for_check',
        { ref, mergeId, mergeCommit: sha, depsFrom: 'relative/path' },
        'path_outside_roots',
      );
    });

    it('lets a full test run in a check checkout under the worktrees root', async () => {
      const check = path.join(worktrees, '_merge', mergeId);
      mkdirSync(check, { recursive: true });
      await expect(
        merging().check('full_test.run', {
          spec: {
            command: 'npm test',
            cwd: check,
            sandbox: { allowRead: [], denyRead: [], denyWrite: [], allowWrite: [] },
          },
        } as never),
      ).resolves.toBeDefined();
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
