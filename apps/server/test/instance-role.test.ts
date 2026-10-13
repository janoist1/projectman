import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routes } from '@projectman/shared';
import type { Task } from '@projectman/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import {
  assertHomeMayStart,
  clearInstanceMarker,
  InstanceMarkerError,
  instanceRole,
  readInstanceMarker,
  writeInstanceMarker,
} from '../src/instance';
import { humanActor } from '../src/domain';
import { createFakeMcp, createFakeRunnerModule, FakeGithub } from './helpers/fakes';
import { createAppHarness, createProject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

/**
 * Only one copy of an installation may work (PM-143): the marker file `instance.json` of a home
 * makes a copy `standby` (shows its data, starts no AI) or `retired` (does not start at all).
 */

const homes: string[] = [];
const tempHome = () => {
  const home = mkdtempSync(join(tmpdir(), 'pm-instance-'));
  homes.push(home);
  return home;
};
let harness: AppHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** The server on an existing home, with the fake runner (no pseudo-terminal is needed). */
const startOn = async (home: string) => {
  const runner = createFakeRunnerModule();
  const app = await buildApp({
    home,
    logger: false,
    modules: {
      createRunnerModule: (opts) => runner.create(opts),
      createMcpModule: (opts) => createFakeMcp().create(opts),
      github: new FakeGithub(),
    },
  });
  await app.ready();
  return app;
};

describe('the marker file', () => {
  it('is the active instance when there is no marker', () => {
    const home = tempHome();
    expect(readInstanceMarker(home)).toBeNull();
    expect(instanceRole(home)).toBe('active');
    expect(assertHomeMayStart(home)).toBe('active');
  });

  it('writes a private marker and reads it back, and clearing makes the home active again', () => {
    const home = tempHome();
    const marker = writeInstanceMarker(home, 'standby', 'rehearsal copy', new Date('2026-10-01T12:00:00Z'));
    expect(marker).toEqual({
      version: 1,
      role: 'standby',
      reason: 'rehearsal copy',
      setAt: '2026-10-01T12:00:00.000Z',
    });
    expect(statSync(join(home, 'instance.json')).mode & 0o777).toBe(0o600);
    expect(readInstanceMarker(home)).toEqual(marker);
    expect(assertHomeMayStart(home)).toBe('standby');
    clearInstanceMarker(home);
    expect(instanceRole(home)).toBe('active');
  });

  it('refuses to start a retired home and says why', () => {
    const home = tempHome();
    writeInstanceMarker(home, 'retired', 'moved to the VM');
    expect(() => assertHomeMayStart(home)).toThrow(/retired \(moved to the VM\)/);
  });

  it('keeps a hybrid engine home out of the single and the cloud server, and says how to start it', () => {
    const home = tempHome();
    writeInstanceMarker(home, 'engine', 'hybrid engine of the cloud');
    expect(instanceRole(home)).toBe('engine');
    expect(() => assertHomeMayStart(home)).toThrow(
      /hybrid engine home; start it with `npm run engine -- start`/,
    );
    expect(() => assertHomeMayStart(home, 'single')).toThrow(InstanceMarkerError);
    expect(() => assertHomeMayStart(home, 'cloud')).toThrow(InstanceMarkerError);
    expect(assertHomeMayStart(home, 'engine')).toBe('engine');
  });

  it('starts the engine in a new home and in an engine home, not in a live single-machine one', () => {
    const fresh = tempHome();
    expect(assertHomeMayStart(fresh, 'engine')).toBe('active');
    expect(assertHomeMayStart(join(fresh, 'not-made-yet'), 'engine')).toBe('active');

    const live = tempHome();
    writeFileSync(join(live, 'db.sqlite'), '');
    expect(() => assertHomeMayStart(live, 'engine')).toThrow(/not marked as a hybrid engine home/);
    expect(assertHomeMayStart(live)).toBe('active'); // the single server is the home's own mode

    writeInstanceMarker(live, 'engine', 'moved to the hybrid mode');
    expect(assertHomeMayStart(live, 'engine')).toBe('engine');
  });

  it('never starts the engine in a retired home', () => {
    const home = tempHome();
    writeInstanceMarker(home, 'retired', 'moved to the VM');
    expect(() => assertHomeMayStart(home, 'engine')).toThrow(/retired/);
  });

  it.each([
    ['broken JSON', '{nope'],
    [
      'an unknown role',
      JSON.stringify({ version: 1, role: 'active', reason: 'x', setAt: '2026-10-01T12:00:00Z' }),
    ],
    [
      'an extra key',
      JSON.stringify({ version: 1, role: 'standby', reason: 'x', setAt: '2026-10-01T12:00:00Z', a: 1 }),
    ],
    [
      'an empty reason',
      JSON.stringify({ version: 1, role: 'standby', reason: '', setAt: '2026-10-01T12:00:00Z' }),
    ],
  ])('never reads %s as an active home', (_name, text) => {
    const home = tempHome();
    writeFileSync(join(home, 'instance.json'), text);
    expect(() => assertHomeMayStart(home)).toThrow(InstanceMarkerError);
  });
});

describe('the server', () => {
  it('does not start on a retired home and creates nothing in it', async () => {
    const home = tempHome();
    writeInstanceMarker(home, 'retired', 'moved to the VM');
    const runner = createFakeRunnerModule();
    await expect(
      buildApp({
        home,
        logger: false,
        modules: {
          createRunnerModule: (opts) => runner.create(opts),
          createMcpModule: (opts) => createFakeMcp().create(opts),
          github: new FakeGithub(),
        },
      }),
    ).rejects.toThrow(/retired/);
    expect(existsSync(join(home, 'db.sqlite'))).toBe(false);
    expect(existsSync(join(home, 'secret'))).toBe(false);
  });

  it.each(['single', 'cloud'] as const)('does not start in %s mode on a hybrid engine home', async (mode) => {
    const home = tempHome();
    writeInstanceMarker(home, 'engine', 'hybrid engine of the cloud');
    const runner = createFakeRunnerModule();
    await expect(
      buildApp({
        home,
        logger: false,
        engineMode: mode,
        modules: {
          createRunnerModule: (opts) => runner.create(opts),
          createMcpModule: (opts) => createFakeMcp().create(opts),
          github: new FakeGithub(),
        },
      }),
    ).rejects.toThrow(/hybrid engine home; start it with `npm run engine -- start`/);
    expect(existsSync(join(home, 'db.sqlite'))).toBe(false);
  });

  it('shows the data of a standby copy but starts no AI session', async () => {
    const h = await createAppHarness();
    harness = h;
    const cookie = await setupOwner(h.app);
    await createProject(h, cookie);
    const created = await h.app.inject({
      method: 'POST',
      url: routes.tasks('AR'),
      headers: { cookie },
      payload: { title: 'Acme checkout' },
    });
    const { key } = created.json<Task>();
    await h.app.close();

    // The same home, started as a standby copy (the cookie secret and the accounts are the same).
    writeInstanceMarker(h.home, 'standby', 'rehearsal copy');
    const standby = await startOn(h.home);
    const board = await standby.inject({ url: routes.tasks('AR'), headers: { cookie } });
    expect(board.statusCode).toBe(200);
    expect(JSON.stringify(board.json())).toContain('Acme checkout');
    const start = await standby.inject({
      method: 'POST',
      url: routes.startTask('AR', key),
      headers: { cookie },
      payload: { assignee: 'dev-1' },
    });
    expect(start.statusCode).toBe(409);
    expect(start.json()).toMatchObject({ error: { code: 'instance_standby' } });
    expect(standby.projectman.domain.sessions.list('AR')).toEqual([]);
    // A stage move hands the task over to the stage's AI owner, which a standby copy never does: the
    // move works as a record, starts nothing, and keeps no deferred start for an activation to run.
    await standby.projectman.domain.tasks.moveToStage('AR', key, 'development', humanActor('owner'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(standby.projectman.domain.sessions.list('AR')).toEqual([]);
    expect(standby.projectman.repos.db.prepare('SELECT count(*) AS n FROM deferred_starts').get()).toEqual({
      n: 0,
    });
    await standby.close();

    // Taking the marker away is the person's step; the next start is not refused as a standby.
    clearInstanceMarker(h.home);
    const active = await startOn(h.home);
    const again = await active.inject({
      method: 'POST',
      url: routes.startTask('AR', key),
      headers: { cookie },
      payload: { assignee: 'dev-1' },
    });
    expect(again.statusCode === 200 || again.json().error.code !== 'instance_standby').toBe(true);
    await active.close();
  });
});
