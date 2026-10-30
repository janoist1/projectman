import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { install, status, uninstall } from '../../../scripts/live/install';
import type { InstallArgs } from '../../../scripts/live/install';
import { installedProgramArguments } from '../../../scripts/live/plist';
import { plistFile, SERVER_LABEL } from '../../../scripts/live/paths';
import { LiveWorld, OLD } from './helpers/live-world';

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
  };
}

const serverPlist = () => plistFile(world.userHome, SERVER_LABEL);

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
  it('takes over the running server: pause, stop, load the server agent, resume', async () => {
    const args = machine();
    world.env = { ...world.env, CLAUDE_BIN: '/secret/path/claude', ANTHROPIC_API_KEY: 'sk-not-for-the-file' };
    expect(await install(world.deps(), args)).toBe(0);

    const keys = world.keys();
    const bootstraps = keys
      .map((key, index) => (key === 'launchctl-bootstrap' ? index : -1))
      .filter((i) => i >= 0);
    expect(bootstraps).toHaveLength(1);
    expect(keys.indexOf('launchctl-bootout')).toBeLessThan(bootstraps[0]!);
    const ops = world.requestOps();
    expect(ops.indexOf('pause')).toBeLessThan(ops.indexOf('resume'));
    expect(world.pause).toBeNull();
    expect(world.loaded).toEqual(new Set([SERVER_LABEL]));
    expect(world.server).toEqual({ running: true, version: OLD });

    const server = readFileSync(serverPlist(), 'utf8');
    expect(server).toContain(`<string>${world.root}/apps/server/dist/index.js</string>`);
    expect(server).toContain('<key>KeepAlive</key>');
    expect(server).toContain('/secret/path/claude');
    expect(statSync(serverPlist()).mode & 0o777).toBe(0o644);

    // Only names are printed, and the billing variable is in neither file.
    expect(world.output).toContain('CLAUDE_BIN');
    expect(world.output).not.toContain('/secret/path/claude');
    for (const text of [server, world.output]) expect(text).not.toContain('sk-not-for-the-file');
    for (const text of [server]) expect(text).not.toContain('ANTHROPIC_API_KEY');
  });

  it('starts the server job through their launchers, which run the stable node', async () => {
    const args = machine();
    expect(await install(world.deps(), args)).toBe(0);
    expect(installedProgramArguments(readFileSync(serverPlist(), 'utf8'))?.slice(0, 2)).toEqual([
      `${world.root}/scripts/live/bin/projectman-live`,
      world.nodePath,
    ]);
    expect(world.output).toContain(`node: ${world.nodePath}`);
    expect(world.output).not.toContain('warning');
  });

  it('warns about a node with a version in its path when there is no other name for it', async () => {
    const args = machine();
    const versioned = path.join(world.base, 'Cellar', 'node', '23.11.0', 'bin', 'node');
    mkdirSync(path.dirname(versioned), { recursive: true });
    writeFileSync(versioned, '#!/bin/sh\n', { mode: 0o755 });
    const deps = { ...world.deps(), nodePath: versioned };
    expect(await install(deps, args)).toBe(0);
    expect(world.output).toContain('warning');
  });

  it('installs on a machine where nothing runs yet, without a pause', async () => {
    const args = machine({ running: false });
    expect(await install(world.deps(), args)).toBe(0);
    expect(world.requestOps()).not.toContain('pause');
    expect(world.server.running).toBe(true);
    expect(world.loaded.has(SERVER_LABEL)).toBe(true);
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
  });

  it('undoes the install when the new agent does not come up', async () => {
    const args = machine();
    world.brokenCommits.add(OLD);
    await expect(install(world.deps(), args)).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('did not come up'),
    });
    expect(existsSync(serverPlist())).toBe(false);
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

    it('a checkout that is not built', async () => {
      const args = machine();
      world.cleanup();
      world = new LiveWorld();
      await expectRefused({ ...args, root: world.root, home: world.home }, /built server/);
    });

    it('a checkout without its launchers', async () => {
      const args = machine();
      rmSync(path.join(world.root, 'scripts', 'live', 'bin', 'projectman-live'));
      await expectRefused(args, /projectman-live is missing or not executable/);
    });

    it('a node that does not exist', async () => {
      const args = machine();
      rmSync(world.nodePath);
      await expectRefused(args, /not an executable node/);
    });

    it('a checkout with no commit', async () => {
      const args = machine();
      world.fail('rev-parse', 128, 'fatal');
      await expectRefused(args, /commit/);
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
  it('stops the server agent and removes their files', async () => {
    const args = machine();
    await install(world.deps(), args);
    world.outLines.length = 0;
    expect(await uninstall(world.deps(), { home: world.home })).toBe(0);
    expect(world.loaded.size).toBe(0);
    expect(existsSync(serverPlist())).toBe(false);
    expect(world.output).toContain('start it by hand');
  });

  it('is repeatable', async () => {
    machine({ running: false, shutdownPlist: false });
    expect(await uninstall(world.deps(), { home: world.home })).toBe(0);
    expect(world.output).toContain('was not installed');
  });
});

describe('status', () => {
  it('names the launcher and the node of the plist', async () => {
    const args = machine();
    await install(world.deps(), args);
    world.outLines.length = 0;
    expect(await status(world.deps(), { home: world.home })).toBe(0);
    expect(world.output).toContain(`launcher: ${world.root}/scripts/live/bin/projectman-live\n`);
    expect(world.output).toContain(`node: ${world.nodePath}\n`);
  });

  it('exits 1 when the node of a plist is gone', async () => {
    const args = machine();
    await install(world.deps(), args);
    world.outLines.length = 0;
    rmSync(world.nodePath);
    expect(await status(world.deps(), { home: world.home })).toBe(1);
    expect(world.output).toContain(`node: ${world.nodePath} (MISSING`);
  });

  it('exits 1 when a launcher is gone', async () => {
    const args = machine();
    await install(world.deps(), args);
    world.outLines.length = 0;
    rmSync(path.join(world.root, 'scripts/live/bin/projectman-live'));
    expect(await status(world.deps(), { home: world.home })).toBe(1);
  });

  it('tells a plist from before the launchers to install again', async () => {
    const args = machine();
    await install(world.deps(), args);
    const old = readFileSync(serverPlist(), 'utf8').replace(
      `<string>${world.root}/scripts/live/bin/projectman-live</string>`,
      '',
    );
    writeFileSync(serverPlist(), old);
    world.outLines.length = 0;
    expect(await status(world.deps(), { home: world.home })).toBe(0);
    expect(world.output).toContain('launcher: none');
  });

  it('exits 1 when an agent is not loaded, and says what does not answer', async () => {
    machine({ running: false });
    expect(await status(world.deps(), { home: path.join(world.base, 'nowhere') })).toBe(1);
    expect(world.output).toContain('not loaded');
    expect(world.output).toContain('does not answer');
  });
});
