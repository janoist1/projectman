import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classify, runRelease } from '../../../scripts/release/commands';
import type { ReleaseDeps } from '../../../scripts/release/commands';
import { CloudError } from '../../../scripts/cloud/errors';
import { acquireLocalLock } from '../../../scripts/release/journal';
import { ControlError, RoundStopped } from '../../../scripts/release/ports';
import { FAILURES } from '../../../scripts/release/messages';
import { installWatcher, WATCHER_LABEL } from '../../../scripts/release/service';
import { FakeLaunchd } from './helpers/fake-launchd';
import { HybridWorld, NEW } from './helpers/hybrid-world';

describe('the release commands (PM-751)', () => {
  let launchd: FakeLaunchd;
  let world: HybridWorld | null;
  let errors: string[];
  beforeEach(() => {
    launchd = new FakeLaunchd();
    world = null;
    errors = [];
  });
  afterEach(async () => {
    launchd.cleanup();
    await world?.cleanup();
  });

  /** Commands over the fake launchd; `watch` and `plan` run the coordinator against the fake world once it exists. */
  function deps(overrides: Partial<ReleaseDeps> = {}): ReleaseDeps {
    return {
      watcher: launchd.deps(),
      root: launchd.root,
      err: (text) => errors.push(text),
      load: () => {
        const loaded = launchd.loadedConfig();
        return world ? { ...loaded, config: { ...loaded.config, stateDir: world.stateDir } } : loaded;
      },
      ports: ({ journal, signal, log }) => world!.ports({ journal, signal, log }),
      onInterrupt: () => () => undefined,
      ...overrides,
    };
  }
  const run = (...argv: string[]) => runRelease(argv, deps());
  const config = () => ['--config', launchd.configFile];
  const printed = () => launchd.output.join('');
  const lastLine = () => printed().trim().split('\n').at(-1)!;
  const lastError = () => {
    const file = path.join(world!.stateDir, 'last-error.json');
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as { code: string; message: string }) : null;
  };

  describe('usage', () => {
    it.each([
      ['no command', []],
      ['an unknown command', ['deploy', ...['--config', '/x']]],
      ['no configuration', ['watch']],
      ['a relative configuration', ['watch', '--config', 'release.json']],
      ['a repeated option', ['watch', '--config', '/a', '--config', '/b']],
      ['an unknown option', ['watch', '--config', '/a', '--dry-run']],
      ['an option without a value', ['watch', '--config']],
      ['an option followed by another option', ['watch', '--config', '--x']],
    ])('exits 64 on %s and touches nothing', async (_name, argv) => {
      expect(await runRelease(argv, deps())).toBe(64);
      expect(errors.join('')).toContain('usage: npm run release');
      expect(launchd.calls).toEqual([]);
      expect(fs.existsSync(launchd.stateDir)).toBe(false);
    });

    it('prints the usage for help', async () => {
      expect(await runRelease(['help'], deps())).toBe(0);
      expect(printed()).toContain('plan');
    });
  });

  describe('a bad or missing configuration', () => {
    it.each(['plan', 'watch', 'install', 'status', 'uninstall'])(
      'refuses %s with exit 2 and arms nothing',
      async (command) => {
        // The real loader: this home has no protected configuration.
        const exit = await runRelease([command, '--config', launchd.configFile], {
          ...deps(),
          load: undefined,
        });
        expect(exit).toBe(2);
        expect(errors.join('')).toMatch(/^refused: /);
        expect(launchd.calls).toEqual([]);
        expect(fs.existsSync(launchd.plist(WATCHER_LABEL))).toBe(false);
        expect(fs.existsSync(launchd.stateDir)).toBe(false);
      },
    );
  });

  describe('plan', () => {
    it('previews an approved release and writes no claim, lock, state or journal', async () => {
      world = await HybridWorld.create();
      const release = await world.approve();
      const before = fs.readdirSync(world.stateDir);
      expect(await run('plan', ...config())).toBe(0);
      expect(JSON.parse(lastLine())).toMatchObject({ state: 'ready', releaseId: release.id, commit: NEW });
      expect(fs.readdirSync(world.stateDir)).toEqual(before);
      expect(world.release(release.id).state).toBe('approved');
      expect(world.calls.prepare).toBe(0);
      expect(world.calls.importImage).toBe(0);
    });

    it('is idle without a release', async () => {
      world = await HybridWorld.create();
      expect(await run('plan', ...config())).toBe(0);
      expect(JSON.parse(lastLine())).toMatchObject({ state: 'idle' });
    });
  });

  describe('watch', () => {
    it('exits 0 when there is nothing to do and clears an earlier error', async () => {
      world = await HybridWorld.create();
      fs.writeFileSync(
        path.join(world.stateDir, 'last-error.json'),
        `${JSON.stringify({ code: 'x_old', message: 'old', at: '2026-10-17T09:00:00.000Z' })}\n`,
        { mode: 0o600 },
      );
      expect(await run('watch', ...config())).toBe(0);
      expect(printed()).toContain('no release to deploy');
      expect(lastError()).toBeNull();
      // The lock of the round is gone.
      expect(fs.existsSync(path.join(world.stateDir, 'watch.lock'))).toBe(false);
    });

    it('exits 0 when the release went live', async () => {
      world = await HybridWorld.create();
      const release = await world.approve();
      expect(await run('watch', ...config())).toBe(0);
      expect(printed()).toContain(`release ${release.id} is live`);
      expect(world.release(release.id).state).toBe('published');
      expect(lastError()).toBeNull();
    });

    it('exits 0 for a live release whose publish is pending', async () => {
      world = await HybridWorld.create();
      const release = await world.approve();
      world.publisherFails = 1;
      expect(await run('watch', ...config())).toBe(0);
      expect(printed()).toContain('its publish is pending');
      expect(world.deployment(release.id)).toMatchObject({ phase: 'live' });
    });

    it('exits 1 after a verified rollback and records the fixed failure text', async () => {
      world = await HybridWorld.create();
      const release = await world.approve();
      world.cloud.healthyAfterStart = (commit) => commit !== NEW;
      expect(await run('watch', ...config())).toBe(1);
      expect(world.release(release.id).state).toBe('failed');
      expect(lastError()).toMatchObject({
        code: 'cloud_verify_failed',
        message: FAILURES.cloud_verify_failed.message,
      });
      expect(printed()).toContain('rolled_back');
    });

    it('exits 1 on an operational failure, with a fixed text and no raw error', async () => {
      world = await HybridWorld.create();
      await world.approve();
      world.failOn('machine.verifyTarget');
      expect(await run('watch', ...config())).toBe(1);
      expect(lastError()).toMatchObject({ code: 'internal_error' });
      expect(JSON.stringify(lastError())).not.toContain('injected failure');
      expect(errors.join('')).toMatch(/^failed: /);
      expect(errors.join('')).not.toContain('injected failure');
    });

    it('exits 2 and changes nothing while another watcher holds the lock', async () => {
      world = await HybridWorld.create();
      const release = await world.approve();
      const lock = acquireLocalLock(world.stateDir);
      try {
        expect(await run('watch', ...config())).toBe(2);
        expect(errors.join('')).toContain('another release watcher');
        expect(world.release(release.id).state).toBe('approved');
      } finally {
        lock.release();
      }
    });

    it('stops at an interrupt without rolling anything back by itself', async () => {
      world = await HybridWorld.create();
      const release = await world.approve();
      const exit = await runRelease(
        ['watch', ...config()],
        deps({
          onInterrupt: (handler) => {
            handler();
            return () => undefined;
          },
        }),
      );
      expect(exit).toBe(1);
      expect(world.release(release.id).state).not.toBe('published');
      expect(world.h.repos.releaseDeployments.maintenanceHeld()).toBe(false);
    });
  });

  describe('status', () => {
    it('is one secret-free JSON line with exactly the documented fields', async () => {
      world = await HybridWorld.create();
      expect(await run('status', ...config())).toBe(0);
      const line = lastLine();
      expect(JSON.parse(line)).toEqual({
        installed: false,
        loaded: false,
        running: false,
        releaseId: null,
        phase: null,
        lastError: null,
      });
      expect(line).not.toContain(world.stateDir);
      expect(printed().trim().split('\n')).toHaveLength(1);
    });

    it('shows the installed job, the last error, and no more', async () => {
      world = await HybridWorld.create();
      await installWatcher(launchd.deps(), { root: launchd.root, loaded: deps().load!(launchd.configFile) });
      await world.approve();
      world.cloud.healthyAfterStart = (commit) => commit !== NEW;
      expect(await run('watch', ...config())).toBe(1);
      launchd.output.length = 0;
      expect(await run('status', ...config())).toBe(0);
      const status = JSON.parse(lastLine()) as Record<string, unknown>;
      expect(status).toEqual({
        installed: true,
        loaded: true,
        running: false,
        releaseId: null,
        phase: null,
        lastError: { code: 'cloud_verify_failed', message: FAILURES.cloud_verify_failed.message },
      });
    });

    it('shows a corrupt journal as its own error and not as a crash', async () => {
      world = await HybridWorld.create();
      fs.writeFileSync(path.join(world.stateDir, 'journal.json'), 'not json', { mode: 0o600 });
      expect(await run('status', ...config())).toBe(0);
      expect(JSON.parse(lastLine())).toMatchObject({ lastError: { code: 'journal_unreadable' } });
    });
  });

  describe('install and uninstall', () => {
    it('install and uninstall go through the commands and keep the state', async () => {
      world = await HybridWorld.create();
      expect(await run('install', ...config())).toBe(0);
      expect(fs.existsSync(launchd.plist(WATCHER_LABEL))).toBe(true);
      expect(await run('uninstall', ...config())).toBe(0);
      expect(fs.existsSync(launchd.plist(WATCHER_LABEL))).toBe(false);
      expect(fs.existsSync(world.stateDir)).toBe(true);
    });

    it('install refuses with exit 2 while a journal is unfinished', async () => {
      world = await HybridWorld.create();
      fs.writeFileSync(path.join(world.stateDir, 'journal.json'), 'not json', { mode: 0o600 });
      expect(await run('install', ...config())).toBe(2);
      expect(fs.existsSync(launchd.plist(WATCHER_LABEL))).toBe(false);
    });
  });
});

describe('the failure classes (PM-751)', () => {
  it('maps what escapes a round to an exit status and a short code', () => {
    expect(classify(new CloudError('x', 2))).toMatchObject({ exit: 2, code: 'refused' });
    expect(classify(new CloudError('x', 1))).toMatchObject({ exit: 1, code: 'cloud_error' });
    expect(classify(new RoundStopped('drain_wait', 'waiting'))).toEqual({
      exit: 1,
      code: 'drain_wait',
      message: 'waiting',
    });
    expect(classify(new ControlError('uncertain', 'bad_answer', 'unexpected'))).toMatchObject({
      exit: 1,
      code: 'bad_answer',
    });
    expect(classify(new Error('secret detail /Users/me'))).toEqual({
      exit: 1,
      code: 'internal_error',
      message: 'the release command failed unexpectedly',
    });
  });
});
