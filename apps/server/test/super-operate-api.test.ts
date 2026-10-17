import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CreatedIntegratorAccessKey,
  SuperDiagnosticsResponse,
  SuperOperateResponse,
  SuperOperationDetail,
  routes,
} from '@projectman/shared';
import type { SuperCommand } from '@projectman/shared';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

const PAUSE: SuperCommand = { kind: 'operate', operation: { op: 'project_pause' } };

describe('super-mode operation, status and diagnostics routes (PM-764)', () => {
  let app: AppHarness;
  let cookie: string;
  let secret: string;
  let ran: number;
  beforeEach(async () => {
    app = await createAppHarness();
    cookie = await setupOwner(app.app);
    await createProject(app, cookie);
    const created = await app.app.inject({
      method: 'POST',
      url: routes.integratorKeys(),
      headers: { cookie },
      payload: { mode: 'super' },
    });
    secret = CreatedIntegratorAccessKey.parse(created.json()).secret;
    ran = 0;
    app.app.projectman.domain.superHandoffs.registerExecutor('operate', async () => {
      ran += 1;
    });
  });
  afterEach(async () => app?.close());

  const bearer = {
    get authorization() {
      return `Bearer ${secret}`;
    },
  };
  const post = (url: string, payload: unknown, headers: Record<string, string> = bearer) =>
    app.app.inject({ method: 'POST', url, headers, payload: payload as Record<string, unknown> });
  const get = (url: string, headers: Record<string, string> = bearer) =>
    app.app.inject({ method: 'GET', url, headers });

  it('starts an operation with the token: 202, idempotent on the request id, readable afterwards', async () => {
    const requestId = randomUUID();
    const first = await post(routes.superOperations('AR'), { requestId, command: PAUSE });
    expect(first.statusCode, first.body).toBe(202);
    const operation = SuperOperateResponse.parse(first.json()).operation;
    expect(operation).toMatchObject({ state: 'succeeded', requestId, handoffId: null });
    const again = await post(routes.superOperations('AR'), { requestId, command: PAUSE });
    expect(again.statusCode).toBe(202);
    expect(SuperOperateResponse.parse(again.json()).operation.id).toBe(operation.id);
    expect(ran).toBe(1);

    const other = await post(routes.superOperations('AR'), {
      requestId,
      command: { kind: 'operate', operation: { op: 'project_resume' } },
    });
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe('super_request_conflict');

    const read = await get(routes.superOperation('AR', operation.id));
    expect(read.statusCode).toBe(200);
    expect(SuperOperationDetail.parse(read.json())).toMatchObject({
      operation: { id: operation.id, state: 'succeeded' },
      result: null,
    });
    expect((await get(routes.superOperation('AR', 'sop_missing'))).statusCode).toBe(404);
  });

  it('refuses the owner’s plain login for a start, a bad body, and anyone but an owner', async () => {
    const url = routes.superOperations('AR');
    const plain = await post(url, { requestId: randomUUID(), command: PAUSE }, { cookie });
    expect(plain.statusCode).toBe(403);
    expect(plain.json().error.code).toBe('integrator_not_allowed');
    expect((await post(url, { requestId: 'nope', command: PAUSE })).statusCode).toBe(400);
    expect(
      (await post(url, { requestId: randomUUID(), command: { kind: 'sql', text: 'x' } })).statusCode,
    ).toBe(400);
    expect((await post(url, { requestId: randomUUID(), command: PAUSE, extra: 1 })).statusCode).toBe(400);
    const admin = await addHumanAndLogin(app.app, { handle: 'ada', access: 'admin' });
    expect((await post(url, { requestId: randomUUID(), command: PAUSE }, { cookie: admin })).statusCode).toBe(
      403,
    );
    expect((await app.app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(401);
    expect(ran).toBe(0);
  });

  it('has no administration adapter here: status and logs are 503, a bad target is 400', async () => {
    const status = await get(`${routes.superAdministrationStatus('AR')}?target=hub`);
    expect(status.statusCode).toBe(503);
    expect(status.json().error.code).toBe('administration_unavailable');
    expect((await get(`${routes.superAdministrationLogs('AR')}?target=hub&limit=5`)).statusCode).toBe(503);
    expect((await get(routes.superAdministrationStatus('AR'))).statusCode).toBe(400);
    expect((await get(`${routes.superAdministrationStatus('AR')}?target=web`)).statusCode).toBe(400);
    expect((await get(`${routes.superAdministrationLogs('AR')}?target=hub&limit=201`)).statusCode).toBe(400);
    expect((await get(`${routes.superAdministrationLogs('AR')}?target=hub&limit=0`)).statusCode).toBe(400);
    const admin = await addHumanAndLogin(app.app, { handle: 'ada', access: 'admin' });
    expect(
      (await get(`${routes.superAdministrationStatus('AR')}?target=hub`, { cookie: admin })).statusCode,
    ).toBe(403);
    expect(
      (await app.app.inject({ method: 'GET', url: routes.superAdministrationStatus('AR') })).statusCode,
    ).toBe(401);
  });

  it('answers a closed diagnostics catalogue for the owner and the token, and nothing else', async () => {
    const url = routes.superDiagnosticsQuery('AR');
    for (const headers of [bearer, { cookie }]) {
      const response = await post(url, { query: 'operations' }, headers);
      expect(response.statusCode, response.body).toBe(200);
      expect(SuperDiagnosticsResponse.parse(response.json())).toMatchObject({
        columns: ['id', 'taskKey', 'state', 'operation', 'createdAt', 'updatedAt'],
        truncated: false,
      });
    }
    await post(routes.superOperations('AR'), { requestId: randomUUID(), command: PAUSE });
    const rows = SuperDiagnosticsResponse.parse((await post(url, { query: 'operations' })).json()).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]![3]).toBe('operate:project_pause');
    for (const body of [
      { query: 'users' },
      { query: 'tasks', sql: 'select 1' },
      { query: 'tasks', limit: 1000 },
      {},
    ])
      expect((await post(url, body)).statusCode, JSON.stringify(body)).toBe(400);
    expect((await post(url, { query: 'tasks', taskKey: 'ZZ-1' })).statusCode).toBe(404);
    const admin = await addHumanAndLogin(app.app, { handle: 'ada', access: 'admin' });
    expect((await post(url, { query: 'tasks' }, { cookie: admin })).statusCode).toBe(403);
    expect((await app.app.inject({ method: 'POST', url, payload: { query: 'tasks' } })).statusCode).toBe(401);
  });

  it('refuses the administration command here as unavailable when no executor is wired (503)', async () => {
    const response = await post(routes.superOperations('AR'), {
      requestId: randomUUID(),
      command: { kind: 'administration', request: { kind: 'deploy', releaseId: 'rel_1' } },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('super_executor_unavailable');
  });
});
