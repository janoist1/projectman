import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installMenubar, uninstallMenubar } from '../../../scripts/engine/menubar';
import type { MenubarMachine } from '../../../scripts/engine/menubar';
import type { LaunchctlResult, ServiceOptions } from '../../../scripts/engine/service';
import { EngineLocalSnapshot } from '../../../scripts/engine/snapshot';
import { runEngineCli } from '../../../scripts/engine/commands';

const ROOT = realpathSync(fileURLToPath(new URL('../../..', import.meta.url)));
const ok = { status: 0, stdout: '', stderr: '' };
describe('engine menu bar installation', () => {
  let base: string;
  let calls: string[][];
  let failures: Record<string, LaunchctlResult>;
  let options: ServiceOptions & MenubarMachine;
  const app = () => path.join(options.applicationsDir, 'projectman motor.app');
  const plist = () => path.join(options.agentsDir, 'com.projectman.engine-menubar.plist');
  beforeEach(() => {
    base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'engine-menubar-')));
    calls = [];
    failures = {};
    const bin = path.join(base, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'EngineMenu'), 'binary', { mode: 0o755 });
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
      sleep: () => undefined,
      launchctl: (args) => {
        calls.push(['launchctl', ...args]);
        return failures[args[0]!] ?? ok;
      },
      run: (command, args) => {
        calls.push([command, ...args]);
        return failures[command] ?? { ...ok, stdout: args.includes('--show-bin-path') ? bin : '' };
      },
    };
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));
  it('builds, signs, assembles the bundle and starts the agent without shell environment', () => {
    installMenubar(options);
    expect(calls.map((c) => c.slice(0, 2))).toEqual([
      ['swift', '--version'],
      ['swift', 'build'],
      ['swift', 'build'],
      ['codesign', '--force'],
      ['launchctl', 'bootout'],
      ['launchctl', 'bootstrap'],
    ]);
    expect(readFileSync(path.join(app(), 'Contents/MacOS/EngineMenu'), 'utf8')).toBe('binary');
    expect(existsSync(path.join(app(), 'Contents/Resources/hu.lproj/Localizable.strings'))).toBe(true);
    const text = readFileSync(plist(), 'utf8');
    expect(text).toContain(path.join(app(), 'Contents/MacOS/EngineMenu'));
    expect(text).toMatch(/<key>SuccessfulExit<\/key><false\/>/);
    expect(text).not.toContain('EnvironmentVariables');
    expect(JSON.parse(readFileSync(path.join(options.supportDir, 'menubar.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      node: '/opt/node',
      root: ROOT,
      home: options.home,
      path: '/usr/bin',
    });
  });
  it('reports a missing toolchain before building', () => {
    failures.swift = { status: 1, stdout: '', stderr: 'not found' };
    expect(() => installMenubar(options)).toThrow(/xcode-select --install/);
    expect(calls).toHaveLength(1);
  });
  it('keeps the installed app when the new build fails', () => {
    installMenubar(options);
    calls.length = 0;
    options.run = (command, args) => {
      calls.push([command, ...args]);
      return args[0] === 'build' ? { status: 1, stdout: '', stderr: 'compiler failed' } : ok;
    };
    expect(() => installMenubar(options)).toThrow(/compiler failed/);
    expect(readFileSync(path.join(app(), 'Contents/MacOS/EngineMenu'), 'utf8')).toBe('binary');
    expect(calls.some((c) => c[0] === 'launchctl')).toBe(false);
  });
  it('cleans the staged app after signing failure and preserves the old bundle', () => {
    installMenubar(options);
    failures.codesign = { status: 1, stdout: '', stderr: 'signing failed' };
    expect(() => installMenubar(options)).toThrow(/signing failed/);
    expect(existsSync(app())).toBe(true);
    expect(existsSync(path.join(options.applicationsDir, '.projectman motor.app.new'))).toBe(false);
  });
  it.each([
    ['linux', '6.0', 'macOS'],
    ['darwin', '21.6', 'macOS 13'],
  ] as const)('rejects unsupported system %s %s', (platform, osRelease, message) => {
    expect(() => installMenubar({ ...options, platform, osRelease })).toThrow(message);
    expect(calls).toEqual([]);
  });
  it('replaces an existing bundle on reinstall', () => {
    installMenubar(options);
    writeFileSync(path.join(base, 'bin/EngineMenu'), 'updated');
    installMenubar(options);
    expect(readFileSync(path.join(app(), 'Contents/MacOS/EngineMenu'), 'utf8')).toBe('updated');
    expect(existsSync(path.join(options.applicationsDir, '.projectman motor.app.old'))).toBe(false);
  });
  it('removes the app, configuration, agent and build cache', () => {
    installMenubar(options);
    mkdirSync(options.buildDir);
    uninstallMenubar(options);
    for (const file of [app(), plist(), options.buildDir, path.join(options.supportDir, 'menubar.json')])
      expect(existsSync(file)).toBe(false);
  });
  it('restores the previous bundle and metadata when activation fails', () => {
    installMenubar(options);
    const previous = readFileSync(plist(), 'utf8');
    writeFileSync(path.join(base, 'bin/EngineMenu'), 'updated');
    failures.bootstrap = { status: 1, stdout: '', stderr: 'background item disabled' };
    expect(() => installMenubar(options)).toThrow(/background item disabled/);
    expect(readFileSync(path.join(app(), 'Contents/MacOS/EngineMenu'), 'utf8')).toBe('binary');
    expect(readFileSync(plist(), 'utf8')).toBe(previous);
  });
  it('uninstalls idempotently on an empty machine', () => {
    failures.bootout = { status: 113, stdout: '', stderr: 'not found' };
    expect(() => uninstallMenubar(options)).not.toThrow();
  });
  it('does not delete an app whose job could not be unloaded', () => {
    installMenubar(options);
    failures.bootout = { status: 1, stdout: '', stderr: 'refused' };
    expect(() => uninstallMenubar(options)).toThrow(/refused/);
    expect(existsSync(app())).toBe(true);
  });
  it('routes app uninstall through the CLI', async () => {
    const output: string[] = [];
    expect(
      await runEngineCli(['app', 'uninstall', '--home', options.home], {
        env: { PATH: '/usr/bin' },
        cwd: ROOT,
        readStdin: async () => null,
        out: (line) => output.push(line),
        err: (line) => output.push(line),
        startEngine: async () => 0,
        isRunning: () => false,
        launchd: options,
        menubar: options,
      }),
    ).toBe(0);
    expect(calls[0]).toEqual(['launchctl', 'bootout', 'gui/501/com.projectman.engine-menubar']);
  });
});

describe('Swift contract fixtures', () => {
  const fixtures = path.join(ROOT, 'deploy/mac/menubar/Tests/EngineMenuCoreTests/Fixtures');
  it.each(['running', 'no-cloud', 'stopped', 'not-initialised'])(
    'matches the strict snapshot contract: %s',
    (state) => {
      expect(() =>
        EngineLocalSnapshot.parse(
          JSON.parse(readFileSync(path.join(fixtures, `status-${state}.json`), 'utf8')),
        ),
      ).not.toThrow();
    },
  );
  it('matches the JSON log contract', () => {
    const logs: unknown = JSON.parse(readFileSync(path.join(fixtures, 'logs.json'), 'utf8'));
    expect(logs).toEqual({ out: [expect.any(String)], err: [] });
  });
});
