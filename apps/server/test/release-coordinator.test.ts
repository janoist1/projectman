import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Release } from '@projectman/shared';
import { JOURNAL_ARCHIVE_DIR, JOURNAL_FILE } from '../../../scripts/release/journal';
import { ControlError, RoundStopped } from '../../../scripts/release/ports';
import type { RoundResult } from '../../../scripts/release/ports';
import {
  Crash,
  ENGINE_ID,
  HybridWorld,
  imageOf,
  NEW,
  PREVIOUS,
  SCHEMA,
  sha,
  TARGET_HASH,
} from './helpers/hybrid-world';

describe('the hybrid release coordinator (PM-751)', () => {
  let world: HybridWorld;
  afterEach(async () => {
    await world?.cleanup();
  });

  const archived = () => {
    const dir = path.join(world.stateDir, JOURNAL_ARCHIVE_DIR);
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  };
  const journalPhase = () => {
    const read = world.journal.read();
    return read.kind === 'ok' ? read.journal.phase : null;
  };

  /** The whole system runs the new program, the release is published and the fence is down. */
  function expectLive(release: Release) {
    expect(world.release(release.id)).toMatchObject({ state: 'published', tag: expect.any(String) });
    expect(world.deployment(release.id)).toMatchObject({ phase: 'published', maintenance: false });
    expect(world.cloud.current).toEqual(imageOf(NEW));
    expect(world.h.domain.releases.appVersion()).toBe(NEW);
    expect(world.engineSim.root).toBe(path.join(world.releasesDir, `${release.id}-${NEW}`));
    expect(world.registry).toMatchObject({ online: true, version: NEW });
    expect(world.h.repos.releaseDeployments.maintenanceHeld()).toBe(false);
    expect(world.journal.read().kind).toBe('none');
  }

  /** The previous program runs on both targets, the release failed and the fence is down. */
  function expectPrevious(release: Release) {
    expect(world.release(release.id).state).toBe('failed');
    expect(world.deployment(release.id)).toMatchObject({ phase: 'failed', maintenance: false });
    expect(world.cloud.current).toEqual(imageOf(PREVIOUS));
    expect(world.h.domain.releases.appVersion()).toBe(PREVIOUS);
    expect(world.engineSim.root).toBe('/engine/previous');
    expect(world.registry).toMatchObject({ online: true, version: PREVIOUS });
    expect(world.h.repos.releaseDeployments.maintenanceHeld()).toBe(false);
    expect(world.journal.read().kind).toBe('none');
  }

  async function ready() {
    world = await HybridWorld.create();
    return world.approve();
  }

  /** The journal stops at its n-th write, on disk exactly as that write left it. */
  async function stopAt(at: number, when: 'before' | 'after' = 'after') {
    world.journal.crashAt(at, when);
    await expect(world.coordinator().round()).rejects.toBeInstanceOf(Crash);
    world.journal.clear();
  }

  describe('the way to live', () => {
    it('is idle when no release is approved', async () => {
      world = await HybridWorld.create();
      expect(await world.coordinator().round()).toEqual({ status: 'idle' });
      expect(world.journal.read().kind).toBe('none');
    });

    it('refuses to start, and to plan, a release whose id or commit has not their shape', async () => {
      const release = await ready();
      const control = world.control();
      const bad = {
        ...control,
        releaseNext: async () => ({ ...(await control.releaseNext())!, id: '../../outside' }),
      };
      await expect(world.coordinator({ control: bad }).round()).rejects.toMatchObject({ exitCode: 2 });
      expect(world.journal.read().kind).toBe('none');
      expect(world.release(release.id).state).toBe('approved');
      expect(await world.coordinator({ control: bad }).plan()).toMatchObject({
        state: 'blocked',
        releaseId: null,
        problems: ['release_invalid'],
      });
    });

    it('takes an approved release live on both targets and publishes it', async () => {
      const release = await ready();
      const result = await world.coordinator().round();
      expect(result).toEqual({ status: 'live', releaseId: release.id, publishPending: false });
      expectLive(release);
      expect(archived()).toHaveLength(1);
      expect(world.calls).toMatchObject({ importImage: 1, start: [NEW], stop: 1, restore: 0, publish: 1 });
      expect(world.heavyHeld).toBe(0);
      // The previous program stays on the machine for the rollback.
      expect(world.cloud.images.has(imageOf(PREVIOUS).imageId)).toBe(true);
    });

    it('carries nothing secret or raw into its log', async () => {
      await ready();
      await world.coordinator().round();
      expect(world.log.join('\n')).not.toMatch(/token|secret|password|\/Users\//i);
    });

    it('plans without writing anything', async () => {
      const release = await ready();
      expect(await world.coordinator().plan()).toMatchObject({
        state: 'ready',
        releaseId: release.id,
        commit: NEW,
        problems: [],
      });
      expect(world.journal.writes).toBe(0);
      expect(world.deployment(release.id)).toBeNull();
      expect(world.release(release.id).state).toBe('approved');
    });
  });

  describe('what must hold before anything is touched', () => {
    it.each([
      [
        'an engine that is not at the cloud version',
        'engine_registry_mismatch',
        () => (world.registry = { ...world.registry, version: sha(9) }),
      ],
      [
        'an engine the cloud does not see',
        'engine_registry_mismatch',
        () => (world.registry = { ...world.registry, online: false }),
      ],
      ['an unhealthy previous image', 'cloud_image_not_ready', () => (world.cloud.healthy = false)],
      ['the old watcher journal', 'old_watcher_journal_present', () => (world.oldJournal = true)],
      ['an unreadable database schema', 'cloud_schema_unknown', () => (world.cloud.schema = null)],
      ['a busy image lock', 'cloud_image_busy', () => (world.cloud.lockHeld = true)],
      ['a disconnected engine', 'engine_not_ready', () => (world.engineSim.connected = false)],
      [
        'an engine of an unknown checkout',
        'engine_commit_mismatch',
        () => (world.engineSim.root = '/engine/unknown'),
      ],
    ])('refuses %s', async (_name, problem, arrange) => {
      const release = await ready();
      arrange();
      await expect(world.coordinator().round()).rejects.toMatchObject({
        exitCode: 2,
        message: expect.stringContaining(problem),
      });
      expect(world.journal.read().kind).toBe('none');
      expect(world.deployment(release.id)).toBeNull();
      expect(world.release(release.id).state).toBe('approved');
      expect(world.calls).toMatchObject({ prepare: 0, importImage: 0, start: [], stop: 0 });
      expect(await world.coordinator().plan()).toMatchObject({ state: 'blocked', problems: [problem] });
    });

    it('does not continue a release the cloud holds without a journal here', async () => {
      const release = await ready();
      await world.h.domain.releaseDeployments.begin({
        releaseId: release.id,
        attemptId: randomUUID(),
        controllerId: randomUUID(),
        requestId: randomUUID(),
        targetHash: TARGET_HASH,
        engineId: ENGINE_ID,
        previousImage: imageOf(PREVIOUS),
      });
      await expect(world.coordinator().round()).rejects.toMatchObject({
        exitCode: 2,
        message: expect.stringContaining('no journal'),
      });
      expect(world.calls.prepare).toBe(0);
    });

    it('refuses a journal of another controller, target or configuration and leaves it', async () => {
      await ready();
      await stopAt(3);
      const file = path.join(world.stateDir, JOURNAL_FILE);
      const before = fs.readFileSync(file, 'utf8');
      const prepared = world.calls.prepare;
      const config = world.ports().config;
      for (const changed of [
        { configSha256: '0'.repeat(64) },
        { controllerId: randomUUID() },
        { targetHash: '1'.repeat(64) },
      ])
        await expect(world.coordinator({ config: { ...config, ...changed } }).round()).rejects.toMatchObject({
          exitCode: 2,
        });
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
      expect(world.calls).toMatchObject({ prepare: prepared, importImage: 0, start: [], stop: 0 });
    });
  });

  describe('before the pause: the attempt just ends', () => {
    it('ends a failed preparation without a pause, a switch or a rollback', async () => {
      const release = await ready();
      world.failOn('prepare.prepare');
      const result = await world.coordinator().round();
      expect(result).toEqual({ status: 'failed', releaseId: release.id, code: 'prepare_failed' });
      expect(world.release(release.id)).toMatchObject({
        state: 'failed',
        failure: { step: 'build', rolledBack: false },
      });
      expect(world.deployment(release.id)).toMatchObject({
        phase: 'failed',
        maintenance: false,
        pauseId: null,
      });
      expect(world.calls).toMatchObject({ importImage: 0, start: [], stop: 0, restore: 0 });
      expect(world.cloud.current).toEqual(imageOf(PREVIOUS));
      expect(world.journal.read().kind).toBe('none');
    });

    it('does not reuse a preparation directory that has no receipt', async () => {
      const release = await ready();
      await stopAt(2);
      const journal = world.journal.read();
      if (journal.kind !== 'ok') throw new Error('no journal');
      world.prepared.set(journal.journal.outputDir, 'partial');
      const result = await world.coordinator().round();
      expect(result).toEqual({ status: 'failed', releaseId: release.id, code: 'prepare_failed' });
      expect(world.calls.prepare).toBe(0);
    });

    it('ends when another party holds the instance pause', async () => {
      const release = await ready();
      await world.h.domain.pauses.pause({ scope: 'instance' }, { userId: null, source: 'control' }, {});
      const result = await world.coordinator().round();
      expect(result).toEqual({ status: 'failed', releaseId: release.id, code: 'quiesce_refused' });
      expect(world.deployment(release.id)).toMatchObject({ phase: 'failed', pauseId: null });
      expect(world.calls.importImage).toBe(0);
    });

    it('ends the attempt when the receipt changed after it was bound', async () => {
      const release = await ready();
      await stopAt(3);
      world.receiptSha = '9'.repeat(64);
      const result = await world.coordinator().round();
      expect(result).toEqual({ status: 'failed', releaseId: release.id, code: 'prepare_failed' });
      expect(world.calls.importImage).toBe(0);
      expect(world.cloud.current).toEqual(imageOf(PREVIOUS));
    });
  });

  describe('the drain', () => {
    it('gives the pause back when the work does not finish in time', async () => {
      const release = await ready();
      world.holdWork();
      const result = await world.coordinator().round();
      expect(result).toEqual({ status: 'rolled_back', releaseId: release.id, code: 'drain_timeout' });
      expectPrevious(release);
      expect(world.release(release.id).failure).toMatchObject({ step: 'pause', rolledBack: true });
      expect(world.calls).toMatchObject({ importImage: 0, start: [], stop: 0 });
    });

    it('gives the pause back without reading the schema, since nothing was switched', async () => {
      const release = await ready();
      world.holdWork();
      const control = world.control();
      const result = await world
        .coordinator({
          control: {
            ...control,
            deployGet: async (id) => {
              const view = await control.deployGet(id);
              // The database cannot be read once the pause stands (the baseline was read before).
              if (view.deployment?.pauseId) world.cloud.schema = null;
              return view;
            },
          },
        })
        .round();
      expect(result).toEqual({ status: 'rolled_back', releaseId: release.id, code: 'drain_timeout' });
      expect(world.calls).toMatchObject({ importImage: 0, start: [], stop: 0, restore: 0 });
    });

    it('gives the pause back when the heavy-run queue is never free', async () => {
      const release = await ready();
      world.heavyFree = false;
      const result = await world.coordinator().round();
      expect(result).toEqual({ status: 'rolled_back', releaseId: release.id, code: 'drain_timeout' });
      expectPrevious(release);
      expect(world.calls.stop).toBe(0);
    });

    it('waits for work that finishes in time', async () => {
      const release = await ready();
      world.holdWork();
      let sleeps = 0;
      const coordinator = world.coordinator({
        clock: {
          now: () => new Date(world.now),
          sleep: async (ms) => {
            world.now += ms;
            sleeps += 1;
            // The merge finishes during the third wait.
            if (sleeps === 3)
              world.h.repos.taskMerges.save({
                ...world.h.repos.taskMerges.list('running')[0]!,
                state: 'merged',
                step: 'finishing',
                finishedAt: '2026-01-02T00:00:00.000Z',
              });
          },
        },
      });
      expect(await coordinator.round()).toMatchObject({ status: 'live' });
      expectLive(release);
    });
  });

  describe('going back', () => {
    it('goes back when the new cloud program never becomes healthy', async () => {
      const release = await ready();
      world.cloud.healthyAfterStart = (commit) => commit !== NEW;
      const result = await world.coordinator().round();
      expect(result).toEqual({ status: 'rolled_back', releaseId: release.id, code: 'cloud_verify_failed' });
      expectPrevious(release);
      expect(world.calls.start).toEqual([NEW, PREVIOUS]);
      // The engine was never touched.
      expect(world.calls.stop).toBe(0);
      expect(world.release(release.id).failure).toMatchObject({ step: 'verify', rolledBack: true });
    });

    it('goes back when the cloud cannot take the image', async () => {
      const release = await ready();
      world.failOn('machine.importImage');
      const result = await world.coordinator().round();
      expect(result).toEqual({ status: 'rolled_back', releaseId: release.id, code: 'cloud_import_failed' });
      expectPrevious(release);
      expect(world.calls.start).toEqual([]);
    });

    it('goes back when the engine cannot be started on the new program', async () => {
      const release = await ready();
      world.failOn('engine.start');
      const result = await world.coordinator().round();
      expect(result).toEqual({ status: 'rolled_back', releaseId: release.id, code: 'engine_start_failed' });
      expectPrevious(release);
      expect(world.calls).toMatchObject({ start: [NEW, PREVIOUS], stop: 1, restore: 1 });
    });

    it('goes back when the new engine never connects, with the cloud already on the new program', async () => {
      const release = await ready();
      world.engineSim.connectsAfterStart = false;
      const result = await world.coordinator().round();
      expect(result).toEqual({ status: 'rolled_back', releaseId: release.id, code: 'engine_verify_failed' });
      expectPrevious(release);
      // The new engine was stopped before the previous one came back.
      expect(world.calls.stop).toBe(2);
    });

    it('goes back when the engine reports another commit than the one it was started on', async () => {
      const release = await ready();
      world.engineSim.reportsVersion = PREVIOUS;
      const result = await world.coordinator().round();
      expect(result).toEqual({ status: 'rolled_back', releaseId: release.id, code: 'engine_verify_failed' });
      expectPrevious(release);
    });

    it('goes back when the cloud does not accept the live report', async () => {
      const release = await ready();
      const control = world.control();
      const result = await world
        .coordinator({
          control: {
            ...control,
            change: async (body) => {
              // The server checks the registry itself: an engine that went offline right after verification is refused.
              if (body.change.kind === 'report' && body.change.report.outcome === 'live')
                world.registry = { ...world.registry, online: false };
              return control.change(body);
            },
          },
        })
        .round();
      expect(result).toEqual({ status: 'rolled_back', releaseId: release.id, code: 'live_refused' });
      expectPrevious(release);
    });

    it('survives a stop at every journal write while going back, and ends the same', async () => {
      for (const when of ['before', 'after'] as const) {
        for (let at = 8; at < 60; at += 1) {
          world = await HybridWorld.create();
          const release = await world.approve();
          world.cloud.healthyAfterStart = (commit) => commit !== NEW;
          world.journal.crashAt(at, when);
          let crashed = false;
          try {
            await world.coordinator().round();
          } catch (error) {
            if (!(error instanceof Crash)) throw error;
            crashed = true;
          }
          world.journal.clear();
          if (crashed)
            for (let round = 0; round < 6 && world.journal.read().kind !== 'none'; round += 1)
              await world.coordinator().round();
          expectPrevious(release);
          expect(world.cloud.images.has(imageOf(NEW).imageId)).toBe(true);
          await world.cleanup();
          if (!crashed) break;
        }
      }
    }, 300_000);
  });

  describe('when going back is not automatic', () => {
    it('stops in recovery when the old engine process is still alive after the boot-out', async () => {
      const release = await ready();
      world.engineSim.stopLeavesAlive = true;
      const result = await world.coordinator().round();
      expect(result).toEqual({
        status: 'recovery_required',
        releaseId: release.id,
        code: 'engine_switch_failed',
      });
      // The cloud was switched, and nothing is switched back on a guess.
      expect(world.cloud.current).toEqual(imageOf(NEW));
      expect(world.calls).toMatchObject({ stop: 1, engineStart: [], restore: 0 });
      expect(world.deployment(release.id)).toMatchObject({
        phase: 'recovery_required',
        maintenance: true,
        recovery: { code: 'engine_switch_failed' },
      });
      expect(world.release(release.id).state).toBe('deploying');
      expect(journalPhase()).toBe('recovery_required');
      // The owner is told once, and a later round neither repeats nor resolves it.
      const alerts = () =>
        world.h.domain.inbox
          .list('AR', { kind: 'alert', state: 'open' })
          .filter((item) => (item.payload as { releaseId?: string } | null)?.releaseId === release.id);
      expect(alerts()).toHaveLength(1);
      const revision = world.deployment(release.id)!.revision;
      expect(await world.coordinator().round()).toMatchObject({ status: 'recovery_required' });
      expect(world.deployment(release.id)!.revision).toBe(revision);
      expect(alerts()).toHaveLength(1);
      expect(world.calls).toMatchObject({ stop: 1, engineStart: [], restore: 0 });
      expect(world.h.repos.releaseDeployments.maintenanceHeld()).toBe(true);
    });

    it('does not go back automatically when the schema is newer than the previous program knows', async () => {
      const release = await ready();
      world.cloud.healthyAfterStart = (commit) => commit !== NEW;
      world.cloud.migrateOnStart = (commit) => (commit === NEW ? SCHEMA + 1 : null);
      const result = await world.coordinator().round();
      expect(result).toEqual({
        status: 'recovery_required',
        releaseId: release.id,
        code: 'database_incompatible',
      });
      expect(world.calls.start).toEqual([NEW]);
      expect(world.calls.restore).toBe(0);
      expect(world.deployment(release.id)).toMatchObject({
        phase: 'recovery_required',
        recovery: { code: 'database_incompatible' },
      });
    });

    it('does not go back when the previous image is gone from the machine', async () => {
      const release = await ready();
      world.cloud.healthyAfterStart = (commit) => {
        if (commit === NEW) world.cloud.images.delete(imageOf(PREVIOUS).imageId);
        return commit !== NEW;
      };
      const result = await world.coordinator().round();
      expect(result).toEqual({ status: 'recovery_required', releaseId: release.id, code: 'rollback_failed' });
      expect(world.calls.start).toEqual([NEW]);
      expect(world.deployment(release.id)).toMatchObject({ phase: 'recovery_required', maintenance: true });
    });

    it('stops in recovery when the previous program does not come back healthy', async () => {
      const release = await ready();
      world.cloud.healthyAfterStart = () => false;
      const result = await world.coordinator().round();
      expect(result).toEqual({ status: 'recovery_required', releaseId: release.id, code: 'rollback_failed' });
      expect(world.deployment(release.id)).toMatchObject({ phase: 'recovery_required', maintenance: true });
      expect(world.release(release.id).state).toBe('deploying');
    });

    it('refuses to continue when the pause is not the one the deployment owns', async () => {
      const release = await ready();
      const control = world.control();
      let swapped = false;
      const result = await world
        .coordinator({
          control: {
            ...control,
            deployGet: async (id) => {
              const view = await control.deployGet(id);
              if (!swapped && view.deployment?.pauseId) {
                swapped = true;
                return { ...view, deployment: { ...view.deployment, pauseId: 'someone-else' } };
              }
              return view;
            },
          },
        })
        .round();
      expect(result).toEqual({
        status: 'recovery_required',
        releaseId: release.id,
        code: 'release_pause_conflict',
      });
      expect(world.calls).toMatchObject({ importImage: 0, start: [], stop: 0 });
      expect(world.deployment(release.id)).toMatchObject({ phase: 'recovery_required', maintenance: true });
    });

    describe('an interrupted engine stop (the job is gone, the recorded process may not be)', () => {
      /** The job is booted out when the stop phase first looks at the engine: a stop that a crash cut short. */
      const afterBootout = (exitsAfterPolls: number | null) => {
        const engine = world.engine();
        const sim = world.engineSim;
        let cut = false;
        let polls = 0;
        return {
          ...engine,
          state: async () => {
            if (!cut && world.cloud.current.commit === NEW) {
              cut = true;
              sim.loaded = false;
              sim.connected = false;
            }
            return engine.state();
          },
          pidAlive: async (pid: number) => {
            polls += 1;
            if (exitsAfterPolls !== null && polls > exitsAfterPolls) sim.alive = false;
            return engine.pidAlive(pid);
          },
        };
      };

      it('does not start a second engine while the recorded process is alive', async () => {
        const release = await ready();
        const result = await world.coordinator({ engine: afterBootout(null) }).round();
        expect(result).toEqual({
          status: 'recovery_required',
          releaseId: release.id,
          code: 'engine_switch_failed',
        });
        expect(world.calls).toMatchObject({ stop: 0, engineStart: [], restore: 0 });
        expect(world.cloud.current).toEqual(imageOf(NEW));
        expect(world.deployment(release.id)).toMatchObject({ phase: 'recovery_required', maintenance: true });
      });

      it('carries on once the recorded process has exited by itself', async () => {
        const release = await ready();
        const result = await world.coordinator({ engine: afterBootout(2) }).round();
        expect(result).toEqual({ status: 'live', releaseId: release.id, publishPending: false });
        expectLive(release);
        expect(world.calls.engineStart).toHaveLength(1);
      });
    });

    it('does not go back when the fence is no longer this attempt’s', async () => {
      const release = await ready();
      world.failOn('engine.start');
      const control = world.control();
      const result = await world
        .coordinator({
          control: {
            ...control,
            deployGet: async (id) => {
              const view = await control.deployGet(id);
              // The pause is another one's from the moment the new engine failed to start.
              if (world.calls.engineStart.length > 0 && view.deployment?.pauseId)
                return { ...view, deployment: { ...view.deployment, pauseId: 'someone-else' } };
              return view;
            },
          },
        })
        .round();
      expect(result).toEqual({
        status: 'recovery_required',
        releaseId: release.id,
        code: 'release_pause_conflict',
      });
      expect(world.calls).toMatchObject({ stop: 1, restore: 0 });
      expect(world.cloud.current).toEqual(imageOf(NEW));
      expect(world.calls.start).toEqual([NEW]);
    });

    it('does not start the previous image over a third image', async () => {
      const release = await ready();
      const third = imageOf('c'.repeat(40));
      world.cloud.healthyAfterStart = (commit) => {
        // Something else put its own image in place of the new one while it was starting.
        if (commit === NEW) world.cloud.current = third;
        return false;
      };
      const result = await world.coordinator().round();
      expect(result).toMatchObject({ status: 'recovery_required', releaseId: release.id });
      expect(world.calls.start).toEqual([NEW]);
      expect(world.cloud.current).toEqual(third);
      expect(world.deployment(release.id)).toMatchObject({ phase: 'recovery_required', maintenance: true });
    });
  });

  describe('a stop at any point is carried on', () => {
    it('ends the same after a stop before or after every journal write', async () => {
      for (const when of ['before', 'after'] as const) {
        for (let at = 1; ; at += 1) {
          world = await HybridWorld.create();
          const release = await world.approve();
          world.journal.crashAt(at, when);
          let crashed = false;
          try {
            await world.coordinator().round();
          } catch (error) {
            if (!(error instanceof Crash)) throw error;
            crashed = true;
          }
          world.journal.clear();
          for (let round = 0; crashed && round < 6; round += 1) {
            const result: RoundResult = await world.coordinator().round();
            if (result.status === 'idle' || (result.status === 'live' && !result.publishPending)) break;
          }
          expectLive(release);
          // Nothing is done twice: the image comes once, the cloud and the engine start once, the tag is made once.
          expect(world.calls).toMatchObject({ importImage: 1, start: [NEW], stop: 1, restore: 0 });
          expect(world.published).toHaveLength(1);
          expect(world.heavyHeld).toBe(0);
          await world.cleanup();
          if (!crashed) break;
        }
      }
    }, 300_000);
  });

  describe('a lost answer of the control socket', () => {
    it.each(['prepared', 'quiesce', 'switch'])(
      'sends the %s change again with the same id, whether it was applied or not',
      async (kind) => {
        for (const when of ['before', 'after'] as const) {
          const release = await ready();
          world.loseControl(`change:${kind}`, { when, kind: 'uncertain' }, 3);
          await expect(world.coordinator().round()).rejects.toBeInstanceOf(RoundStopped);
          // The request stays in the journal, unchanged.
          const read = world.journal.read();
          expect(read.kind === 'ok' && read.journal.pendingRequest?.op).toBe('release_deploy_change');
          expect(await world.coordinator().round()).toMatchObject({ status: 'live' });
          expectLive(release);
          await world.cleanup();
        }
      },
    );

    it('sends the begin again after a lost answer and never begins twice', async () => {
      const release = await ready();
      world.loseControl('begin', { when: 'after', kind: 'uncertain' }, 3);
      await expect(world.coordinator().round()).rejects.toBeInstanceOf(RoundStopped);
      expect(world.deployment(release.id)).toMatchObject({ phase: 'preparing' });
      expect(await world.coordinator().round()).toMatchObject({ status: 'live' });
      expectLive(release);
    });

    it('retries inside a round when the answer comes back on the second try', async () => {
      const release = await ready();
      world.loseControl('change:quiesce', { when: 'after', kind: 'uncertain' }, 1);
      expect(await world.coordinator().round()).toMatchObject({ status: 'live' });
      expectLive(release);
    });
  });

  describe('publishing', () => {
    it('reports a failed publish once, tries again after an hour, and then ends', async () => {
      const release = await ready();
      world.publisherFails = 2;
      expect(await world.coordinator().round()).toEqual({
        status: 'live',
        releaseId: release.id,
        publishPending: true,
      });
      expect(world.release(release.id)).toMatchObject({ state: 'live', publishError: expect.any(String) });
      expect(world.deployment(release.id)).toMatchObject({ phase: 'live', maintenance: false });
      expect(journalPhase()).toBe('publish');
      const revision = world.deployment(release.id)!.revision;

      // Not before the hour passes: no call to GitHub.
      world.now += 30 * 60_000;
      expect(await world.coordinator().round()).toMatchObject({ publishPending: true });
      expect(world.calls.publish).toBe(1);

      // The second failure is not reported again.
      world.now += 31 * 60_000;
      expect(await world.coordinator().round()).toMatchObject({ publishPending: true });
      expect(world.calls.publish).toBe(2);
      expect(world.deployment(release.id)!.revision).toBe(revision);

      world.now += 61 * 60_000;
      expect(await world.coordinator().round()).toEqual({
        status: 'live',
        releaseId: release.id,
        publishPending: false,
      });
      expectLive(release);
      expect(world.published).toHaveLength(1);
    });

    it('never hands the publisher a release id the cloud made up', async () => {
      const release = await ready();
      const control = world.control();
      const coordinator = world.coordinator({
        control: {
          ...control,
          deployGet: async (id) => {
            const view = await control.deployGet(id);
            return view.deployment?.phase === 'live'
              ? { ...view, release: { ...view.release, id: '../../outside' } }
              : view;
          },
        },
      });
      await expect(coordinator.round()).rejects.toMatchObject({
        name: 'RoundStopped',
        code: 'control_answer_invalid',
      });
      expect(world.calls.publish).toBe(0);
      expect(world.release(release.id).state).toBe('live');
    });

    it('does not make a second tag after a lost acknowledgement of the published report', async () => {
      const release = await ready();
      const control = world.control();
      let lost = 0;
      const coordinator = world.coordinator({
        control: {
          ...control,
          change: async (body) => {
            const view = await control.change(body);
            if (body.change.kind === 'report' && body.change.report.outcome === 'published' && lost < 3) {
              lost += 1;
              throw new ControlError('uncertain', 'control_lost', 'the answer was lost');
            }
            return view;
          },
        },
      });
      await expect(coordinator.round()).rejects.toBeInstanceOf(RoundStopped);
      expect(world.release(release.id).state).toBe('published');
      expect(await world.coordinator().round()).toEqual({
        status: 'live',
        releaseId: release.id,
        publishPending: false,
      });
      expect(world.published).toHaveLength(1);
      expectLive(release);
    });
  });

  describe('the round', () => {
    it('stops when its signal aborts, and keeps the journal', async () => {
      await ready();
      const controller = new AbortController();
      world.holdWork();
      const coordinator = world.coordinator({
        signal: controller.signal,
        clock: {
          now: () => new Date(world.now),
          sleep: async () => {
            controller.abort();
            throw new Error('aborted');
          },
        },
      });
      await expect(coordinator.round()).rejects.toMatchObject({ code: 'aborted' });
      expect(journalPhase()).toBe('drain');
      expect(world.heavyHeld).toBe(0);
    });

    it('archives a journal that was finished and goes on to the next release', async () => {
      const probe = await HybridWorld.create();
      await probe.approve();
      await probe.coordinator().round();
      const writes = probe.journal.writes;
      await probe.cleanup();

      const release = await ready();
      // The last write is the archive: the journal on disk is complete and not yet archived.
      await stopAt(writes, 'before');
      expect(journalPhase()).toBe('complete');
      expect(archived()).toHaveLength(0);
      expect(await world.coordinator().round()).toEqual({ status: 'idle' });
      expect(archived()).toHaveLength(1);
      expect(world.release(release.id).state).toBe('published');
    });

    it('finishes an archive that was written when the journal was not removed yet', async () => {
      await ready();
      await world.coordinator().round();
      const dir = path.join(world.stateDir, JOURNAL_ARCHIVE_DIR);
      const [name] = fs.readdirSync(dir);
      // The journal comes back next to its archive, as after a stop between the two steps.
      fs.writeFileSync(path.join(world.stateDir, JOURNAL_FILE), fs.readFileSync(path.join(dir, name!)), {
        mode: 0o600,
      });
      expect(journalPhase()).toBe('complete');
      await world.coordinator().round();
      expect(world.journal.read().kind).toBe('none');
      expect(archived()).toEqual([name]);
    });
  });
});
