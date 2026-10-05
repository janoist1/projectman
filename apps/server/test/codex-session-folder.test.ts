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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectConfig } from '@projectman/shared';
import { TeamToolError } from '../src/contracts';
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
    expect(tmpDir).toMatch(new RegExp(`^${h.sessionTmpDir}/${session.id}\\.[0-9a-f]{6}$`));
    // The root is no writable path of any session: not the queue folder's parent either.
    expect(allowWrite).toContain(join(base, 'projectman-501'));
    expect(allowWrite.some((dir) => `${h!.sessionTmpDir}/`.startsWith(`${dir}/`))).toBe(false);
    expect(allowWrite).toContain(folder);
    expect(mode(folder)).toBe(0o700);
    expect(mode(h.sessionTmpDir!)).toBe(0o700);

    writeFileSync(join(tmpDir!, 'scratch'), 'x');
    await h.runner.stop(session.id);
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
      hookUrl: 'http://127.0.0.1:4700/hooks/secret',
      permissionTimeoutMs: 40_000,
      realCwd: spec.cwd,
    });
    const text = args.join('\n');
    expect(spec.policy!.permissions.sandbox).toBe('workspace-write');
    expect(text).toContain(`shell_environment_policy.set.TMPDIR="${tmpDir}"`);
    expect(text).toContain(`shell_environment_policy.set.PROJECTMAN_SESSION_DIR="${folder}"`);
    expect(text).toMatch(/sandbox_workspace_write\.writable_roots=\[[^\]]*\]/);
    const roots = /writable_roots=\[([^\]]*)\]/.exec(text)![1]!;
    expect(roots).toContain(`"${folder}"`);
    expect(roots).toContain(`"${tmpDir}"`);
    expect(text).toContain('sandbox_workspace_write.exclude_slash_tmp=true');
    expect(text).toContain('sandbox_workspace_write.exclude_tmpdir_env_var=true');
    expect(text).toContain('tools.view_image=true');
  });

  it('gives a default-mode session (read-only sandbox) neither', async () => {
    await start({});
    expect(h!.runner.lastStarted().policy!.permissions.sandbox).toBe('read-only');
    expect(h!.runner.lastStarted().sandbox!.portable?.tmpDir).toBeUndefined();
    expect(h!.runner.lastStarted().sandbox!.env).not.toHaveProperty('PROJECTMAN_SESSION_DIR');
    expect(readdirSync(h!.sessionFoldersDir!)).toEqual([]);
    expect(readdirSync(h!.sessionTmpDir!)).toEqual([]);
  });

  it('gives a plan-mode session neither', async () => {
    await start({ mode: 'plan' });
    expect(h!.runner.lastStarted().sandbox!.portable?.env ?? {}).not.toHaveProperty('PROJECTMAN_SESSION_DIR');
    expect(h!.runner.lastStarted().sandbox!.portable?.tmpDir).toBeUndefined();
  });

  it('gives a reader (a read-only placement) neither, whatever its mode', async () => {
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
    await h!.domain.sessions.ensureSession('AR', 'cr', task);
    const spec = h!.runner.lastStarted();
    expect(spec.policy!.access).toBe('read_only');
    expect(spec.sandbox!.portable?.tmpDir).toBeUndefined();
    expect(spec.sandbox!.env).not.toHaveProperty('PROJECTMAN_SESSION_DIR');
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
