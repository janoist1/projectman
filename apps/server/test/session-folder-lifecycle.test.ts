import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectConfig } from '@projectman/shared';
import { SessionFolders } from '../src/domain/session-folders';
import { createDomainHarness, OWNER_ACTOR, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

const task = { type: 'task', taskKey: 'AR-1' } as const;

/** The session folders (PM-268) from the session's start to its end. */
describe('the session folder of a session (PM-268)', () => {
  let h: DomainHarness | undefined;
  let base: string;
  let home: string;
  let appHome: string;
  let browsers: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'pm-session-folder-test-'));
    // Fictional homes: only their paths go into the spec.
    home = join(base, 'user-home');
    appHome = join(base, 'app-home');
    browsers = join(appHome, 'browsers');
    mkdirSync(home);
    mkdirSync(appHome);
  });
  afterEach(async () => {
    await h?.cleanup();
    h = undefined;
    rmSync(base, { recursive: true, force: true });
  });

  const mode = (path: string) => statSync(path).mode & 0o777;
  /** The session folder of the latest start, as its sandbox names it. */
  const folderOf = () => h!.runner.lastStarted().sandbox!.env!.PROJECTMAN_SESSION_DIR!;
  const withFolders = (adjust?: (config: ProjectConfig) => void, persistent = false) =>
    createDomainHarness({
      userHome: home,
      appHome,
      browsersDir: browsers,
      sessionFolders: true,
      persistent,
      adjust,
    });

  it('gives a developer its folder in the sandbox, in the tool rules and on the disk', async () => {
    h = await withFolders();
    await h.domain.tasks.create('AR', { title: 'Login page', repo: 'web' }, OWNER_ACTOR);
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', task);
    const dir = folderOf();
    expect(dir).toMatch(new RegExp(`^${h.sessionFoldersDir}/${session.id}\\.[0-9a-f]{16}$`));
    expect(existsSync(dir)).toBe(true);
    expect(mode(dir)).toBe(0o700);
    expect(mode(h.sessionFoldersDir!)).toBe(0o700);
    const spec = h.runner.lastStarted();
    expect(spec.sandbox!.env).toMatchObject({
      PROJECTMAN_SESSION_DIR: dir,
      PLAYWRIGHT_BROWSERS_PATH: browsers,
    });
    expect(spec.sandbox!.allowWrite).toContain(dir);
    expect(spec.sandbox!.allowWrite).not.toContain(browsers);
    expect(spec.sandbox!.allowRead).toEqual(expect.arrayContaining([dir, browsers]));
    expect(spec.allowedTools).toEqual(expect.arrayContaining([`Read(/${dir}/**)`, `Edit(/${dir}/**)`]));
  });

  it('gives a reader its own folder to write, and the browsers variable', async () => {
    h = await withFolders();
    await h.domain.tasks.create('AR', { title: 'Login page', repo: 'web' }, OWNER_ACTOR);
    await h.domain.sessions.ensureSession('AR', 'dev-1', task);
    await h.domain.sessions.ensureSession('AR', 'cr', task);
    const dir = folderOf();
    expect(existsSync(dir)).toBe(true);
    const spec = h.runner.lastStarted();
    expect(spec.policy!.access).toBe('read_only');
    expect(spec.sandbox!.allowWrite).toEqual([dir]);
    expect(spec.sandbox!.env).toMatchObject({
      PROJECTMAN_SESSION_DIR: dir,
      PLAYWRIGHT_BROWSERS_PATH: browsers,
    });
    expect(spec.allowedTools).toEqual(expect.arrayContaining([`Read(/${dir}/**)`, `Edit(/${dir}/**)`]));
  });

  it('gives a Codex member no folder and no variable', async () => {
    h = await withFolders((config) => {
      const dev = config.team.members.find((m) => m.handle === 'dev-1');
      if (dev?.kind === 'ai') dev.provider = 'codex';
    });
    await h.domain.tasks.create('AR', { title: 'Login page', repo: 'web' }, OWNER_ACTOR);
    await h.domain.sessions.ensureSession('AR', 'dev-1', task);
    const spec = h.runner.lastStarted();
    expect(spec.sandbox?.env ?? {}).not.toHaveProperty('PROJECTMAN_SESSION_DIR');
    expect(spec.sandbox?.env ?? {}).not.toHaveProperty('PLAYWRIGHT_BROWSERS_PATH');
    expect(readdirSync(h.sessionFoldersDir!)).toEqual([]);
  });

  it('sets nothing without a configured root', async () => {
    h = await createDomainHarness({ userHome: home, appHome });
    await h.domain.tasks.create('AR', { title: 'Login page', repo: 'web' }, OWNER_ACTOR);
    await h.domain.sessions.ensureSession('AR', 'dev-1', task);
    expect(h.runner.lastStarted().sandbox!.env).not.toHaveProperty('PROJECTMAN_SESSION_DIR');
  });

  it('removes the folder with its content when the process exits', async () => {
    h = await withFolders();
    await h.domain.tasks.create('AR', { title: 'Login page', repo: 'web' }, OWNER_ACTOR);
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', task);
    const dir = folderOf();
    mkdirSync(join(dir, 'shots'));
    writeFileSync(join(dir, 'shots', '1.png'), 'png');
    await h.runner.stop(session.id);
    expect(existsSync(dir)).toBe(false);
    // Nothing is left of it, not even the name it was renamed to for the removal.
    expect(readdirSync(h.sessionFoldersDir!)).toEqual([]);
  });

  it('removes the folder of a start that fails', async () => {
    h = await withFolders();
    await h.domain.tasks.create('AR', { title: 'Login page', repo: 'web' }, OWNER_ACTOR);
    h.runner.failNextStart = new Error('no terminal');
    await expect(h.domain.sessions.ensureSession('AR', 'dev-1', task)).rejects.toThrow();
    expect(readdirSync(h.sessionFoldersDir!)).toEqual([]);
  });

  it('makes a new, empty folder when a permission change restarts the session', async () => {
    h = await withFolders((config) => {
      const dev = config.team.members.find((m) => m.handle === 'dev-1');
      if (dev?.kind === 'ai') dev.permissionMode = 'auto';
    });
    await h.domain.tasks.create('AR', { title: 'Login page', repo: 'web' }, OWNER_ACTOR);
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', task);
    h.runner.emit({ type: 'transcript_path', sessionId: session.id, path: '/fake/transcript.jsonl' });
    const old = folderOf();
    writeFileSync(join(old, 'old.png'), 'png');
    await h.domain.sessions.updatePermissions('AR', session.id, { permissionMode: 'plan' }, OWNER_ACTOR);
    h.runner.setState(session.id, 'idle');
    await flush();
    expect(h.runner.started).toHaveLength(2);
    const dir = folderOf();
    // A new path for the new process: the old run's sandbox does not name it.
    expect(dir).not.toBe(old);
    expect(dir.startsWith(`${h.sessionFoldersDir}/${session.id}.`)).toBe(true);
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
    expect(existsSync(old)).toBe(false);
    expect(readdirSync(h.sessionFoldersDir!)).toEqual([dir.slice(h.sessionFoldersDir!.length + 1)]);
  });

  it('does not take an old run’s path, or what a survivor of it put there, into the new sandbox', async () => {
    h = await withFolders((config) => {
      const dev = config.team.members.find((m) => m.handle === 'dev-1');
      if (dev?.kind === 'ai') dev.permissionMode = 'auto';
    });
    await h.domain.tasks.create('AR', { title: 'Login page', repo: 'web' }, OWNER_ACTOR);
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', task);
    h.runner.emit({ type: 'transcript_path', sessionId: session.id, path: '/fake/transcript.jsonl' });
    const old = folderOf();
    const target = join(base, 'target');
    mkdirSync(target);
    writeFileSync(join(target, 'precious.txt'), 'keep me');
    await h.domain.sessions.updatePermissions('AR', session.id, { permissionMode: 'plan' }, OWNER_ACTOR);
    h.runner.setState(session.id, 'idle');
    await flush();
    // A command of the old run that outlived it puts a link at the old path (and a plain folder at the
    // id's former, predictable path) before the next start.
    symlinkSync(target, old);
    mkdirSync(join(h.sessionFoldersDir!, session.id));
    const first = folderOf();
    h.runner.emit({ type: 'transcript_path', sessionId: session.id, path: '/fake/transcript.jsonl' });
    await h.domain.sessions.updatePermissions('AR', session.id, { permissionMode: 'auto' }, OWNER_ACTOR);
    h.runner.setState(session.id, 'idle');
    await flush();
    const next = folderOf();
    expect(next).not.toBe(old);
    expect(next).not.toBe(first);
    expect(lstatSync(next).isDirectory()).toBe(true);
    expect(lstatSync(next).isSymbolicLink()).toBe(false);
    const spec = h.runner.lastStarted();
    expect(spec.sandbox!.allowWrite).toEqual(expect.arrayContaining([next]));
    expect(spec.sandbox!.allowWrite).not.toContain(old);
    // The survivor's link and its target are not touched by the new start.
    expect(existsSync(join(target, 'precious.txt'))).toBe(true);
  });

  it('refuses a folder that is already there when it is made', async () => {
    h = await withFolders();
    const folders = new SessionFolders(h.sessionFoldersDir!);
    const dir = folders.allocate('ses_one');
    mkdirSync(dir);
    expect(() => folders.make('ses_one', dir)).toThrow(/EEXIST/);
    expect(folders.of('ses_one')).toBeUndefined();
  });

  it('removes what a dead server left, when the server starts', async () => {
    h = await withFolders(undefined, true);
    const root = h.sessionFoldersDir!;
    mkdirSync(join(root, 'ses_dead'));
    writeFileSync(join(root, 'ses_dead', 'old.png'), 'png');
    writeFileSync(join(root, 'stray-file'), 'x');
    h = await restartDomainHarness(h, {
      userHome: home,
      appHome,
      browsersDir: browsers,
      sessionFolders: root,
    });
    expect(readdirSync(root)).toEqual([]);
  });

  describe('an unsafe root', () => {
    it('turns the folders off, says why, and lets the server run', async () => {
      const target = join(base, 'target');
      mkdirSync(target);
      writeFileSync(join(target, 'precious.txt'), 'keep me');
      const link = join(base, 'link');
      symlinkSync(target, link);
      h = await createDomainHarness({
        userHome: home,
        appHome,
        browsersDir: browsers,
        sessionFolders: link,
      });
      expect(h.log.errors).toHaveLength(1);
      // The harness fails a test that logged an error; this one is the one expected.
      h.log.errors.length = 0;
      await h.domain.tasks.create('AR', { title: 'Login page', repo: 'web' }, OWNER_ACTOR);
      await h.domain.sessions.ensureSession('AR', 'dev-1', task);
      expect(h.runner.lastStarted().sandbox!.env).not.toHaveProperty('PROJECTMAN_SESSION_DIR');
      // The sweep never ran behind the link.
      expect(readdirSync(target)).toEqual(['precious.txt']);
    });
  });
});
