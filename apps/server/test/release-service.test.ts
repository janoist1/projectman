import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLocalLock, JOURNAL_FILE } from '../../../scripts/release/journal';
import {
  buildWatcherPlist,
  installedWatcherConfig,
  installWatcher,
  START_INTERVAL_SECONDS,
  uninstallWatcher,
  watcherCli,
  watcherLauncher,
  watcherState,
  WATCHER_LABEL,
} from '../../../scripts/release/service';
import { installedProgramArguments } from '../../../scripts/live/plist';
import { FakeLaunchd } from './helpers/fake-launchd';

let launchd: FakeLaunchd;
beforeEach(() => {
  launchd = new FakeLaunchd();
});
afterEach(() => launchd.cleanup());

const plistInput = (env: NodeJS.ProcessEnv = {}) => ({
  root: '/Users/me/projectman-admin',
  nodePath: '/opt/homebrew/bin/node',
  env: { PATH: '/opt/homebrew/bin:/usr/bin', ...env },
  userHome: '/Users/me',
  configFile: '/Users/me/.config/projectman/cloud/release.json',
  logFile: '/Users/me/.config/projectman/cloud/release-state/watcher.log',
});

describe('the hybrid release watcher plist (PM-751)', () => {
  it('starts one round a minute from the named launcher, with node, tsx and the configuration', () => {
    const text = buildWatcherPlist(plistInput());
    expect(installedProgramArguments(text)).toEqual([
      watcherLauncher('/Users/me/projectman-admin'),
      '/opt/homebrew/bin/node',
      '--import',
      'tsx',
      watcherCli('/Users/me/projectman-admin'),
      'watch',
      '--config',
      '/Users/me/.config/projectman/cloud/release.json',
    ]);
    expect(text).toMatch(new RegExp(`<key>StartInterval</key>\\s*<integer>${START_INTERVAL_SECONDS}</integer>`));
    expect(START_INTERVAL_SECONDS).toBe(60);
    expect(text).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    // A second round never starts while one runs, and a failed round is not restarted at once.
    expect(text).not.toContain('KeepAlive');
  });

  it('passes HOME, PATH, LANG and TZ and nothing else', () => {
    const text = buildWatcherPlist(
      plistInput({
        LANG: 'hu_HU.UTF-8',
        TZ: 'Europe/Budapest',
        ANTHROPIC_API_KEY: 'sk-ant-secret',
        OPENAI_API_KEY: 'sk-secret',
        GH_TOKEN: 'ghp_secret',
        AWS_ACCESS_KEY_ID: 'AKIASECRET',
        SSH_AUTH_SOCK: '/tmp/agent',
      }),
    );
    const block = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text)![1]!;
    expect([...block.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1])).toEqual([
      'HOME',
      'PATH',
      'LANG',
      'TZ',
    ]);
    for (const secret of ['sk-ant-secret', 'sk-secret', 'ghp_secret', 'AKIASECRET', '/tmp/agent'])
      expect(text).not.toContain(secret);
  });

  it("leaves a run's node_modules/.bin folders out of PATH and refuses an empty PATH", () => {
    const text = buildWatcherPlist(plistInput({ PATH: '/x/node_modules/.bin:/opt/homebrew/bin' }));
    expect(text).toContain('<string>/opt/homebrew/bin</string>');
    expect(text).not.toContain('node_modules');
    expect(() => buildWatcherPlist(plistInput({ PATH: '' }))).toThrow(/PATH is empty/);
  });

  it('round-trips a configuration path with XML characters', () => {
    const configFile = '/Users/me/.config/projectman/cloud/a&b<c>"d".json';
    expect(installedWatcherConfig(buildWatcherPlist({ ...plistInput(), configFile }))).toBe(configFile);
  });
});

describe('install (PM-751)', () => {
  const install = () => installWatcher(launchd.deps(), { root: launchd.root, loaded: launchd.loadedConfig() });
  const stateFile = (name: string) => path.join(launchd.stateDir, name);

  it('writes the plist (0644), loads the job and names the stable checkout and this node', async () => {
    expect(await install()).toBe('installed');
    const file = launchd.plist(WATCHER_LABEL);
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
    const args = installedProgramArguments(fs.readFileSync(file, 'utf8'))!;
    expect(args[0]).toBe(watcherLauncher(launchd.root));
    expect(args[1]).toBe(process.execPath);
    expect(installedWatcherConfig(fs.readFileSync(file, 'utf8'))).toBe(launchd.configFile);
    expect(await watcherState(launchd.deps())).toEqual({ installed: true, loaded: true, running: false });
    expect(launchd.calls.filter((call) => call.startsWith('bootstrap'))).toEqual([`bootstrap ${WATCHER_LABEL}`]);
    // The lock the install took is gone: a round may start.
    expect(fs.existsSync(stateFile('watch.lock'))).toBe(false);
  });

  it('changes nothing when the same plist is loaded already', async () => {
    await install();
    launchd.calls.length = 0;
    expect(await install()).toBe('unchanged');
    expect(launchd.calls.every((call) => call.startsWith('print'))).toBe(true);
  });

  it('boots the old job out before it writes another plist', async () => {
    await install();
    launchd.calls.length = 0;
    const other = launchd.configFile.replace('release.json', 'other.json');
    fs.writeFileSync(other, '{}\n', { mode: 0o600 });
    await installWatcher(launchd.deps(), {
      root: launchd.root,
      loaded: { ...launchd.loadedConfig(), configFile: other },
    });
    expect(launchd.calls.filter((call) => !call.startsWith('print'))).toEqual([
      `bootout ${WATCHER_LABEL}`,
      `bootstrap ${WATCHER_LABEL}`,
    ]);
    expect(installedWatcherConfig(fs.readFileSync(launchd.plist(WATCHER_LABEL), 'utf8'))).toBe(other);
  });

  it('keeps the old plist when the old job cannot be unloaded', async () => {
    await install();
    const before = fs.readFileSync(launchd.plist(WATCHER_LABEL), 'utf8');
    launchd.bootoutStatus = 5;
    const other = launchd.configFile.replace('release.json', 'other.json');
    await expect(
      installWatcher(launchd.deps(), { root: launchd.root, loaded: { ...launchd.loadedConfig(), configFile: other } }),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(fs.readFileSync(launchd.plist(WATCHER_LABEL), 'utf8')).toBe(before);
  });

  it('refuses a checkout inside a member workspace and writes nothing', async () => {
    const workspace = path.join(launchd.homeDir, '.projectman', 'workspaces', 'PM', 'dev', 'repo');
    fs.mkdirSync(path.join(workspace, 'scripts', 'release', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'scripts', 'release', 'cli.ts'), '');
    fs.writeFileSync(path.join(workspace, 'scripts', 'release', 'bin', 'projectman-hybrid-release-watcher'), '', {
      mode: 0o755,
    });
    await expect(
      installWatcher(launchd.deps(), { root: workspace, loaded: launchd.loadedConfig() }),
    ).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining('member workspace') });
    expect(fs.existsSync(launchd.plist(WATCHER_LABEL))).toBe(false);
    expect(launchd.calls).toEqual([]);
  });

  it.each([
    ['a relative path', 'projectman-admin'],
    ['a path that is not normalized', '/tmp/../tmp/x'],
    ['a missing checkout', '/nonexistent/checkout'],
  ])('refuses %s', async (_name, root) => {
    await expect(installWatcher(launchd.deps(), { root, loaded: launchd.loadedConfig() })).rejects.toMatchObject({
      exitCode: 2,
    });
    expect(fs.existsSync(launchd.plist(WATCHER_LABEL))).toBe(false);
  });

  it('refuses a launcher that is not executable and a node that does not exist', async () => {
    fs.chmodSync(watcherLauncher(launchd.root), 0o644);
    await expect(install()).rejects.toMatchObject({ message: expect.stringContaining('not executable') });
    fs.chmodSync(watcherLauncher(launchd.root), 0o755);
    await expect(
      installWatcher(launchd.deps({ nodePath: '/nonexistent/node' }), {
        root: launchd.root,
        loaded: launchd.loadedConfig(),
      }),
    ).rejects.toMatchObject({ exitCode: 2 });
  });

  it('refuses while a journal exists, a corrupt one included, and replaces nothing', async () => {
    await install();
    const before = fs.readFileSync(launchd.plist(WATCHER_LABEL), 'utf8');
    fs.writeFileSync(stateFile(JOURNAL_FILE), 'not json', { mode: 0o600 });
    launchd.calls.length = 0;
    const other = launchd.configFile.replace('release.json', 'other.json');
    await expect(
      installWatcher(launchd.deps(), { root: launchd.root, loaded: { ...launchd.loadedConfig(), configFile: other } }),
    ).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining('in progress') });
    expect(fs.readFileSync(launchd.plist(WATCHER_LABEL), 'utf8')).toBe(before);
    expect(launchd.calls).toEqual([]);
  });

  it('refuses while a round holds the lock', async () => {
    fs.mkdirSync(launchd.stateDir, { mode: 0o700 });
    const lock = acquireLocalLock(launchd.stateDir);
    try {
      await expect(install()).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining('another') });
      expect(launchd.calls).toEqual([]);
    } finally {
      lock.release();
    }
  });

  it('is macOS only', async () => {
    launchd.platform = 'linux';
    await expect(install()).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining('macOS') });
  });
});

describe('uninstall and the state (PM-751)', () => {
  const install = () => installWatcher(launchd.deps(), { root: launchd.root, loaded: launchd.loadedConfig() });
  const uninstall = () => uninstallWatcher(launchd.deps(), launchd.loadedConfig());

  it('unloads and removes the job and keeps the state directory', async () => {
    await install();
    fs.writeFileSync(path.join(launchd.stateDir, 'last-error.json'), '{}\n', { mode: 0o600 });
    expect(await uninstall()).toBe('removed');
    expect(fs.existsSync(launchd.plist(WATCHER_LABEL))).toBe(false);
    expect(launchd.loaded.has(WATCHER_LABEL)).toBe(false);
    expect(fs.existsSync(path.join(launchd.stateDir, 'last-error.json'))).toBe(true);
    expect(await watcherState(launchd.deps())).toEqual({ installed: false, loaded: false, running: false });
  });

  it('says so when nothing was installed', async () => {
    expect(await uninstall()).toBe('absent');
  });

  it('refuses while a journal is not finished and unloads nothing', async () => {
    await install();
    fs.writeFileSync(path.join(launchd.stateDir, JOURNAL_FILE), 'not json', { mode: 0o600 });
    launchd.calls.length = 0;
    await expect(uninstall()).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining('in progress') });
    expect(fs.existsSync(launchd.plist(WATCHER_LABEL))).toBe(true);
    expect(launchd.calls).toEqual([]);
  });

  it('shows a running round in the state', async () => {
    await install();
    launchd.jobState = 'running';
    expect(await watcherState(launchd.deps())).toEqual({ installed: true, loaded: true, running: true });
  });
});
