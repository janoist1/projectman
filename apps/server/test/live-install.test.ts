import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { install, status, uninstall } from '../../../scripts/live/install';
import type { InstallArgs } from '../../../scripts/live/install';
import { plistFile, SERVER_LABEL, WATCHER_LABEL } from '../../../scripts/live/paths';
import { LiveWorld, OLD, REMOTE } from './helpers/live-world';

/** `npm run live -- install | uninstall | status` (PM-493) against a fake machine. */

let world: LiveWorld;
afterEach(() => world?.cleanup());

function machine(options: Parameters<LiveWorld['setupLive']>[0] = {}): InstallArgs {
  world = new LiveWorld();
  world.setupLive(options);
  return {
    root: world.root,
    home: world.home,
    port: world.port,
    target: 'PM/projectman',
    remote: null,
  };
}

const serverPlist = () => plistFile(world.userHome, SERVER_LABEL);
const watcherPlist = () => plistFile(world.userHome, WATCHER_LABEL);

/** The install refuses before it touches anything. */
async function expectRefused(args: InstallArgs, message: RegExp): Promise<void> {
  await expect(install(world.deps(), args)).rejects.toMatchObject({
    exitCode: 2,
    message: expect.stringMatching(message),
  });
  expect(world.keys()).not.toContain('launchctl-bootout');
  expect(world.keys()).not.toContain('launchctl-bootstrap');
  expect(world.requestOps()).not.toContain('pause');
}

describe('install', () => {
  it('takes over the running server: pause, stop, load both agents, resume', async () => {
    const args = machine();
    world.env = { ...world.env, CLAUDE_BIN: '/secret/path/claude', ANTHROPIC_API_KEY: 'sk-not-for-the-file' };
    expect(await install(world.deps(), args)).toBe(0);

    const keys = world.keys();
    const bootstraps = keys
      .map((key, index) => (key === 'launchctl-bootstrap' ? index : -1))
      .filter((i) => i >= 0);
    expect(bootstraps).toHaveLength(2);
    expect(keys.indexOf('launchctl-bootout')).toBeLessThan(bootstraps[0]!);
    const ops = world.requestOps();
    expect(ops.indexOf('pause')).toBeLessThan(ops.indexOf('resume'));
    expect(world.pause).toBeNull();
    expect(world.loaded).toEqual(new Set([SERVER_LABEL, WATCHER_LABEL]));
    expect(world.server).toEqual({ running: true, version: OLD });

    const server = readFileSync(serverPlist(), 'utf8');
    expect(server).toContain(`<string>${world.root}/apps/server/dist/index.js</string>`);
    expect(server).toContain('<key>KeepAlive</key>');
    expect(server).toContain('/secret/path/claude');
    expect(statSync(serverPlist()).mode & 0o777).toBe(0o644);
    const watcher = readFileSync(watcherPlist(), 'utf8');
    expect(watcher).toContain(`<string>${REMOTE}</string>`);
    expect(watcher).toContain('<key>StartInterval</key>');
    expect(watcher).not.toContain('KeepAlive');

    // Only names are printed, and the billing variable is in neither file.
    expect(world.output).toContain('CLAUDE_BIN');
    expect(world.output).not.toContain('/secret/path/claude');
    for (const text of [server, watcher, world.output]) expect(text).not.toContain('sk-not-for-the-file');
    for (const text of [server, watcher]) expect(text).not.toContain('ANTHROPIC_API_KEY');
  });

  it('installs on a machine where nothing runs yet, without a pause', async () => {
    const args = machine({ running: false });
    expect(await install(world.deps(), args)).toBe(0);
    expect(world.requestOps()).not.toContain('pause');
    expect(world.server.running).toBe(true);
    expect(world.loaded.has(WATCHER_LABEL)).toBe(true);
  });

  it('stops a server that was started by hand', async () => {
    const args = machine();
    world.loaded.clear();
    world.listeners = [777];
    expect(await install(world.deps(), args)).toBe(0);
    expect(world.keys()).toContain('lsof');
    expect(world.loaded.has(SERVER_LABEL)).toBe(true);
    expect(world.pause).toBeNull();
  });

  it('gives up and resumes when it finds no process behind the port', async () => {
    const args = machine();
    world.loaded.clear();
    await expect(install(world.deps(), args)).rejects.toMatchObject({ exitCode: 1 });
    expect(world.pause).toBeNull();
    expect(existsSync(watcherPlist())).toBe(false);
  });

  it('gives up and resumes when the sessions do not pause', async () => {
    const args = machine();
    world.pausingPolls = Infinity;
    await expect(install(world.deps(), args)).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('did not pause'),
    });
    expect(world.pause).toBeNull();
    expect(world.keys()).not.toContain('launchctl-bootout');
    expect(existsSync(watcherPlist())).toBe(false);
  });

  it('takes the GitHub remote from the origin of a local origin', async () => {
    const args = machine();
    world.remotes.set(world.root, '/Users/owner/projectman');
    world.remotes.set('/Users/owner/projectman', REMOTE);
    expect(await install(world.deps(), args)).toBe(0);
    expect(readFileSync(watcherPlist(), 'utf8')).toContain(`<string>${REMOTE}</string>`);
  });

  it('takes --remote as it is', async () => {
    const args = machine();
    world.remotes.clear();
    expect(await install(world.deps(), { ...args, remote: 'https://github.com/o/r.git' })).toBe(0);
    expect(readFileSync(watcherPlist(), 'utf8')).toContain('<string>https://github.com/o/r.git</string>');
  });

  it('undoes the install when the new agent does not come up', async () => {
    const args = machine();
    world.brokenCommits.add(OLD);
    await expect(install(world.deps(), args)).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('did not come up'),
    });
    expect(existsSync(serverPlist())).toBe(false);
    expect(existsSync(watcherPlist())).toBe(false);
    expect(world.loaded.size).toBe(0);
  });

  it('undoes the install when launchd refuses the server', async () => {
    const args = machine();
    world.fail('launchctl-bootstrap', 1, 'Load failed');
    await expect(install(world.deps(), args)).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('Load failed'),
    });
    expect(existsSync(serverPlist())).toBe(false);
  });

  describe('refuses', () => {
    it('on a system that is not macOS', async () => {
      const args = machine();
      world.platform = 'linux';
      await expectRefused(args, /macOS/);
    });

    it('relative paths', async () => {
      const args = machine();
      await expectRefused({ ...args, root: 'projectman-live' }, /absolute/);
    });

    it('while a release is in progress', async () => {
      const args = machine();
      world.writeJournal({ step: 'build' });
      await expectRefused(args, /in progress/);
    });

    it('a checkout that is not built', async () => {
      const args = machine();
      world.cleanup();
      world = new LiveWorld();
      await expectRefused({ ...args, root: world.root, home: world.home }, /built server/);
    });

    it('a checkout with no commit', async () => {
      const args = machine();
      world.fail('rev-parse', 128, 'fatal');
      await expectRefused(args, /commit/);
    });

    it('a remote that is not GitHub', async () => {
      const args = machine();
      world.remotes.set(world.root, 'https://example.com/x/y.git');
      await expectRefused(args, /not a GitHub remote/);
    });

    it('a checkout with no origin', async () => {
      const args = machine();
      world.remotes.clear();
      await expectRefused(args, /no origin/);
    });

    it('a remote that this shell cannot reach', async () => {
      const args = machine();
      world.fail('ls-remote', 128, 'Permission denied (publickey)');
      await expectRefused(args, /Permission denied/);
    });

    it('a shell where gh is not signed in', async () => {
      const args = machine();
      world.fail('gh-auth', 1, 'not logged in');
      await expectRefused(args, /gh is not signed in/);
    });

    it('a hybrid installation', async () => {
      const args = machine();
      world.env = { ...world.env, PROJECTMAN_MODE: 'cloud' };
      await expectRefused(args, /single-mode/);
    });

    it('a shutdown pause that is not a number', async () => {
      const args = machine();
      world.env = { ...world.env, PROJECTMAN_SHUTDOWN_PAUSE_MS: 'soon' };
      await expectRefused(args, /PROJECTMAN_SHUTDOWN_PAUSE_MS/);
    });
  });
});

describe('uninstall', () => {
  it('stops both agents and removes their files', async () => {
    const args = machine();
    await install(world.deps(), args);
    world.outLines.length = 0;
    expect(await uninstall(world.deps(), { home: world.home })).toBe(0);
    expect(world.loaded.size).toBe(0);
    expect(existsSync(serverPlist())).toBe(false);
    expect(existsSync(watcherPlist())).toBe(false);
    expect(world.output).toContain('start it by hand');
  });

  it('is repeatable', async () => {
    machine({ running: false, shutdownPlist: false });
    expect(await uninstall(world.deps(), { home: world.home })).toBe(0);
    expect(world.output).toContain('was not installed');
  });

  it('refuses while a release is in progress', async () => {
    machine();
    world.writeJournal({ step: 'build' });
    await expect(uninstall(world.deps(), { home: world.home })).rejects.toMatchObject({ exitCode: 2 });
    expect(world.keys()).toEqual([]);
  });
});

describe('status', () => {
  it('shows both agents, the server, the journal, the backup and the remote', async () => {
    const args = machine();
    await install(world.deps(), args);
    world.outLines.length = 0;
    world.writeJournal({ step: 'publish' });
    expect(await status(world.deps(), { home: world.home })).toBe(0);
    expect(world.output).toContain(`${SERVER_LABEL}: loaded, running (pid 321)`);
    expect(world.output).toContain(`${WATCHER_LABEL}: loaded, running`);
    expect(world.output).toContain(`running commit: ${OLD}`);
    expect(world.output).toContain('pause: none');
    expect(world.output).toContain('journal: release rel_1, step publish');
    expect(world.output).toContain('latest backup: none');
    expect(world.output).toContain(`remote: ${REMOTE}`);
    expect(world.output).toContain('git ls-remote: ok');
    expect(world.output).toContain('gh auth status: ok');
    expect(world.output).not.toContain('PATH');
  });

  it('exits 1 when an agent is not loaded, and says what does not answer', async () => {
    machine({ running: false });
    expect(await status(world.deps(), { home: path.join(world.base, 'nowhere') })).toBe(1);
    expect(world.output).toContain('not loaded');
    expect(world.output).toContain('does not answer');
    expect(world.output).toContain('journal: none');
    expect(world.output).toContain('the watcher is not installed');
  });
});
