import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { routes } from '@projectman/shared';
import { buildApp } from '../src/app';
import { humanActor } from '../src/domain';
import { freePort } from '../src/runner/test-helpers';
import type { AccountLookup } from '../src/runtime-boundary';
import { testBoundaryConfig } from '../src/runtime-boundary/test-helpers';
import {
  addHumanAndLogin,
  createAppHarness,
  createProject,
  inject,
  OWNER_LOGIN,
  setupOwner,
} from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { FakeRuntimeBoundary } from './helpers/fake-runtime-boundary';

/** Some sandboxes (the agents' own) refuse to bind a unix socket: the bridge test runs elsewhere. */
async function canListenOnUnixSockets(): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), 'pm-sock-'));
  const server = net.createServer();
  const ok = await new Promise<boolean>((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(join(dir, 's.sock'), () => resolve(true));
  });
  if (ok) await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
  return ok;
}
const unixSockets = await canListenOnUnixSockets();

describe('the VM boundary over HTTP', () => {
  let h: AppHarness;
  afterEach(() => h.close());

  it('reports the boundary to logged-in members: off by default, the verdict when managed', async () => {
    h = await createAppHarness();
    const owner = await setupOwner(h.app);
    expect((await h.app.inject({ method: 'GET', url: routes.runtimeBoundary() })).statusCode).toBe(401);
    const off = await inject(h.app, 'GET', routes.runtimeBoundary(), owner);
    expect(off.json()).toMatchObject({ mode: 'off', ready: false, problems: ['not_configured'] });
    await h.close();

    const boundary = new FakeRuntimeBoundary();
    boundary.ready = false;
    boundary.problems = ['launcher_unreachable'];
    h = await createAppHarness({ runtimeBoundary: boundary });
    const cookie = await setupOwner(h.app);
    expect((await inject(h.app, 'GET', routes.runtimeBoundary(), cookie)).json()).toMatchObject({
      mode: 'managed_vm',
      ready: false,
      problems: ['launcher_unreachable'],
    });
  });

  it('lets owners, and only owners, list and close opened destinations', async () => {
    h = await createAppHarness({ runtimeBoundary: new FakeRuntimeBoundary() });
    const owner = await setupOwner(h.app);
    await createProject(h, owner);
    const admin = await addHumanAndLogin(h.app, { handle: 'admin', access: 'admin' });
    const domain = h.app.projectman.domain;
    await domain.tasks.create('AR', { title: 'Docs' }, humanActor('owner'));
    const started = await domain.taskStarts.start('AR', 'AR-1', {
      actor: humanActor('owner'),
      author: OWNER_LOGIN,
    });
    const session = { projectKey: 'AR', member: 'dev-1', sessionId: started.session!.id, taskKey: 'AR-1' };
    const docs = { host: 'docs.example.org', port: 443 };
    const refused = (await domain.egress.authorize({ member: 'dev-1', session }, docs)) as {
      operationId: string;
    };
    const request = await domain.teamTools.submitBoundaryRequest(session, {
      operationId: refused.operationId,
      deduplicationKey: 'docs',
    });
    await domain.boundary.decide('AR', request.id, 'owner', { decision: 'allow', reason: 'scope_verified' });
    await domain.egress.authorize({ member: 'dev-1', session }, docs);

    expect((await inject(h.app, 'GET', routes.egressAllowances('AR'), admin)).statusCode).toBe(403);
    const listed = await inject(h.app, 'GET', routes.egressAllowances('AR'), owner);
    expect(listed.statusCode).toBe(200);
    const [allowance] = listed.json() as Array<{ id: string; host: string }>;
    expect(allowance).toMatchObject({ host: 'docs.example.org', member: 'dev-1' });
    expect(
      (await inject(h.app, 'POST', routes.revokeEgressAllowance('AR', allowance!.id), admin)).statusCode,
    ).toBe(403);
    expect(
      (await inject(h.app, 'POST', routes.revokeEgressAllowance('AR', 'bad id!'), owner)).statusCode,
    ).toBe(400);
    const revoked = await inject(h.app, 'POST', routes.revokeEgressAllowance('AR', allowance!.id), owner);
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ revokedBy: 'owner' });
    expect((await inject(h.app, 'GET', routes.egressAllowances('AR'), owner)).json()).toEqual([]);
  });
});

describe('the server with a boundary configuration', () => {
  let home: string;
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('needs member workspaces', async () => {
    home = mkdtempSync(join(tmpdir(), 'pm-boundary-app-'));
    await expect(buildApp({ home, logger: false, runtimeBoundary: testBoundaryConfig() })).rejects.toThrow(
      /member workspaces/,
    );
  });

  it('serves its egress proxy and reports the boundary not ready while the launcher is missing', async () => {
    home = mkdtempSync(join(tmpdir(), 'pm-boundary-app-'));
    const port = await freePort();
    const config = testBoundaryConfig({
      launcher: { socket: join(home, 'no-launcher.sock'), maxSessions: 4 },
      readiness: { report: join(home, 'no-report.json'), maxAgeSeconds: 3600 },
      egress: { ...testBoundaryConfig().egress, port },
    });
    const app = await buildApp({
      home,
      logger: false,
      memberWorkspaces: true,
      runtimeBoundary: config,
      modules: { workerAccounts: accountsOf([]) },
    });
    try {
      await app.ready();
      const status = await app.projectman.domain.runtimeBoundary!.status({ refresh: true });
      expect(status).toMatchObject({ mode: 'managed_vm', ready: false, egress: 'up', launcher: 'down' });
      expect(status.problems).toEqual(['readiness_report_missing', 'launcher_unreachable']);
    } finally {
      await app.close();
    }
  });

  // PM-175: the readiness probe runs a worker's unit through the launcher alone, so the bridges
  // must be there from the start, on a fresh install and after every restart, with no session.
  it.skipIf(!unixSockets)(
    'opens every worker bridge at startup and after a restart, before any session',
    async () => {
      home = mkdtempSync(join(tmpdir(), 'pm-boundary-app-'));
      const bridgeRoot = join(home, 'bridge');
      const gid = process.getgid?.() ?? 0;
      const config = testBoundaryConfig({
        launcher: { socket: join(home, 'no-launcher.sock'), maxSessions: 4 },
        readiness: { report: join(home, 'no-report.json'), maxAgeSeconds: 3600 },
        egress: { ...testBoundaryConfig().egress, port: await freePort() },
        appPort: await freePort(),
        bridgeRoot,
      });
      const workerAccounts = accountsOf([
        { user: 'pmw-dev', uid: 20001, gid, home: '/var/lib/projectman-work/pmw-dev' },
        { user: 'pmw-qa', uid: 20002, gid, home: '/var/lib/projectman-work/pmw-qa' },
        { user: 'alice', uid: 1000, gid: 1000, home: '/home/alice' },
      ]);
      for (const round of ['fresh start', 'restart']) {
        const app = await buildApp({
          home,
          logger: false,
          memberWorkspaces: true,
          runtimeBoundary: config,
          modules: { workerAccounts },
        });
        try {
          await app.listen({ host: '127.0.0.1', port: config.appPort });
          for (const member of ['dev', 'qa']) {
            for (const name of ['app.sock', 'egress.sock'])
              expect(
                (await stat(join(bridgeRoot, member, name))).isSocket(),
                `${round}: ${member} ${name}`,
              ).toBe(true);
            // Through the bridge the app answers, as the probe's app-api check expects: 401 without a login.
            expect(await statusOver(join(bridgeRoot, member, 'app.sock'), routes.me())).toBe(401);
          }
          expect(existsSync(join(bridgeRoot, 'alice'))).toBe(false);
        } finally {
          await app.close();
          // systemd empties the service's runtime directory at every stop.
          rmSync(bridgeRoot, { recursive: true, force: true });
        }
      }
    },
  );
});

function accountsOf(list: Array<{ user: string; uid: number; gid: number; home: string }>): AccountLookup {
  return { byName: (name) => list.find((a) => a.user === name) ?? null, list: () => list };
}

/** The HTTP status of a GET sent over a unix socket. */
function statusOver(socketPath: string, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.get({ socketPath, path }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on('error', reject);
  });
}
