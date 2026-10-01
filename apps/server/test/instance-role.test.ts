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
import { createFakeMcp, createFakeRunnerModule, FakeGithub } from './helpers/fakes';
import { createAppHarness, createProject, setupOwner } from './helpers/app-harness';
import type { CliAppHarness } from './helpers/app-harness';

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
let h: CliAppHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

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

  it('shows the data of a standby copy but starts no AI session', { timeout: 60_000 }, async () => {
    h = await createAppHarness({ runner: 'fake-cli', real: { context: true } });
    const cookie = await setupOwner(h.app);
    await createProject(h, cookie);
    const created = await h.app.inject({
      method: 'POST',
      url: routes.tasks('AR'),
      headers: { cookie },
      payload: { title: 'Acme checkout' },
    });
    const { key } = created.json<Task>();

    // The same home, started as a standby copy.
    writeInstanceMarker(h.home, 'standby', 'rehearsal copy');
    await h.restart();

    const board = await h.app.inject({ url: routes.tasks('AR'), headers: { cookie } });
    expect(board.statusCode).toBe(200);
    expect(JSON.stringify(board.json())).toContain('Acme checkout');
    const start = await h.app.inject({
      method: 'POST',
      url: routes.startTask('AR', key),
      headers: { cookie },
      payload: { assignee: 'dev-1' },
    });
    expect(start.statusCode).toBe(409);
    expect(start.json()).toMatchObject({ error: { code: 'ai_disabled' } });
    expect(h.app.projectman.domain.sessions.list('AR')).toEqual([]);
    expect(readFileSync(join(h.home, 'instance.json'), 'utf8')).toContain('standby');

    // Taking the marker away is the person's step; the next start works as before.
    clearInstanceMarker(h.home);
    await h.restart();
    const again = await h.app.inject({
      method: 'POST',
      url: routes.startTask('AR', key),
      headers: { cookie },
      payload: { assignee: 'dev-1' },
    });
    // (Where a sandbox forbids pseudo-terminals the start fails later, as session_start_failed.)
    expect(again.statusCode === 200 || again.json().error.code === 'session_start_failed').toBe(true);
  });
});
