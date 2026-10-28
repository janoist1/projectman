import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootout, bootstrap } from '../../../scripts/live/launchd';
import { LiveWorld, SERVER_LABEL } from './helpers/live-world';

let world: LiveWorld;
beforeEach(() => {
  world = new LiveWorld();
  world.setupLive();
});
afterEach(() => world.cleanup());

describe('launchd teardown', () => {
  it('waits for the job to disappear even after the port is free', async () => {
    const start = world.time;
    world.override((record) =>
      record.key === 'launchctl-print' && world.time < start + 10_000
        ? { status: 0, stdout: 'state = exiting', stderr: '' }
        : undefined,
    );
    expect((await bootout(world.deps(), SERVER_LABEL)).status).toBe(0);
    expect(world.server.running).toBe(false);
    expect(world.time - start).toBe(10_000);
    expect(world.keys().at(-1)).toBe('launchctl-print');
  });

  it('returns a bounded failure when the job stays loaded', async () => {
    const start = world.time;
    world.fail('launchctl-print', 0, '', 'state = exiting');
    expect(await bootout(world.deps(), SERVER_LABEL)).toMatchObject({
      status: 1,
      stderr: expect.stringContaining('did not unload'),
    });
    expect(world.time - start).toBe(120_000);
  });

  it.each([3, 113])('accepts an absent job (exit %s)', async (status) => {
    world.loaded.clear();
    world.fail('launchctl-bootout', status);
    expect((await bootout(world.deps(), SERVER_LABEL)).status).toBe(0);
    expect(world.keys()).toEqual(['launchctl-bootout', 'launchctl-print']);
  });

  it('preserves an unload error without polling', async () => {
    world.fail('launchctl-bootout', 5, 'busy');
    expect(await bootout(world.deps(), SERVER_LABEL)).toMatchObject({ status: 5, stderr: 'busy' });
    expect(world.keys()).toEqual(['launchctl-bootout']);
  });
});

describe('launchd bootstrap retries', () => {
  it('recovers from status 5 after more than the old retry window', async () => {
    const start = world.time;
    world.override((record) =>
      record.key === 'launchctl-bootstrap' && world.time < start + 10_000
        ? { status: 5, stdout: '', stderr: 'Input/output error' }
        : undefined,
    );
    expect((await bootstrap(world.deps(), SERVER_LABEL)).status).toBe(0);
    expect(world.time - start).toBe(10_000);
    expect(world.server.running).toBe(true);
  });

  it('returns the last error after 30 seconds of status 5', async () => {
    const start = world.time;
    world.fail('launchctl-bootstrap', 5, 'Input/output error');
    expect(await bootstrap(world.deps(), SERVER_LABEL)).toMatchObject({
      status: 5,
      stderr: 'Input/output error',
    });
    expect(world.time - start).toBe(30_000);
    expect(world.calls).toHaveLength(61);
  });

  it('does not retry other failures', async () => {
    const start = world.time;
    world.fail('launchctl-bootstrap', 1, 'invalid plist');
    expect((await bootstrap(world.deps(), SERVER_LABEL)).status).toBe(1);
    expect(world.time).toBe(start);
    expect(world.calls).toHaveLength(1);
  });
});
