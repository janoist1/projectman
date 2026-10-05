import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MachineView, Me, routes, StopOrphansResult } from '@projectman/shared';
import type { HumanAccess } from '@projectman/shared';
import { createFixtureProbe, parseMachineFixture } from '../src/machine';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

const BUSY = readFileSync(new URL('../../../scripts/fixtures/machine/busy.json', import.meta.url), 'utf8');

describe('machine routes', () => {
  let h: AppHarness;
  let owner: string;
  const signals: Array<{ pid: number; signal: string }> = [];
  /** The tag the app gave the probe; the runner gets the same one (PROJECTMAN_INSTANCE of a session). */
  const tags: string[] = [];
  afterEach(async () => {
    signals.length = 0;
    tags.length = 0;
    await h?.close();
  });

  async function setup() {
    const fixture = parseMachineFixture(BUSY);
    h = await createAppHarness({
      machineProbe: (opts) => {
        tags.push(opts.instanceTag);
        const probe = createFixtureProbe(fixture, opts);
        // The fixture never signals; the spy shows what the route asked for.
        return {
          ...probe,
          signal: (pid, signal) => {
            signals.push({ pid, signal });
            return probe.signal(pid, signal);
          },
        };
      },
    });
    owner = await setupOwner(h.app);
    await createProject(h, owner);
  }

  /** A second project, in which the owner's account is the owner but the fictional members are not. */
  async function addSecondProject() {
    const workspace = join(h.home, 'workspace-br');
    mkdirSync(workspace);
    const res = await inject(h.app, 'POST', routes.projects(), owner, {
      key: 'BR',
      name: 'brick',
      workspacePath: workspace,
      templateId: 'test',
      repos: [{ name: 'web', path: '.', github: 'acme/web' }],
    });
    expect(res.statusCode).toBe(201);
  }

  it('tags the instance with the first 16 hex digits of the hash of its real home', async () => {
    await setup();
    expect(tags).toEqual([createHash('sha256').update(realpathSync(h.home)).digest('hex').slice(0, 16)]);
  });

  it('is refused without a login', async () => {
    await setup();
    const res = await inject(h.app, 'GET', routes.machine());
    expect(res.statusCode).toBe(401);
    expect((await inject(h.app, 'POST', routes.machineOrphansStop(), null, { orphans: [] })).statusCode).toBe(
      401,
    );
  });

  it('shows the machine to the owner of every project', async () => {
    await setup();
    const res = await inject(h.app, 'GET', routes.machine(), owner);
    expect(res.statusCode).toBe(200);
    const view = MachineView.parse(res.json());
    expect(view.summary.memoryPressure).toBe('critical');
    expect(view.orphans?.map((o) => o.origin?.sessionId ?? null)).toEqual([null, null]);
    expect(view.orphans?.map((o) => o.name).sort()).toEqual(['sleep', 'vite']);
    expect(view.others?.some((o) => o.kind === 'server')).toBe(true);
    // The panel is open: the same answer, measured more often.
    const panel = await inject(h.app, 'GET', `${routes.machine()}?panel=1`, owner);
    expect(panel.statusCode).toBe(200);
    MachineView.parse(panel.json());
  });

  it.each(['admin', 'developer', 'client', 'viewer'] as HumanAccess[])(
    'refuses a project %s: only an owner of every project may see the machine',
    async (access) => {
      await setup();
      const cookie = await addHumanAndLogin(h.app, { handle: `fictional-${access}`, access });
      const res = await inject(h.app, 'GET', routes.machine(), cookie);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('insufficient_access');
      const stop = await inject(h.app, 'POST', routes.machineOrphansStop(), cookie, {
        orphans: [{ pid: 50000, startedAt: new Date().toISOString() }],
      });
      expect(stop.statusCode).toBe(403);
      expect(signals).toEqual([]);
    },
  );

  it('refuses the owner of only one of two projects', async () => {
    await setup();
    await addSecondProject();
    const cookie = await addHumanAndLogin(h.app, { handle: 'fictional-owner', access: 'owner' });
    const res = await inject(h.app, 'GET', routes.machine(), cookie);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('insufficient_access');
    expect((await inject(h.app, 'GET', routes.machine(), owner)).statusCode).toBe(200);
  });

  it('says in /api/me whether the user is an instance owner', async () => {
    await setup();
    await addSecondProject();
    const partial = await addHumanAndLogin(h.app, { handle: 'fictional-owner', access: 'owner' });
    const viewer = await addHumanAndLogin(h.app, { handle: 'fictional-viewer', access: 'viewer' });
    const me = async (cookie: string) => Me.parse((await inject(h.app, 'GET', routes.me(), cookie)).json());
    expect((await me(owner)).instanceOwner).toBe(true);
    expect((await me(partial)).instanceOwner).toBe(false);
    expect((await me(viewer)).instanceOwner).toBe(false);
  });

  it('refuses a request without a list of processes', async () => {
    await setup();
    for (const body of [
      {},
      { orphans: [] },
      { orphans: [{ pid: 'x', startedAt: 'now' }] },
      { orphans: [{ pid: -3, startedAt: '' }] },
    ]) {
      const res = await inject(h.app, 'POST', routes.machineOrphansStop(), owner, body);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('invalid_request');
    }
    expect(signals).toEqual([]);
  });

  it('stops an orphan of the instance and never signals a process that is not in the list', async () => {
    await setup();
    const view = MachineView.parse((await inject(h.app, 'GET', routes.machine(), owner)).json());
    const orphan = view.orphans![0]!;
    const server = { pid: process.pid, startedAt: new Date().toISOString() };
    const res = await inject(h.app, 'POST', routes.machineOrphansStop(), owner, {
      orphans: [{ pid: orphan.pid, startedAt: orphan.startedAt }, server],
    });
    expect(res.statusCode).toBe(200);
    expect(StopOrphansResult.parse(res.json()).results).toEqual([
      { pid: orphan.pid, startedAt: orphan.startedAt, outcome: 'stopped' },
      { ...server, outcome: 'gone' },
    ]);
    expect(signals.map((s) => s.pid)).not.toContain(process.pid);
    const after = MachineView.parse((await inject(h.app, 'GET', routes.machine(), owner)).json());
    expect(after.orphans?.map((o) => o.pid)).not.toContain(orphan.pid);
  });
});
