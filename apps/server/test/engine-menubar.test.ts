import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uninstallMenubar } from '../../../scripts/engine/menubar';
import type { MenubarMachine } from '../../../scripts/engine/menubar';
import type { LaunchctlResult, ServiceOptions } from '../../../scripts/engine/service';
import { EngineLocalSnapshot } from '../../../scripts/engine/snapshot';
import { runEngineCli } from '../../../scripts/engine/commands';

const ROOT = realpathSync(fileURLToPath(new URL('../../..', import.meta.url)));
const ok = { status: 0, stdout: '', stderr: '' };
describe('removing the menu bar app of PM-1088', () => {
  let base: string;
  let calls: string[][];
  let failures: Record<string, LaunchctlResult>;
  let options: ServiceOptions & MenubarMachine;
  const app = () => path.join(options.applicationsDir, 'projectman motor.app');
  const plist = () => path.join(options.agentsDir, 'com.projectman.engine-menubar.plist');
  const config = () => path.join(options.supportDir, 'menubar.json');
  const cli = (argv: string[], output: string[] = []) =>
    runEngineCli(argv, {
      env: { PATH: '/usr/bin' },
      cwd: ROOT,
      readStdin: async () => null,
      out: (line) => output.push(line),
      err: (line) => output.push(line),
      startEngine: async () => 0,
      isRunning: () => false,
      launchd: options,
      menubar: options,
    });
  beforeEach(() => {
    base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'engine-menubar-')));
    calls = [];
    failures = {};
    options = {
      root: ROOT,
      home: path.join(base, 'home'),
      nodePath: '/opt/node',
      pathEnv: '/usr/bin',
      uid: 501,
      platform: 'darwin',
      osRelease: '23.6.0',
      agentsDir: path.join(base, 'agents'),
      applicationsDir: path.join(base, 'Applications'),
      supportDir: path.join(base, 'support'),
      buildDir: path.join(base, 'build'),
      out: () => undefined,
      sleep: async () => undefined,
      launchctl: (args) => {
        calls.push(['launchctl', ...args]);
        return failures[args[0]!] ?? ok;
      },
    };
    // What `app install` of PM-1088 left behind.
    for (const dir of [app(), options.agentsDir, options.supportDir, options.buildDir])
      mkdirSync(dir, { recursive: true });
    writeFileSync(plist(), '<plist/>');
    writeFileSync(config(), '{}');
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));
  it('removes the app, configuration, agent and build cache', () => {
    uninstallMenubar(options);
    for (const file of [app(), plist(), options.buildDir, config()]) expect(existsSync(file)).toBe(false);
  });
  it('uninstalls idempotently on an empty machine', () => {
    rmSync(base, { recursive: true, force: true });
    failures.bootout = { status: 113, stdout: '', stderr: 'not found' };
    expect(() => uninstallMenubar(options)).not.toThrow();
  });
  it('does not delete an app whose job could not be unloaded', () => {
    failures.bootout = { status: 1, stdout: '', stderr: 'refused' };
    expect(() => uninstallMenubar(options)).toThrow(/refused/);
    expect(existsSync(app())).toBe(true);
  });
  it('routes app uninstall through the CLI', async () => {
    expect(await cli(['app', 'uninstall', '--home', options.home])).toBe(0);
    expect(calls[0]).toEqual(['launchctl', 'bootout', 'gui/501/com.projectman.engine-menubar']);
  });
  it('retires app install: the downloaded app installs itself', async () => {
    const output: string[] = [];
    expect(await cli(['app', 'install', '--home', options.home], output)).toBe(1);
    expect(output.join('\n')).toContain('REFUSED [app_install_retired]');
    expect(calls).toEqual([]);
  });
});

describe('Swift contract fixtures', () => {
  const fixtures = path.join(ROOT, 'deploy/mac/menubar/Tests/EngineMenuCoreTests/Fixtures');
  it.each(readdirSync(fixtures).filter((name) => /^status-.*\.json$/.test(name)))(
    'matches the strict snapshot contract: %s',
    (state) => {
      expect(() =>
        EngineLocalSnapshot.parse(JSON.parse(readFileSync(path.join(fixtures, state), 'utf8'))),
      ).not.toThrow();
    },
  );
  it('matches the JSON log contract', () => {
    const logs: unknown = JSON.parse(readFileSync(path.join(fixtures, 'logs.json'), 'utf8'));
    expect(logs).toEqual({ out: [expect.any(String)], err: [] });
  });
});
