import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ControlRequest } from '@projectman/shared';
import { runWatch } from '../../../scripts/live/watch';
import { LiveWorld, NEW, OLD, REMOTE, SERVER_LABEL } from './helpers/live-world';

/** The release watcher (PM-493) against a fake machine: no launchd, no GitHub, no socket. */

let world: LiveWorld;
afterEach(() => world?.cleanup());

const watch = (w: LiveWorld) =>
  runWatch(w.deps(), { root: w.root, home: w.home, port: w.port, remote: REMOTE });

function ready(): LiveWorld {
  world = new LiveWorld();
  world.setupLive();
  world.approve();
  return world;
}

/** The items appear in the list in this order (other items may lie between them). */
function expectOrder(list: string[], items: string[]): void {
  let from = 0;
  for (const item of items) {
    const at = list.indexOf(item, from);
    expect(at, `${item} after ${from} in ${list.join(' ')}`).toBeGreaterThanOrEqual(from);
    from = at + 1;
  }
}

const lastReport = (w: LiveWorld, outcome: string) =>
  w
    .reports()
    .filter((request) => request.op === 'release_report' && request.report.outcome === outcome)
    .at(-1) as Extract<ControlRequest, { op: 'release_report' }> | undefined;

describe('a quiet round', () => {
  it('does nothing when no release is waiting, and leaves the checkout first', async () => {
    world = new LiveWorld();
    world.setupLive();
    expect(await watch(world)).toBe(0);
    expect(world.calls).toEqual([]);
    expect(world.requestOps()).toEqual(['release_next']);
    expect(world.chdirs).toEqual([world.home]);
    expect(existsSync(path.join(world.home, 'release', 'watch.lock'))).toBe(false);
  });

  it('leaves an approved release alone while an owner pause is open', async () => {
    ready();
    world.openPause('maintenance');
    expect(await watch(world)).toBe(0);
    expect(world.calls).toEqual([]);
    expect(world.requestOps()).toEqual(['release_next']);
    expect(world.output).toContain('a pause is open (maintenance)');
  });

  it('reports a server that does not answer, and touches nothing', async () => {
    world = new LiveWorld();
    world.setupLive({ running: false });
    expect(await watch(world)).toBe(1);
    expect(world.calls).toEqual([]);
    expect(world.output).toContain('does not answer');
  });

  it('refuses relative paths', async () => {
    world = new LiveWorld();
    await expect(
      runWatch(world.deps(), { root: 'live', home: world.home, port: 4800, remote: REMOTE }),
    ).rejects.toThrow(/absolute/);
  });

  it('skips the round while another one holds the lock, and takes over the lock of a dead round', async () => {
    ready();
    const lock = path.join(world.home, 'release', 'watch.lock');
    mkdirSync(path.dirname(lock), { recursive: true });
    writeFileSync(lock, '999\n');
    world.alivePids.add(999);
    expect(await watch(world)).toBe(0);
    expect(world.requests).toEqual([]);
    expect(existsSync(lock)).toBe(true);

    world.alivePids.clear();
    expect(await watch(world)).toBe(0);
    expect(world.release?.state).toBe('published');
    expect(existsSync(lock)).toBe(false);
  });
});

describe('a release that goes through', () => {
  it('deploys, verifies, tags and publishes', async () => {
    ready();
    expect(await watch(world)).toBe(0);

    expectOrder(world.keys(), [
      'clone',
      'merge-base',
      'checkout',
      'npm-ci',
      'npm-build',
      'heavy',
      'config-check',
      'launchctl-bootout',
      'backup',
      'integrity',
      'launchctl-bootstrap',
      'ls-tags',
      'tag',
      'push',
      'gh-view',
      'gh-create',
    ]);
    expectOrder(world.requestOps(), [
      'release_next',
      'release_claim',
      'pause',
      'status',
      'resume',
      'report:live',
      'report:published',
    ]);
    // The live build is the new one, the old one is kept beside it, the database was backed up first.
    expect(world.version()).toBe(NEW);
    expect(world.version(world.prev())).toBe(OLD);
    expect(world.server).toEqual({ running: true, version: NEW });
    expect(world.pause).toBeNull();
    const backups = readdirSync(path.join(world.home, 'release', 'backups'));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(new RegExp(`^db-\\d{8}T\\d{6}Z-${OLD.slice(0, 12)}\\.sqlite$`));
    expect(statSync(path.join(world.home, 'release', 'backups', backups[0]!)).mode & 0o777).toBe(0o600);
    // The release is published with the tag of the day and its notes.
    expect(world.release).toMatchObject({
      state: 'published',
      tag: 'v2026.10.11',
      url: 'https://github.com/owner/projectman/releases/tag/v2026.10.11',
    });
    expect(world.remoteTags.get('v2026.10.11')).toBe(NEW);
    expect(world.lastNotes).toContain('Fixes a few things.');
    expect(world.lastNotes).toContain('Cards: PM-1, PM-2');
    expect(world.lastNotes).toContain(`Commit: ${NEW}`);
    // Nothing is left to continue.
    expect(world.journal()).toBeNull();
    expect(existsSync(world.next())).toBe(false);
  });

  it('runs every command in an absolute directory and takes the claim with the live commit', async () => {
    ready();
    await watch(world);
    for (const call of world.calls) expect(path.isAbsolute(call.cwd), call.key).toBe(true);
    expect(world.requests).toContainEqual({
      op: 'release_claim',
      releaseId: 'rel_1',
      previousCommit: OLD,
    });
  });

  it('runs the release test through the heavy-run queue, in the new build, with a time limit', async () => {
    ready();
    await watch(world);
    const heavy = world.calls.find((call) => call.key === 'heavy')!;
    expect(heavy.args).toEqual([
      'run',
      'heavy',
      '--',
      '--label',
      'release-test',
      '--max-wait',
      '3600',
      '--',
      'npm',
      'run',
      'release-test',
    ]);
    expect(heavy.cwd).toBe(world.next());
  });

  it('keeps no more than two older builds of each kind', async () => {
    ready();
    for (const c of ['1', '2', '3']) {
      mkdirSync(`${world.root}-failed-${c.repeat(40)}`);
      mkdirSync(`${world.root}-prev-${c.repeat(40)}`);
    }
    mkdirSync(`${world.root}-prev-notasha`);
    await watch(world);
    const names = readdirSync(world.base);
    expect(names.filter((name) => name.startsWith('projectman-live-failed-'))).toHaveLength(2);
    // The build just replaced is never pruned: it, and one of the older ones.
    const prev = names.filter((name) => /^projectman-live-prev-[0-9a-f]{40}$/.test(name));
    expect(prev).toHaveLength(2);
    expect(prev).toContain(path.basename(world.prev()));
    expect(names).toContain('projectman-live-prev-notasha');
  });

  it('keeps the newest ten backups', async () => {
    ready();
    const dir = path.join(world.home, 'release', 'backups');
    mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= 12; i += 1)
      writeFileSync(path.join(dir, `db-2026010${i % 10}T0000${String(i).padStart(2, '0')}Z-x.sqlite`), 'x');
    await watch(world);
    expect(readdirSync(dir)).toHaveLength(10);
  });
});

describe('a step that fails before the live server is touched', () => {
  const cases: [string, string, number][] = [
    ['clone', 'fetch', 1],
    ['checkout', 'fetch', 1],
    ['npm-ci', 'build', 1],
    ['npm-build', 'build', 1],
    ['heavy', 'test', 1],
    ['config-check', 'config_check', 1],
  ];

  it.each(cases)('%s fails in the %s step: reported, nothing switched', async (key, step) => {
    ready();
    world.fail(key, 1, 'boom here');
    expect(await watch(world)).toBe(0);
    expect(world.release?.state).toBe('failed');
    expect(world.release?.failure).toMatchObject({ step, rolledBack: false });
    expect(world.release?.failure?.message).toContain('boom here');
    expect(world.requestOps()).not.toContain('pause');
    expect(world.version()).toBe(OLD);
    expect(world.server).toEqual({ running: true, version: OLD });
    expect(existsSync(world.next())).toBe(false);
    expect(world.journal()).toBeNull();
  });

  it('refuses a commit that is not on GitHub main', async () => {
    ready();
    world.fail('merge-base', 1, '');
    await watch(world);
    expect(world.release?.failure).toMatchObject({ step: 'fetch', rolledBack: false });
    expect(world.release?.failure?.message).toContain('not on GitHub main');
    expect(world.keys()).not.toContain('checkout');
  });

  it('says so when the heavy-run queue expired', async () => {
    ready();
    world.fail('heavy', 75, 'queue');
    await watch(world);
    expect(world.release?.failure).toMatchObject({ step: 'test' });
    expect(world.release?.failure?.message).toContain('heavy-run queue');
  });

  it('keeps the failure message within the limit of the contract', async () => {
    ready();
    world.fail('npm-build', 1, 'x'.repeat(10_000));
    await watch(world);
    expect(world.release?.failure?.message.length).toBeLessThanOrEqual(2000);
  });

  it('does not touch the server for a build with no commit', async () => {
    ready();
    world.server.version = null;
    expect(await watch(world)).toBe(0);
    expect(world.release?.state).toBe('failed');
    expect(world.release?.failure?.message).toContain('no commit');
    expect(world.keys()).toEqual([]);
  });

  it('gives up quietly when the claim loses to another state', async () => {
    ready();
    world.controlHook = (request) =>
      request.op === 'release_claim'
        ? { ok: false, error: { code: 'release_state_conflict', message: 'taken' } }
        : undefined;
    expect(await watch(world)).toBe(0);
    expect(world.keys()).toEqual([]);
    expect(world.journal()).toBeNull();
  });
});

describe('a failure at the cutover', () => {
  it('goes back to work when the sessions do not pause in time', async () => {
    ready();
    world.pausingPolls = Infinity;
    expect(await watch(world)).toBe(0);
    expect(world.release?.failure).toMatchObject({ step: 'pause', rolledBack: false });
    expect(world.keys()).not.toContain('launchctl-bootout');
    expect(world.pause).toBeNull();
    expect(world.server).toEqual({ running: true, version: OLD });
    expect(existsSync(world.next())).toBe(false);
  });

  it('goes back to work when the stop is refused', async () => {
    ready();
    world.fail('launchctl-bootout', 5, 'busy');
    await watch(world);
    expect(world.release?.failure).toMatchObject({ step: 'stop', rolledBack: false });
    expect(world.release?.failure?.message).toContain('busy');
    expect(world.version()).toBe(OLD);
    expect(world.pause).toBeNull();
  });

  it('starts the old server again when the backup fails', async () => {
    ready();
    world.fail('backup', 1, 'disk full');
    await watch(world);
    expect(world.release?.failure).toMatchObject({ step: 'backup', rolledBack: false });
    expect(world.server).toEqual({ running: true, version: OLD });
    expect(world.loaded.has(SERVER_LABEL)).toBe(true);
    expect(world.pause).toBeNull();
    expect(world.db()).toBe('old-data');
    expect(world.version()).toBe(OLD);
  });

  it('starts the old server again when the backup is not sound', async () => {
    ready();
    world.fail('integrity', 0, '', 'row 3 is corrupt');
    await watch(world);
    expect(world.release?.failure).toMatchObject({ step: 'backup' });
    expect(world.release?.failure?.message).toContain('integrity');
    expect(world.server).toEqual({ running: true, version: OLD });
  });

  it('rolls back when the new build does not come up: build, database and report', async () => {
    ready();
    world.brokenCommits.add(NEW);
    expect(await watch(world)).toBe(0);
    expect(world.release?.failure).toMatchObject({ step: 'verify', rolledBack: true });
    expect(world.version()).toBe(OLD);
    expect(world.version(world.failedBuild())).toBe(NEW);
    expect(existsSync(world.prev())).toBe(false);
    expect(world.db()).toBe('old-data');
    expect(world.server).toEqual({ running: true, version: OLD });
    expect(world.pause).toBeNull();
    expect(world.journal()).toBeNull();
  });

  it('restores the database the new build changed', async () => {
    ready();
    world.newBuildWrites = 'new-build-schema';
    // It comes up, writes, and answers with the wrong commit: the verify step fails.
    world.controlHook = (request) =>
      request.op === 'status' && world.server.version === NEW
        ? { ok: true, pause: world.pause, appVersion: 'c'.repeat(40) }
        : undefined;
    await watch(world);
    expect(world.release?.failure).toMatchObject({ step: 'verify', rolledBack: true });
    expect(world.db()).toBe('old-data');
  });

  it('rolls back when the new build cannot be loaded', async () => {
    ready();
    let first = true;
    world.override((record) => {
      if (record.key === 'launchctl-bootstrap' && first) {
        first = false;
        return { status: 1, stdout: '', stderr: 'Bootstrap failed' };
      }
      return undefined;
    });
    await watch(world);
    expect(world.release?.failure).toMatchObject({ step: 'switch', rolledBack: true });
    expect(world.version()).toBe(OLD);
    expect(world.server).toEqual({ running: true, version: OLD });
  });

  it('continues a rollback that could not finish, in the next round', async () => {
    ready();
    world.brokenCommits.add(NEW);
    let blocked = true;
    world.override((record) =>
      blocked && record.key === 'launchctl-bootstrap' && world.version() === OLD
        ? { status: 1, stdout: '', stderr: 'still busy' }
        : undefined,
    );
    expect(await watch(world)).toBe(1);
    expect(world.journal()).toMatchObject({ step: 'rollback' });
    expect(world.release?.state).toBe('deploying');
    expect(world.version()).toBe(OLD);

    blocked = false;
    expect(await watch(world)).toBe(0);
    expect(world.release?.failure).toMatchObject({ step: 'verify', rolledBack: true });
    expect(world.server).toEqual({ running: true, version: OLD });
    expect(world.journal()).toBeNull();
  });
});

describe('a round that was stopped', () => {
  const deploying = (w: LiveWorld, journal: Record<string, unknown>) => {
    w.approve({ state: 'deploying', previousCommit: OLD });
    w.writeJournal(journal);
  };

  it.each(['fetch', 'build', 'test', 'config_check'])(
    'reports the %s step as failed and removes the half build',
    async (step) => {
      world = new LiveWorld();
      world.setupLive();
      deploying(world, { step });
      mkdirSync(world.next(), { recursive: true });
      expect(await watch(world)).toBe(0);
      expect(world.release?.failure).toMatchObject({ step, rolledBack: false });
      expect(world.release?.failure?.message).toContain('stopped');
      expect(existsSync(world.next())).toBe(false);
      expect(world.journal()).toBeNull();
    },
  );

  it('starts over when it was stopped before the claim', async () => {
    world = new LiveWorld();
    world.setupLive();
    world.approve();
    world.writeJournal({ step: 'build', claimed: false });
    expect(await watch(world)).toBe(0);
    expect(world.release?.state).toBe('published');
  });

  it.each(['pause', 'stop', 'backup'])(
    'starts the old server again after the %s step and reports the failure',
    async (step) => {
      world = new LiveWorld();
      world.setupLive({ running: false });
      world.approve({ state: 'deploying', previousCommit: OLD });
      world.writeJournal({ step });
      world.openPause('release rel_1');
      expect(await watch(world)).toBe(0);
      expect(world.release?.failure).toMatchObject({ step, rolledBack: false });
      expect(world.server).toEqual({ running: true, version: OLD });
      expect(world.pause).toBeNull();
    },
  );

  it('goes on to publish when the new build is running after the switch', async () => {
    world = new LiveWorld();
    const backup = world.setupSwitched();
    world.server.version = NEW;
    deploying(world, { step: 'switch', backup, prevDir: world.prev() });
    world.openPause('release rel_1');
    expect(await watch(world)).toBe(0);
    expect(world.release?.state).toBe('published');
    expect(world.pause).toBeNull();
    expect(world.journal()).toBeNull();
  });

  it('rolls back when the switch was stopped and the new build is not running', async () => {
    world = new LiveWorld();
    const backup = world.setupSwitched();
    world.server = { running: false, version: NEW };
    world.loaded.clear();
    world.brokenCommits.add(NEW);
    deploying(world, { step: 'switch', backup, prevDir: world.prev() });
    world.openPause('release rel_1');
    expect(await watch(world)).toBe(0);
    expect(world.release?.failure).toMatchObject({ step: 'switch', rolledBack: true });
    expect(world.version()).toBe(OLD);
    expect(world.db()).toBe('old-data');
    expect(world.server).toEqual({ running: true, version: OLD });
  });

  it('publishes a live release from the journal, and releases its pause', async () => {
    world = new LiveWorld();
    world.setupLive();
    world.approve({ state: 'live', previousCommit: OLD, liveAt: '2026-10-11T11:00:00.000Z' });
    world.server.version = NEW;
    world.writeJournal({ step: 'publish' });
    world.openPause('release rel_1');
    expect(await watch(world)).toBe(0);
    expect(world.release).toMatchObject({ state: 'published', tag: 'v2026.10.11' });
    expect(world.pause).toBeNull();
    expect(world.journal()).toBeNull();
  });

  it('drops a publishing journal whose release the server no longer knows as live', async () => {
    world = new LiveWorld();
    world.setupLive();
    world.approve({ state: 'published' });
    world.writeJournal({ step: 'publish' });
    expect(await watch(world)).toBe(0);
    expect(world.journal()).toBeNull();
    expect(world.calls).toEqual([]);
  });

  it('leaves an unreadable journal alone and says where to look', async () => {
    ready();
    mkdirSync(path.dirname(world.journalPath()), { recursive: true });
    writeFileSync(world.journalPath(), '{"version": 2');
    expect(await watch(world)).toBe(1);
    expect(world.requests).toEqual([]);
    expect(world.calls).toEqual([]);
    expect(existsSync(world.journalPath())).toBe(true);
    expect(world.output).toContain('unreadable');
    expect(world.output).toContain('DEPLOY.md');
  });

  it('leaves a journal that does not fit the server alone', async () => {
    world = new LiveWorld();
    world.setupLive();
    world.approve({ state: 'live' });
    world.writeJournal({ step: 'verify' });
    world.server.version = NEW;
    world.controlHook = (request) =>
      request.op === 'release_report'
        ? { ok: false, error: { code: 'release_state_conflict', message: 'no' } }
        : undefined;
    expect(await watch(world)).toBe(1);
    expect(world.journal()).not.toBeNull();
  });
});

describe('a deploying release without a journal', () => {
  it('is live when the server runs its commit', async () => {
    world = new LiveWorld();
    world.setupLive();
    world.approve({ state: 'deploying', previousCommit: OLD });
    world.server.version = NEW;
    world.openPause('release rel_1');
    expect(await watch(world)).toBe(0);
    expect(world.release?.state).toBe('published');
    expect(world.pause).toBeNull();
  });

  it('is reported failed when the server runs another commit', async () => {
    world = new LiveWorld();
    world.setupLive();
    world.approve({ state: 'deploying', previousCommit: OLD });
    expect(await watch(world)).toBe(0);
    expect(world.release?.state).toBe('failed');
    expect(world.release?.failure?.message).toContain('lost its journal');
    expect(world.calls).toEqual([]);
  });
});

describe('the publishing', () => {
  it('reuses a tag that is already on the commit', async () => {
    ready();
    world.remoteTags.set('v2026.10.9', NEW);
    await watch(world);
    expect(world.release).toMatchObject({ state: 'published', tag: 'v2026.10.9' });
    expect(world.keys()).not.toContain('tag');
    expect(world.keys()).not.toContain('push');
  });

  it('reuses a GitHub release that exists', async () => {
    ready();
    world.remoteTags.set('v2026.10.11', NEW);
    world.ghReleases.set('v2026.10.11', 'https://github.com/owner/projectman/releases/tag/v2026.10.11');
    await watch(world);
    expect(world.release).toMatchObject({ state: 'published', tag: 'v2026.10.11' });
    expect(world.keys()).not.toContain('gh-create');
  });

  it('numbers the second release of the day', async () => {
    ready();
    world.remoteTags.set('v2026.10.11', 'd'.repeat(40));
    await watch(world);
    expect(world.release).toMatchObject({ state: 'published', tag: 'v2026.10.11.2' });
    expect(world.remoteTags.get('v2026.10.11.2')).toBe(NEW);
  });

  it('creates the release only for a tag that is on the remote', async () => {
    ready();
    await watch(world);
    const create = world.calls.find((call) => call.key === 'gh-create')!;
    expect(create.args).toContain('--verify-tag');
    expect(create.args).toContain('owner/projectman');
    expect(world.keys().indexOf('push')).toBeLessThan(world.keys().indexOf('gh-create'));
  });

  it('reports a failed push once, keeps the journal, and tries again after an hour', async () => {
    ready();
    world.fail('push', 1, 'permission denied');
    expect(await watch(world)).toBe(1);
    expect(world.release?.state).toBe('live');
    expect(world.release?.publishError).toContain('permission denied');
    expect(world.journal()).toMatchObject({ step: 'publish' });
    expect(world.version()).toBe(NEW);
    expect(world.pause).toBeNull();

    // Within the hour: nothing is tried.
    const before = world.calls.length;
    world.time += 30 * 60_000;
    expect(await watch(world)).toBe(0);
    expect(world.calls.length).toBe(before);

    world.time += 31 * 60_000;
    world.clearFail('push');
    expect(await watch(world)).toBe(0);
    expect(world.release?.state).toBe('published');
    expect(world.journal()).toBeNull();
  });

  it('lets the server decide when the published report meets a conflict', async () => {
    ready();
    world.controlHook = (request) => {
      if (request.op === 'release_report' && request.report.outcome === 'published') {
        world.release = null;
        return { ok: false, error: { code: 'release_state_conflict', message: 'already' } };
      }
      return undefined;
    };
    expect(await watch(world)).toBe(0);
    expect(world.journal()).toBeNull();
  });

  it('writes the published report with the tag the pattern allows', async () => {
    ready();
    await watch(world);
    expect(lastReport(world, 'published')?.report).toMatchObject({ tag: 'v2026.10.11' });
  });
});
