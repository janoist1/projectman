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
import {
  installService,
  PLIST_TEMPLATE,
  plistString,
  serviceInstallation,
  servicePaths,
} from '../../../scripts/engine/service';
import type { ServiceOptions } from '../../../scripts/engine/service';
import { switchService } from '../../../scripts/engine/service-switch';
import { readSwitchState, switchPaths } from '../../../scripts/engine/switch-state';
import type { EngineSwitchState } from '../../../scripts/engine/switch-state';
import { buildSnapshot, EngineLocalSnapshot } from '../../../scripts/engine/snapshot';
import { readEngineStatus } from '../src/engine-link/engine-status';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const TEMPLATE = readFileSync(path.join(ROOT, PLIST_TEMPLATE), 'utf8');
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);

describe('package service switch', () => {
  let base: string;
  let options: ServiceOptions & { isRunning: (pid: number) => boolean; now: () => number };
  let next: string;
  let original: Buffer;
  let pid: number | null;
  let generation: number;
  let calls: string[][];
  let elapsed: number;
  let targetFailure: 'version' | 'connection' | 'bootstrap' | 'stale' | null;
  let rollbackFailure: boolean;
  let previousConnected: boolean;

  const plistFile = () => servicePaths(options).plist;
  const paths = () => switchPaths(options.home);
  const packageAt = (root: string, version: string) => {
    mkdirSync(path.join(root, 'bin'), { recursive: true });
    mkdirSync(path.join(root, 'apps/server/dist'), { recursive: true });
    mkdirSync(path.dirname(path.join(root, PLIST_TEMPLATE)), { recursive: true });
    writeFileSync(path.join(root, PLIST_TEMPLATE), TEMPLATE);
    writeFileSync(path.join(root, 'bin/node'), '');
    writeFileSync(path.join(root, 'apps/server/dist/index.js'), '');
    writeFileSync(
      path.join(root, 'engine-package.json'),
      JSON.stringify({
        schemaVersion: 1,
        version,
        tag: null,
        node: '22.12.0',
        arch: 'arm64',
        builtAt: '2026-10-29T12:00:00Z',
      }),
    );
  };
  const statusFile = () => path.join(options.home, 'engine-status.json');
  const writeStatus = (version: string, connected = true) =>
    writeFileSync(
      statusFile(),
      JSON.stringify({
        pid,
        bootId: String(generation),
        startedAt: '2026-10-29T12:00:00Z',
        updatedAt: '2026-10-29T12:00:00Z',
        version,
        connection: connected ? 'connected' : 'connecting',
        attempts: 0,
        pendingEvents: 0,
        droppedEvents: 0,
        running: [],
      }),
    );
  const state = (phase: EngineSwitchState['phase'] = 'switching'): EngineSwitchState => ({
    schemaVersion: 1,
    phase,
    target: { version: NEW, tag: null },
    previous: { version: OLD, tag: null },
    startedAt: '2026-10-29T12:00:00Z',
    updatedAt: '2026-10-29T12:00:00Z',
    error: null,
  });
  const interrupt = () => {
    writeFileSync(paths().state, JSON.stringify(state()));
    writeFileSync(paths().previous, original);
    writeFileSync(paths().lock, '999999');
    // The new plist is present but its process never completed verification.
    writeFileSync(plistFile(), original.toString('utf8').replaceAll(options.root, next));
    pid = null;
  };
  const snapshot = () =>
    buildSnapshot({
      home: options.home,
      now: () => new Date(options.now()),
      isRunning: options.isRunning,
      pathEnv: options.pathEnv,
      launchd: options,
    });

  beforeEach(async () => {
    base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'engine-switch-')));
    next = path.join(base, 'new & package');
    pid = null;
    generation = 0;
    elapsed = 0;
    calls = [];
    targetFailure = null;
    rollbackFailure = false;
    previousConnected = true;
    options = {
      home: path.join(base, 'home'),
      root: path.join(base, 'old'),
      agentsDir: path.join(base, 'LaunchAgents'),
      nodePath: '/checkout/node',
      pathEnv: '/login/a&b:/usr/bin',
      uid: 501,
      platform: 'darwin',
      out: () => undefined,
      now: () => Date.parse('2026-10-29T12:00:00Z') + elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
      isRunning: (value) => value === process.pid || value === pid,
      launchctl: (args) => {
        calls.push(args);
        if (args[0] === 'print')
          return {
            status: pid === null ? 113 : 0,
            stdout: pid === null ? '' : `state = running\npid = ${pid}\n`,
            stderr: '',
          };
        if (args[0] === 'bootout') pid = null;
        if (args[0] === 'bootstrap') {
          const target = plistString(readFileSync(plistFile(), 'utf8'), 'WorkingDirectory') === next;
          if ((target && targetFailure === 'bootstrap') || (!target && rollbackFailure))
            return { status: 1, stdout: '', stderr: 'fake bootstrap failure' };
          generation += 1;
          pid = generation + 100;
          if (!(target && targetFailure === 'stale'))
            writeStatus(
              target && targetFailure !== 'version' ? NEW : OLD,
              target ? targetFailure !== 'connection' : previousConnected,
            );
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    };
    packageAt(options.root, OLD);
    packageAt(next, NEW);
    await installService(options);
    // Include bytes that rendering would discard: rollback must restore the file itself.
    writeFileSync(plistFile(), `${readFileSync(plistFile(), 'utf8')}\n<!-- original bytes: é -->\r\n`);
    original = readFileSync(plistFile());
    calls = [];
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('installs the package node and root and identifies its manager in the snapshot', () => {
    const text = original.toString('utf8');
    expect(text).toContain(`<string>${options.root}/bin/node</string>`);
    expect(serviceInstallation(text)).toEqual({
      manager: 'app',
      package: { version: OLD, tag: null, root: options.root },
    });
    const result = EngineLocalSnapshot.parse(snapshot());
    expect(result.service.manager).toBe('app');
    expect(result.package?.root).toBe(options.root);
    expect(result.switch).toBeNull();
  });

  it('switches to the target preserving the installed PATH and clears transient files', async () => {
    const installedPath = `${options.pathEnv}:/custom/node_modules/.bin`;
    writeFileSync(
      plistFile(),
      original.toString('utf8').replace(':/usr/bin</string>', ':/usr/bin:/custom/node_modules/.bin</string>'),
    );
    await switchService({ ...options, pathEnv: '/wrong/path' }, { to: next });
    const text = readFileSync(plistFile(), 'utf8');
    expect(plistString(text, 'WorkingDirectory')).toBe(next);
    expect(plistString(text, 'PATH')).toBe(installedPath);
    expect(text).toContain('new &amp; package/bin/node');
    expect(readEngineStatus(statusFile())?.version).toBe(NEW);
    expect(Object.values(paths()).some(existsSync)).toBe(false);
    expect(calls.some((call) => call.includes('-k'))).toBe(false);
  });

  it('defaults to the calling package root', async () => {
    await switchService({ ...options, root: next });
    expect(plistString(readFileSync(plistFile(), 'utf8'), 'WorkingDirectory')).toBe(next);
  });

  it.each(['version', 'connection', 'bootstrap', 'stale'] as const)(
    'restores the exact previous bytes after target %s failure',
    async (failure) => {
      targetFailure = failure;
      await expect(switchService(options, { to: next })).rejects.toMatchObject({
        code: 'switch_rolled_back',
      });
      expect(readFileSync(plistFile())).toEqual(original);
      expect(readSwitchState(options.home)?.phase).toBe('rolled_back');
      expect(readEngineStatus(statusFile())?.version).toBe(OLD);
      expect(existsSync(paths().lock)).toBe(false);
      expect(existsSync(paths().previous)).toBe(true);
      if (failure !== 'bootstrap') expect(elapsed).toBe(120_000);
    },
  );

  it('does not require a connection when the previous engine was disconnected', async () => {
    writeStatus(OLD, false);
    targetFailure = 'connection';
    await switchService(options, { to: next });
    expect(readSwitchState(options.home)).toBeNull();
  });

  it('records recovery_required when the previous service cannot bootstrap', async () => {
    targetFailure = 'bootstrap';
    rollbackFailure = true;
    await expect(switchService(options, { to: next })).rejects.toMatchObject({
      code: 'switch_recovery_required',
    });
    expect(readFileSync(plistFile())).toEqual(original);
    expect(snapshot().switch?.phase).toBe('recovery_required');
  });

  it('preserves the recovery backup and state when another switch is requested', async () => {
    writeFileSync(paths().previous, original);
    const pending = JSON.stringify(state('recovery_required'));
    writeFileSync(paths().state, pending);
    writeFileSync(plistFile(), original.toString('utf8').replaceAll(options.root, next));
    const current = readFileSync(plistFile());
    await expect(switchService(options, { to: next })).rejects.toMatchObject({
      code: 'switch_recovery_required',
    });
    expect(readFileSync(paths().previous)).toEqual(original);
    expect(readFileSync(paths().state, 'utf8')).toBe(pending);
    expect(readFileSync(plistFile())).toEqual(current);
    expect(calls).toEqual([]);
  });

  it('leaves the engine and state untouched if preparing the backup fails', async () => {
    mkdirSync(`${paths().previous}.tmp`);
    await expect(switchService(options, { to: next })).rejects.toThrow();
    expect(existsSync(paths().state)).toBe(false);
    expect(readFileSync(plistFile())).toEqual(original);
    expect(calls).toEqual([]);
  });

  it('restores the saved bytes even when the previous version is unknown', async () => {
    interrupt();
    writeFileSync(paths().state, JSON.stringify({ ...state(), previous: null }));
    await expect(switchService(options, { to: next })).rejects.toMatchObject({
      code: 'switch_recovery_required',
    });
    expect(readFileSync(plistFile())).toEqual(original);
    expect(readSwitchState(options.home)?.phase).toBe('recovery_required');
    expect(calls.some((call) => call[0] === 'bootstrap')).toBe(true);
  });

  it('reports corruption as a recovery snapshot without rewriting the damaged state', () => {
    writeFileSync(paths().state, '{broken');
    const result = EngineLocalSnapshot.parse(snapshot());
    expect(result.service.manager).toBe('app');
    expect(result.switch).toMatchObject({
      phase: 'recovery_required',
      error: { code: 'switch_state_invalid' },
    });
    expect(readFileSync(paths().state, 'utf8')).toBe('{broken');
  });

  it('recovers an interrupted switch before looking at another target', async () => {
    interrupt();
    previousConnected = false;
    await expect(switchService(options, { to: '/invalid' })).rejects.toMatchObject({
      code: 'switch_rolled_back',
    });
    expect(readFileSync(plistFile())).toEqual(original);
    expect(readSwitchState(options.home)?.phase).toBe('rolled_back');
  });

  it('keeps an interrupted switch recoverable when the backup is missing', async () => {
    interrupt();
    rmSync(paths().previous);
    await expect(switchService(options, { to: next })).rejects.toMatchObject({
      code: 'switch_recovery_required',
    });
    expect(calls).toEqual([]);
  });

  it('refuses a checkout service without touching launchd', async () => {
    rmSync(path.join(options.root, 'engine-package.json'));
    expect(serviceInstallation(original.toString('utf8')).manager).toBe('checkout');
    await expect(switchService(options, { to: next })).rejects.toMatchObject({
      code: 'switch_checkout_engine',
    });
    expect(calls).toEqual([]);
  });

  it.each(['manifest', 'node'] as const)(
    'refuses a target with missing %s before stopping the service',
    async (missing) => {
      rmSync(path.join(next, missing === 'manifest' ? 'engine-package.json' : 'bin/node'));
      await expect(switchService(options, { to: next })).rejects.toMatchObject({
        code: 'switch_target_invalid',
      });
      expect(calls).toEqual([]);
    },
  );

  it.each([false, true])('refuses a live lock (clear=%s)', async (clear) => {
    writeFileSync(paths().lock, String(process.pid));
    await expect(switchService(options, { to: next, clear })).rejects.toMatchObject({ code: 'switch_busy' });
    expect(readFileSync(paths().lock, 'utf8')).toBe(String(process.pid));
    expect(calls).toEqual([]);
  });

  it('reclaims a dead owner lock', async () => {
    writeFileSync(paths().lock, '999999');
    await switchService(options, { to: next });
    expect(readEngineStatus(statusFile())?.version).toBe(NEW);
  });

  it.each(['rolled_back', 'recovery_required'] as const)('clears %s and the saved plist', async (phase) => {
    writeFileSync(paths().state, JSON.stringify(state(phase)));
    writeFileSync(paths().previous, original);
    await switchService(options, { clear: true });
    expect(Object.values(paths()).some(existsSync)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('refuses to clear switching even after its owner died', async () => {
    interrupt();
    await expect(switchService(options, { clear: true })).rejects.toMatchObject({
      code: 'switch_in_progress',
    });
    expect(readSwitchState(options.home)?.phase).toBe('switching');
    expect(calls).toEqual([]);
  });
});
