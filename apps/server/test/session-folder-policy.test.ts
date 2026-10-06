import { describe, expect, it } from 'vitest';
import type { SessionPolicy } from '../src/contracts';
import {
  buildSessionPolicy,
  sensitivePaths,
  sessionSandbox,
  withSessionFolders,
} from '../src/domain/session-policy';
import { testConfig } from './helpers/test-template';

const source = '/fictional/source';
const sharedGit = '/fictional/repo/.git';
const userHome = '/fictional/user';
const appHome = '/fictional/app';
const root = '/fictional/tmp/projectman-sessions/abc123';
const sessionDir = `${root}/ses_one`;
const browsers = '/fictional/browsers';

function policy(role: string, placement: SessionPolicy['placement'], deniedPaths?: string[]) {
  return buildSessionPolicy({
    config: testConfig(),
    role,
    task: { repo: 'web' },
    placement,
    permissionMode: 'acceptEdits',
    deniedPaths: deniedPaths ?? sensitivePaths({ userHome, appHome }),
  });
}
const developer = (deniedPaths?: string[]) =>
  policy('developer', { kind: 'task_worktree', path: source, gitDir: sharedGit }, deniedPaths);
const reader = () => policy('qa', { kind: 'read_only', path: source });

const paths = { userHome, appHome, defaultBranch: 'main' };

/** The session folder and the browsers of a session (PM-268), as the sandboxes hand them out. */
describe('the session folder and the browsers in the sandbox (PM-268)', () => {
  describe('a developer', () => {
    it('writes its own folder, reads every session’s of the instance, and gets the variable', () => {
      const sandbox = sessionSandbox(developer(), { ...paths, sessionDir })!;
      expect(sandbox.allowWrite).toEqual([sessionDir]);
      // PM-333: the whole root is read (a teammate names a screenshot), only the own folder is written.
      expect(sandbox.allowRead).toContain(root);
      expect(sandbox.denyRead).not.toContain(root);
      expect(sandbox.denyRead).not.toContain(sessionDir);
      expect(sandbox.env).toMatchObject({ PROJECTMAN_SESSION_DIR: sessionDir });
    });

    it('reads the browsers and never writes them', () => {
      const sandbox = sessionSandbox(developer(), { ...paths, sessionDir, browsersDir: browsers })!;
      expect(sandbox.allowRead).toContain(browsers);
      expect(sandbox.allowWrite).not.toContain(browsers);
      expect(sandbox.env).toMatchObject({ PLAYWRIGHT_BROWSERS_PATH: browsers });
      // The browsers directory is never a writable root.
      expect(sandbox.allowWrite).toEqual([sessionDir]);
    });

    it('is unchanged without them', () => {
      const sandbox = sessionSandbox(developer(), paths)!;
      expect(sandbox.allowWrite).toEqual([]);
      expect(sandbox.denyRead).toEqual([userHome, appHome, ...sensitivePaths({ userHome, appHome })]);
      expect(sandbox.env).not.toHaveProperty('PROJECTMAN_SESSION_DIR');
      expect(sandbox.env).not.toHaveProperty('PLAYWRIGHT_BROWSERS_PATH');
    });

    it('leaves out a browsers directory that is the home, above it, the app home, above it or denied', () => {
      for (const dir of [userHome, '/fictional', appHome, `${userHome}/.ssh/browsers`]) {
        const sandbox = sessionSandbox(developer(), { ...paths, browsersDir: dir })!;
        expect(sandbox.allowRead).not.toContain(dir);
        expect(sandbox.env).not.toHaveProperty('PLAYWRIGHT_BROWSERS_PATH');
      }
      // Below the app home (the default `<home>/browsers`) it is fine.
      const below = sessionSandbox(developer(), { ...paths, browsersDir: `${appHome}/browsers` })!;
      expect(below.allowRead).toContain(`${appHome}/browsers`);
      expect(below.env).toMatchObject({ PLAYWRIGHT_BROWSERS_PATH: `${appHome}/browsers` });
    });

    it('gets no folder inside a denied path', () => {
      const denied = developer([root]);
      const sandbox = sessionSandbox(denied, { ...paths, sessionDir })!;
      expect(sandbox.allowWrite).toEqual([]);
      expect(sandbox.env).not.toHaveProperty('PROJECTMAN_SESSION_DIR');
    });
  });

  describe('a reader', () => {
    it('writes only its own folder, besides the temp directory', () => {
      const sandbox = sessionSandbox(reader(), { sessionDir, browsersDir: browsers })!;
      expect(sandbox.allowWrite).toEqual([sessionDir]);
      expect(sandbox.denyWrite).toEqual([source]);
      expect(sandbox.env).toMatchObject({
        PROJECTMAN_SESSION_DIR: sessionDir,
        PLAYWRIGHT_BROWSERS_PATH: browsers,
      });
      // It reads everything outside the denied paths: no allowRead (which would change its prompt).
      expect(sandbox.allowRead).toBeUndefined();
    });

    it('is unchanged without them', () => {
      const sandbox = sessionSandbox(reader(), {})!;
      expect(sandbox.allowWrite).toEqual([]);
      expect(sandbox.env).not.toHaveProperty('PROJECTMAN_SESSION_DIR');
      expect(sandbox.env).not.toHaveProperty('PLAYWRIGHT_BROWSERS_PATH');
    });

    it('gets no folder inside a read-only checkout or a denied path', () => {
      const inside = sessionSandbox(reader(), {
        sessionDir: `${appHome}/ses_one`,
        readerDenyWrite: [appHome],
      })!;
      expect(inside.allowWrite).toEqual([]);
      expect(inside.env).not.toHaveProperty('PROJECTMAN_SESSION_DIR');
      const own = sessionSandbox(reader(), { sessionDir: `${source}/ses_one` })!;
      expect(own.allowWrite).toEqual([]);
      const denied = sessionSandbox(policy('qa', { kind: 'read_only', path: source }, [root]), {
        sessionDir,
      })!;
      expect(denied.allowWrite).toEqual([]);
      expect(denied.env).not.toHaveProperty('PROJECTMAN_SESSION_DIR');
    });

    it('leaves out a browsers variable for a denied path', () => {
      const denied = sessionSandbox(policy('qa', { kind: 'read_only', path: source }, [browsers]), {
        browsersDir: browsers,
      })!;
      expect(denied.env).not.toHaveProperty('PLAYWRIGHT_BROWSERS_PATH');
    });
  });

  describe('what a CLI with a sandbox of its own takes (`portable`, PM-339)', () => {
    const tmpDir = '/fictional/tmp/projectman-501-tmp/0123abcd/ses_one.abcdef';
    const heavyLockDir = '/fictional/tmp/projectman-501/heavy';

    it('hands a developer’s folder, browsers, queue and tmp over, and the folder as a writable path', () => {
      const sandbox = sessionSandbox(developer(), {
        ...paths,
        sessionDir,
        browsersDir: browsers,
        heavyLockDir,
        tmpDir,
      })!;
      expect(sandbox.portable).toEqual({
        allowWrite: ['/fictional/tmp/projectman-501', sessionDir],
        env: {
          PROJECTMAN_HEAVY_LOCK_DIR: heavyLockDir,
          npm_config_prefer_offline: 'true',
          PROJECTMAN_SESSION_DIR: sessionDir,
          PLAYWRIGHT_BROWSERS_PATH: browsers,
        },
        tmpDir,
      });
      // Claude Code's own rules are as before: the tmp is the CLI's own business, not an srt path.
      expect(sandbox.allowWrite).not.toContain(tmpDir);
    });

    it('makes `portable` for a folder alone, and for a tmp alone', () => {
      expect(sessionSandbox(developer(), { ...paths, sessionDir })!.portable).toEqual({
        allowWrite: [sessionDir],
        env: { PROJECTMAN_SESSION_DIR: sessionDir },
      });
      expect(sessionSandbox(developer(), { ...paths, tmpDir })!.portable).toEqual({
        allowWrite: [],
        env: {},
        tmpDir,
      });
    });

    it('has none without any of them', () => {
      expect(sessionSandbox(developer(), paths)!.portable).toBeUndefined();
      expect(sessionSandbox(reader(), {})!.portable).toBeUndefined();
    });

    it('gives a reader its folder and tmp too, but not a tmp inside a path it must not write', () => {
      const sandbox = sessionSandbox(reader(), { sessionDir, browsersDir: browsers, tmpDir })!;
      expect(sandbox.portable).toEqual({
        allowWrite: [sessionDir],
        env: { PROJECTMAN_SESSION_DIR: sessionDir, PLAYWRIGHT_BROWSERS_PATH: browsers },
        tmpDir,
      });
      expect(sessionSandbox(reader(), { tmpDir: `${source}/tmp` })!.portable).toBeUndefined();
    });

    it('leaves out a tmp or a folder in a denied path', () => {
      const denied = [tmpDir, sessionDir];
      expect(sessionSandbox(developer(denied), { ...paths, sessionDir, tmpDir })!.portable).toBeUndefined();
    });
  });

  it('gives the managed VM profile no sandbox at all', () => {
    const vm = buildSessionPolicy({
      config: testConfig(),
      role: 'developer',
      task: { repo: 'web' },
      placement: { kind: 'member_workspace', path: source, use: 'work' },
      managedVm: { boundary: { name: 'vm', version: 1 } },
    });
    expect(sessionSandbox(vm, { ...paths, sessionDir, browsersDir: browsers })).toBeUndefined();
  });

  describe('withSessionFolders', () => {
    it('gives the policy the folder and its root', () => {
      const base = developer();
      const withFolders = withSessionFolders(base, { own: sessionDir, root });
      expect(withFolders.filesystem).toMatchObject({ sessionFolder: sessionDir, sessionFoldersRoot: root });
      // The rest of the policy is the same, and the input is not changed.
      expect({ ...withFolders, filesystem: base.filesystem }).toEqual(base);
      expect(base.filesystem).not.toHaveProperty('sessionFolder');
    });

    it('is unchanged without folders', () => {
      const base = developer();
      expect(withSessionFolders(base, undefined)).toBe(base);
    });

    it('gives no root to a folder that is not directly below it', () => {
      const nested = withSessionFolders(developer(), { own: `${sessionDir}/deeper`, root });
      expect(nested.filesystem.sessionFolder).toBe(`${sessionDir}/deeper`);
      expect(nested.filesystem).not.toHaveProperty('sessionFoldersRoot');
    });
  });
});
