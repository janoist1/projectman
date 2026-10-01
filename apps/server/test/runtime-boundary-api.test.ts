import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { routes } from '@projectman/shared';
import { buildApp } from '../src/app';
import { humanActor } from '../src/domain';
import { freePort } from '../src/runner/test-helpers';
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
    const app = await buildApp({ home, logger: false, memberWorkspaces: true, runtimeBoundary: config });
    try {
      await app.ready();
      const status = await app.projectman.domain.runtimeBoundary!.status({ refresh: true });
      expect(status).toMatchObject({ mode: 'managed_vm', ready: false, egress: 'up', launcher: 'down' });
      expect(status.problems).toEqual(['readiness_report_missing', 'launcher_unreachable']);
    } finally {
      await app.close();
    }
  });
});
