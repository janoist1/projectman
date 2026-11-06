import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '@projectman/shared';
import { TeamToolError } from '../src/contracts';
import type { ScreenshotExecutor, ScreenshotRunSpec } from '../src/contracts';
import { buildCodexArgs } from '../src/runner/providers/codex/args';
import { pngBytes } from './helpers/attachments';
import { createDomainHarness, OWNER_ACTOR, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { rejection } from './helpers/errors';

const task = { type: 'task', taskKey: 'AR-1' } as const;

/** The session folder and the own TMPDIR of a Codex session whose sandbox writes (PM-339). */
describe('the session folder and the temporary directory of a Codex session (PM-339)', () => {
  let h: DomainHarness | undefined;
  let base: string;
  let home: string;
  let appHome: string;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'pm-codex-folder-test-')));
    home = join(base, 'user-home');
    appHome = join(base, 'app-home');
    mkdirSync(home);
    mkdirSync(appHome);
  });
  afterEach(async () => {
    await h?.cleanup();
    h = undefined;
    rmSync(base, { recursive: true, force: true });
  });

  const start = async (options: {
    mode?: string;
    tmp?: boolean | string;
    heavyLockDir?: string;
    screenshots?: ScreenshotExecutor;
    persistent?: boolean;
    adjust?: (config: ProjectConfig) => void;
  }) => {
    h = await createDomainHarness({
      userHome: home,
      appHome,
      browsersDir: join(appHome, 'browsers'),
      sessionFolders: true,
      sessionTmp: options.tmp ?? true,
      heavyLockDir: options.heavyLockDir,
      screenshotExecutor: options.screenshots,
      persistent: options.persistent,
      adjust: (config) => {
        const dev = config.team.members.find((m) => m.handle === 'dev-1');
        if (dev?.kind === 'ai') {
          dev.provider = 'codex';
          if (options.mode) dev.permissionMode = options.mode as typeof dev.permissionMode;
        }
        options.adjust?.(config);
      },
    });
    await h.domain.tasks.create('AR', { title: 'Login page', repo: 'web' }, OWNER_ACTOR);
    return h.domain.sessions.ensureSession('AR', 'dev-1', task);
  };

  const portable = () => h!.runner.lastStarted().sandbox!.portable!;
  const mode = (path: string) => statSync(path).mode & 0o777;

  it('gives an acceptEdits session both, made before the process starts and removed when it ends', async () => {
    h = await createDomainHarness({
      userHome: home,
      appHome,
      sessionFolders: true,
      sessionTmp: true,
      heavyLockDir: join(base, 'projectman-501', 'heavy'),
      adjust: (config) => {
        const dev = config.team.members.find((m) => m.handle === 'dev-1');
        if (dev?.kind === 'ai') {
          dev.provider = 'codex';
          dev.permissionMode = 'acceptEdits';
        }
      },
    });
    // What exists at the moment the runner is asked to start the process.
    const seen: { folder: boolean; tmp: boolean; tmpMode: number }[] = [];
    const original = h.runner.start.bind(h.runner);
    h.runner.start = async (spec) => {
      const { tmpDir, env } = spec.sandbox!.portable!;
      seen.push({
        folder: existsSync(env.PROJECTMAN_SESSION_DIR!),
        tmp: existsSync(tmpDir!),
        tmpMode: statSync(tmpDir!).mode & 0o777,
      });
      return original(spec);
    };
    await h.domain.tasks.create('AR', { title: 'Login page', repo: 'web' }, OWNER_ACTOR);
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', task);

    const { env, tmpDir, allowWrite } = portable();
    const folder = env.PROJECTMAN_SESSION_DIR!;
    expect(seen).toEqual([{ folder: true, tmp: true, tmpMode: 0o700 }]);
    expect(folder).toMatch(new RegExp(`^${h.sessionFoldersDir}/${session.id}\\.[0-9a-f]{16}$`));
    expect(tmpDir).toMatch(new RegExp(`^${h.sessionTmpDir}/[0-9a-f]{12}$`));
    // The root is no writable path of any session: not the queue folder's parent either.
    expect(allowWrite).toContain(join(base, 'projectman-501'));
    expect(allowWrite.some((dir) => `${h!.sessionTmpDir}/`.startsWith(`${dir}/`))).toBe(false);
    expect(allowWrite).toContain(folder);
    expect(mode(folder)).toBe(0o700);
    expect(mode(h.sessionTmpDir!)).toBe(0o700);

    writeFileSync(join(tmpDir!, 'scratch'), 'x');
    await h.runner.stop(session.id);
    await h.domain.sessions.settleFolderRemovals();
    expect(existsSync(folder)).toBe(false);
    expect(existsSync(tmpDir!)).toBe(false);
    expect(readdirSync(h.sessionFoldersDir!)).toEqual([]);
    expect(readdirSync(h.sessionTmpDir!)).toEqual([]);
  });

  it('does not start the session when its temporary directory cannot be made', async () => {
    h = await createDomainHarness({
      userHome: home,
      appHome,
      sessionFolders: true,
      sessionTmp: true,
      adjust: (config) => {
        const dev = config.team.members.find((m) => m.handle === 'dev-1');
        if (dev?.kind === 'ai') {
          dev.provider = 'codex';
          dev.permissionMode = 'acceptEdits';
        }
      },
    });
    await h.domain.tasks.create('AR', { title: 'Login page', repo: 'web' }, OWNER_ACTOR);
    // Running as root the directory can be made after all.
    if (process.getuid?.() === 0) return;
    chmodSync(h.sessionTmpDir!, 0o500);
    try {
      const err = await rejection(h.domain.sessions.ensureSession('AR', 'dev-1', task));
      expect(err.message).toMatch(/could not prepare the session folder/);
    } finally {
      chmodSync(h.sessionTmpDir!, 0o700);
    }
  });

  it('puts the folder and the temporary directory into what Codex is started with', async () => {
    await start({ mode: 'acceptEdits' });
    const spec = h!.runner.lastStarted();
    const { env, tmpDir } = portable();
    const folder = env.PROJECTMAN_SESSION_DIR!;
    const { args } = buildCodexArgs({
      spec,
      hookConfigPath: '/run/ses_1.0123456789abcdef/hook.curl',
      mcpConfigPath: '/run/ses_1.0123456789abcdef/codex-mcp.json',
      permissionTimeoutMs: 40_000,
      realCwd: spec.cwd,
    });
    const text = args.join('\n');
    expect(spec.policy!.permissions.sandbox).toBe('workspace-write');
    expect(text).toContain(`shell_environment_policy.set.TMPDIR="${tmpDir}"`);
    expect(text).toContain(`shell_environment_policy.set.PROJECTMAN_SESSION_DIR="${folder}"`);
    const profile = args.find((arg) => arg.startsWith('permissions.projectman='))!;
    expect(profile).toContain(`"${folder}"="write"`);
    expect(profile).toContain(`"${tmpDir}"="write"`);
    expect(profile).not.toContain(':slash_tmp');
    expect(profile).not.toContain(':tmpdir');
    expect(text).not.toContain('sandbox_workspace_write');
    expect(text).toContain('tools.view_image=true');
  });

  it('keeps the screenshot scope of a session with a folder in its worktree until the session ends (PM-351)', async () => {
    const { session } = await start({ mode: 'acceptEdits' });
    const spec = h!.runner.lastStarted();
    const folder = portable().env.PROJECTMAN_SESSION_DIR!;
    const scope = h!.domain.sessions.screenshotScope(session.id);
    expect(scope).toMatchObject({ cwd: spec.cwd, sessionDir: folder });
    expect(scope!.sandbox.allowWrite).toContain(folder);
    expect(scope!.sandbox.allowRead).toContain(spec.cwd);

    // The run stops before the folder goes.
    const seen: boolean[] = [];
    h!.domain.sessions.onFolderRemoved((id) => seen.push(id === session.id && existsSync(folder)));
    await h!.runner.stop(session.id);
    await h!.domain.sessions.settleFolderRemovals();
    expect(seen).toEqual([true]);
    expect(h!.domain.sessions.screenshotScope(session.id)).toBeUndefined();
    expect(existsSync(folder)).toBe(false);
  });

  it('gives a session whose sandbox only reads the folder a scope that writes only the folder (PM-1202)', async () => {
    const { session } = await start({});
    const spec = h!.runner.lastStarted();
    const folder = spec.policy!.filesystem.sessionFolder!;
    const browsers = join(appHome, 'browsers');
    const scope = h!.domain.sessions.screenshotScope(session.id)!;
    expect(scope).toMatchObject({ cwd: spec.cwd, sessionDir: folder, browsersDir: browsers });
    expect(scope.sandbox.allowWrite).toEqual([folder]);
    expect(scope.sandbox.denyWrite).toContain(spec.cwd);
    // The browsers are read although the session's own sandbox was not given them.
    expect(scope.sandbox.allowRead).toEqual(expect.arrayContaining([spec.cwd, browsers]));
  });

  describe('take_screenshots and get_screenshot_run (PM-351)', () => {
    /** A fake server executor: it records the run and ends when the test says so, or when it is stopped. */
    const fake = () => {
      const specs: ScreenshotRunSpec[] = [];
      const signals: AbortSignal[] = [];
      let end: () => void = () => undefined;
      const executor: ScreenshotExecutor = {
        run: (spec, signal, started) =>
          new Promise((resolve) => {
            specs.push(spec);
            signals.push(signal);
            started();
            end = () => resolve({ exitCode: 0, timedOut: false, aborted: false, output: 'done' });
            signal.addEventListener('abort', () =>
              resolve({ exitCode: null, timedOut: false, aborted: true, output: '' }),
            );
          }),
      };
      return { executor, specs, signals, end: () => end() };
    };
    const tools = () => h!.domain.teamTools;

    it.runIf(process.platform === 'darwin')(
      'makes a run in the session worktree with the session folder, and stops it when the session ends',
      async () => {
        const f = fake();
        const { session } = await start({ mode: 'acceptEdits', screenshots: f.executor });
        const ctx = { sessionId: session.id, projectKey: 'AR', member: 'dev-1', taskKey: 'AR-1' };
        mkdirSync(join(session.cwd, 'shots'), { recursive: true });
        writeFileSync(join(session.cwd, 'shots', 'login.mjs'), 'export default {};');

        const taking = tools().takeScreenshots(ctx, { scenario: 'shots/login.mjs', widths: [390] });
        await vi.waitFor(() => expect(f.specs).toHaveLength(1));
        const folder = portable().env.PROJECTMAN_SESSION_DIR!;
        expect(f.specs[0]).toMatchObject({
          cwd: session.cwd,
          sessionDir: folder,
          args: [join(realpathSync(session.cwd), 'shots', 'login.mjs'), '--widths', '390'],
        });
        // It runs with the session's own limits: it writes the folder, and nothing outward.
        expect(f.specs[0]!.sandbox.allowWrite).toContain(folder);
        f.end();
        const run = await taking;
        expect(run).toMatchObject({ status: 'done', exitCode: 0 });
        await expect(tools().getScreenshotRun(ctx, run.runId)).resolves.toMatchObject({ status: 'done' });

        // A second run, stopped with the session: the signal aborts before the folder goes.
        const second = tools().takeScreenshots(ctx, { scenario: 'shots/login.mjs' });
        await vi.waitFor(() => expect(f.specs).toHaveLength(2));
        await h!.runner.stop(session.id);
        expect(f.signals[1]!.aborted).toBe(true);
        expect(await second).toMatchObject({ status: 'failed', failure: 'stopped' });
        await h!.domain.sessions.settleFolderRemovals();
        expect(existsSync(folder)).toBe(false);
      },
    );

    it.runIf(process.platform === 'darwin')(
      'is forbidden for a read-only placement, naming the cause',
      async () => {
        const f = fake();
        await start({ screenshots: f.executor });
        const { session } = await h!.domain.sessions.ensureSession('AR', 'cr', task);
        expect(h!.runner.lastStarted().policy!.access).toBe('read_only');
        const ctx = { sessionId: session.id, projectKey: 'AR', member: 'cr', taskKey: 'AR-1' };
        const err = await rejection(tools().takeScreenshots(ctx, { scenario: 'a.mjs' }), TeamToolError);
        expect(err.code).toBe('forbidden');
        expect(err.message).toContain('worktree or review copy');
        expect(f.specs).toHaveLength(0);
      },
    );

    it('is forbidden when the server has no screenshot executor', async () => {
      const { session } = await start({ mode: 'acceptEdits' });
      const ctx = { sessionId: session.id, projectKey: 'AR', member: 'dev-1', taskKey: 'AR-1' };
      const err = await rejection(tools().getScreenshotRun(ctx, 'shr_x'), TeamToolError);
      expect(err.code).toBe('forbidden');
    });
  });

  /** A session whose sandbox only reads its folder (PM-522): the folder, and no tmp, browsers or screenshots. */
  const expectReadOnlyFolder = (spec: ReturnType<DomainHarness['runner']['lastStarted']>) => {
    const folder = spec.policy!.filesystem.sessionFolder!;
    expect(folder).toMatch(new RegExp(`^${h!.sessionFoldersDir}/`));
    expect(spec.policy!.filesystem.sessionFoldersRoot).toBe(h!.sessionFoldersDir);
    expect(spec.sandbox!.portable!.env.PROJECTMAN_SESSION_DIR).toBe(folder);
    expect(spec.sandbox!.portable!.env).not.toHaveProperty('PLAYWRIGHT_BROWSERS_PATH');
    expect(spec.sandbox!.portable!.tmpDir).toBeUndefined();
    expect(existsSync(folder)).toBe(true);
    return folder;
  };

  it('gives a default-mode session (read-only sandbox) a folder it only reads, and no tmp (PM-522)', async () => {
    const { session } = await start({});
    const spec = h!.runner.lastStarted();
    expect(spec.policy!.permissions.sandbox).toBe('read-only');
    const folder = expectReadOnlyFolder(spec);
    expect(readdirSync(h!.sessionTmpDir!)).toEqual([]);
    // Its own commands do not write the folder; only the server's browser run does (the scope below).
    const { args } = buildCodexArgs({
      spec,
      hookConfigPath: '/run/ses_1.0123456789abcdef/hook.curl',
      mcpConfigPath: '/run/ses_1.0123456789abcdef/codex-mcp.json',
      permissionTimeoutMs: 40_000,
      realCwd: spec.cwd,
    });
    const profile = args.find((arg) => arg.startsWith('permissions.projectman='))!;
    expect(profile).not.toContain(`"${folder}"="write"`);
    expect(args.join('\n')).toContain(`shell_environment_policy.set.PROJECTMAN_SESSION_DIR="${folder}"`);
    await h!.runner.stop(session.id);
    await h!.domain.sessions.settleFolderRemovals();
    expect(existsSync(folder)).toBe(false);
    expect(h!.domain.sessions.screenshotScope(session.id)).toBeUndefined();
  });

  it('gives a plan-mode session a folder it only reads, and no tmp (PM-522)', async () => {
    await start({ mode: 'plan' });
    expectReadOnlyFolder(h!.runner.lastStarted());
  });

  it('gives a reader (a read-only placement) a folder it only reads, whatever its mode (PM-522)', async () => {
    await start({
      mode: 'acceptEdits',
      adjust: (config) => {
        const cr = config.team.members.find((m) => m.handle === 'cr');
        if (cr?.kind === 'ai') {
          cr.provider = 'codex';
          cr.permissionMode = 'acceptEdits';
        }
      },
    });
    const { session } = await h!.domain.sessions.ensureSession('AR', 'cr', task);
    const spec = h!.runner.lastStarted();
    expect(spec.policy!.access).toBe('read_only');
    expectReadOnlyFolder(spec);
    expect(h!.domain.sessions.screenshotScope(session.id)).toBeUndefined();
  });

  it('gives a read-only session a folder also without a safe temporary root (PM-522)', async () => {
    await start({ tmp: false });
    expect(h!.runner.lastStarted().policy!.filesystem.sessionFolder).toBeDefined();
  });

  describe('NanoGPT (PM-522)', () => {
    const startNano = (mode?: string) =>
      start({
        adjust: (config) => {
          const dev = config.team.members.find((m) => m.handle === 'dev-1');
          if (dev?.kind === 'ai') {
            dev.provider = 'nanogpt';
            if (mode) dev.permissionMode = mode as typeof dev.permissionMode;
          }
        },
      });

    it('gives an acceptEdits session the folder and the own tmp, removed when its process ends', async () => {
      const { session } = await startNano('acceptEdits');
      const spec = h!.runner.lastStarted();
      expect(spec.policy!.permissions.sandbox).toBe('workspace-write');
      const { env, tmpDir, allowWrite } = portable();
      const folder = env.PROJECTMAN_SESSION_DIR!;
      expect(folder).toMatch(new RegExp(`^${h!.sessionFoldersDir}/${session.id}\\.[0-9a-f]{16}$`));
      expect(tmpDir).toMatch(new RegExp(`^${h!.sessionTmpDir}/[0-9a-f]{12}$`));
      expect(allowWrite).toContain(folder);
      expect(spec.policy!.filesystem.sessionFolder).toBe(folder);
      expect(h!.domain.sessions.screenshotScope(session.id)).toMatchObject({ sessionDir: folder });
      await h!.runner.stop(session.id);
      await h!.domain.sessions.settleFolderRemovals();
      expect(existsSync(folder)).toBe(false);
      expect(existsSync(tmpDir!)).toBe(false);
    });

    it('gives a default-mode session a folder it only reads, and a scope that writes only the folder', async () => {
      const { session } = await start({
        adjust: (config) => {
          const dev = config.team.members.find((m) => m.handle === 'dev-1');
          if (dev?.kind === 'ai') dev.provider = 'nanogpt';
        },
      });
      const folder = expectReadOnlyFolder(h!.runner.lastStarted());
      const scope = h!.domain.sessions.screenshotScope(session.id)!;
      expect(scope.sandbox.allowWrite).toEqual([folder]);
      expect(scope.sandbox.denyWrite).toContain(scope.cwd);
    });

    it('gives no folder to a writing session without a safe temporary root', async () => {
      await start({
        mode: 'acceptEdits',
        tmp: false,
        adjust: (config) => {
          const dev = config.team.members.find((m) => m.handle === 'dev-1');
          if (dev?.kind === 'ai') dev.provider = 'nanogpt';
        },
      });
      expect(h!.runner.lastStarted().policy!.filesystem.sessionFolder).toBeUndefined();
    });
  });

  describe('Gemini (PM-522)', () => {
    const geminiMember = (config: ProjectConfig, handle: string, mode: string) => {
      const member = config.team.members.find((m) => m.handle === handle);
      if (member?.kind === 'ai') {
        member.provider = 'gemini';
        member.permissionMode = mode as typeof member.permissionMode;
      }
    };

    it('gives a developer and a reader a folder, and no tmp, browsers or screenshots', async () => {
      const { session } = await start({
        adjust: (config) => {
          geminiMember(config, 'dev-1', 'default');
          geminiMember(config, 'cr', 'default');
        },
      });
      const expectFolder = (id: string, spec: ReturnType<DomainHarness['runner']['lastStarted']>) => {
        const folder = spec.policy!.filesystem.sessionFolder!;
        expect(folder).toMatch(new RegExp(`^${h!.sessionFoldersDir}/${id}\\.[0-9a-f]{16}$`));
        expect(spec.policy!.filesystem.sessionFoldersRoot).toBe(h!.sessionFoldersDir);
        expect(spec.sandbox?.portable?.tmpDir).toBeUndefined();
        expect(spec.sandbox?.portable?.env).not.toHaveProperty('PLAYWRIGHT_BROWSERS_PATH');
        expect(existsSync(folder)).toBe(true);
        expect(h!.domain.sessions.screenshotScope(id)).toBeUndefined();
      };
      expectFolder(session.id, h!.runner.lastStarted());
      expect(readdirSync(h!.sessionTmpDir!)).toEqual([]);

      // A reader: a read-only placement.
      const { session: reader } = await h!.domain.sessions.ensureSession('AR', 'cr', task);
      expect(h!.runner.lastStarted().policy!.access).toBe('read_only');
      expectFolder(reader.id, h!.runner.lastStarted());
    });

    it('removes the folder when the process ends', async () => {
      const { session } = await start({ adjust: (config) => geminiMember(config, 'dev-1', 'acceptEdits') });
      const folder = h!.runner.lastStarted().policy!.filesystem.sessionFolder!;
      await h!.runner.stop(session.id);
      await h!.domain.sessions.settleFolderRemovals();
      expect(existsSync(folder)).toBe(false);
    });
  });

  it('gives no folder when there is no safe temporary root: /tmp would stay open', async () => {
    await start({ mode: 'acceptEdits', tmp: false });
    expect(h!.runner.lastStarted().sandbox!.env).not.toHaveProperty('PROJECTMAN_SESSION_DIR');
    expect(readdirSync(h!.sessionFoldersDir!)).toEqual([]);
  });

  it('gives no folder when the temporary root overlaps the queue folder’s parent, which every sandbox writes', async () => {
    const parent = join(base, 'projectman-501');
    // Below the parent, and above it.
    for (const tmp of [join(parent, 'tmp', 'abcd'), base]) {
      await h?.cleanup();
      await start({ mode: 'acceptEdits', tmp, heavyLockDir: join(parent, 'heavy') });
      const { env } = h!.runner.lastStarted().sandbox!;
      expect(env).not.toHaveProperty('PROJECTMAN_SESSION_DIR');
      expect(h!.runner.lastStarted().sandbox!.portable?.tmpDir).toBeUndefined();
      // The refusal is logged as an error, which the harness would fail on.
      expect(h!.log.errors).toHaveLength(1);
      expect(((h!.log.errors[0] as unknown[])[0] as { err: Error }).err.message).toContain('overlap');
      h!.log.errors.length = 0;
    }
  });

  it('sees the overlap through a link: a queue folder given by a link to the temporary root’s parent', async () => {
    // The sandboxes canonicalize paths: `<base>/link/heavy` is `<base>/heavy`, so `<base>` is written.
    symlinkSync(realpathSync(base), join(base, 'link'));
    await start({
      mode: 'acceptEdits',
      tmp: join(realpathSync(base), 'projectman-501-tmp', 'abcd'),
      heavyLockDir: join(base, 'link', 'heavy'),
    });
    expect(h!.runner.lastStarted().sandbox!.portable?.tmpDir).toBeUndefined();
    expect(h!.log.errors).toHaveLength(1);
    expect(((h!.log.errors[0] as unknown[])[0] as { err: Error }).err.message).toContain('overlap');
    expect(existsSync(join(realpathSync(base), 'projectman-501-tmp'))).toBe(false);
    h!.log.errors.length = 0;
  });

  it('removes the temporary directories a dead server left when the server starts', async () => {
    await start({ mode: 'acceptEdits', persistent: true });
    const stale = join(h!.sessionTmpDir!, 'ses_dead.abcdef');
    mkdirSync(stale);
    writeFileSync(join(stale, 'old'), 'x');
    h = await restartDomainHarness(h!, { userHome: home, appHome, sessionFolders: true, sessionTmp: true });
    expect(readdirSync(h.sessionTmpDir!)).toEqual([]);
  });

  describe('attach_file', () => {
    const toolError = (promise: Promise<unknown>) => rejection(promise, TeamToolError);

    it('attaches from its own folder; another member’s folder, a credential file and the live data are forbidden', async () => {
      await start({ mode: 'acceptEdits' });
      const ctx = {
        sessionId: h!.runner.lastStarted().sessionId,
        projectKey: 'AR',
        member: 'dev-1',
        taskKey: 'AR-1',
      };
      const folder = portable().env.PROJECTMAN_SESSION_DIR!;
      writeFileSync(join(folder, 'a.png'), pngBytes(200));
      const { attachment } = await h!.domain.teamTools.attachFile(ctx, {
        taskKey: 'AR-1',
        path: join(folder, 'a.png'),
      });
      expect(attachment).toMatchObject({ fileName: 'a.png', uploadedBy: { kind: 'ai', handle: 'dev-1' } });

      const other = join(h!.sessionFoldersDir!, 'ses_other.0123456789abcdef');
      mkdirSync(other);
      writeFileSync(join(other, 'theirs.png'), pngBytes(120));
      mkdirSync(join(home, '.ssh'));
      writeFileSync(join(home, '.ssh', 'id_ed25519'), 'key');
      writeFileSync(join(appHome, 'db.sqlite'), 'db');
      for (const path of [
        join(other, 'theirs.png'),
        join(home, '.ssh', 'id_ed25519'),
        join(appHome, 'db.sqlite'),
        join(portable().tmpDir!, 'x'),
      ]) {
        const err = await toolError(h!.domain.teamTools.attachFile(ctx, { taskKey: 'AR-1', path }));
        expect(err.code, path).toBe('forbidden');
      }
    });
  });
});
