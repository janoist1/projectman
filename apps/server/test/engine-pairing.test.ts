import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EnginePairingStatus,
  IntegratorAccessKeysResponse,
  IntegratorKeyAuditPage,
  PairingView,
  routes,
  StartEnginePairingResponse,
} from '@projectman/shared';
import type { EngineView } from '@projectman/shared';
import type { EngineRegistry } from '../src/runtime/sessions';
import {
  addHumanAndLogin,
  createAppHarness,
  createOwnerAccountWithProject,
  createProject,
  inject,
  OWNER_LOGIN,
  setupOwner,
} from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** The keys a machine makes for itself before it asks for a pairing; only their hashes and prefixes go to the hub. */
function machineKeys() {
  const machineKey = `pme_${randomBytes(32).toString('base64url')}`;
  const integratorKey = `pmi_${randomBytes(32).toString('base64url')}`;
  return {
    machineKey,
    integratorKey,
    body: (name = 'Friend Mac') => ({
      name,
      machineKey: { hash: sha256(machineKey), prefix: machineKey.slice(0, 10) },
      integratorKey: { hash: sha256(integratorKey), prefix: integratorKey.slice(0, 12) },
    }),
  };
}

/** Device pairing on the hub (PM-1437): the machine's doors, the approver's doors and what an approval makes. */
describe('engine pairing', () => {
  let h: AppHarness;
  let host: string;
  let registry: EngineRegistry;
  let now: Date;
  let tenant: { userId: string; email: string; cookie: string };
  let developer: string;
  const logLines: Record<string, unknown>[] = [];
  const RAW_LOG: string[] = [];

  const start = (keys = machineKeys(), headers: Record<string, string> = {}) =>
    h.app.inject({ method: 'POST', url: routes.enginePairings(), headers, payload: keys.body() });
  const started = async (keys = machineKeys()) => {
    const res = await start(keys);
    expect(res.statusCode, res.body).toBe(201);
    return { keys, pairing: StartEnginePairingResponse.parse(res.json()) };
  };
  const poll = (id: string, key?: string) =>
    h.app.inject({
      method: 'GET',
      url: routes.enginePairing(id),
      headers: key ? { authorization: `Bearer ${key}` } : {},
    });
  const cancel = (id: string, key?: string) =>
    h.app.inject({
      method: 'DELETE',
      url: routes.enginePairing(id),
      headers: key ? { authorization: `Bearer ${key}` } : {},
    });
  const web = (action: 'lookup' | 'approve' | 'deny', who: string, code: string) =>
    inject(
      h.app,
      'POST',
      { lookup: routes.pairingLookup(), approve: routes.pairingApprove(), deny: routes.pairingDeny() }[
        action
      ],
      who,
      { code },
    );
  const errorCode = (res: { json(): unknown }) => (res.json() as { error: { code: string } }).error.code;
  const keysOf = async (who: string) =>
    IntegratorAccessKeysResponse.parse((await inject(h.app, 'GET', routes.integratorKeys(), who)).json())
      .keys;
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };

  beforeEach(async () => {
    // Before any real clock: the harness stamps the accounts it adds with the real time.
    now = new Date('2026-10-18T10:00:00.000Z');
    h = await createAppHarness({ now: () => now, real: { mcp: true } });
    host = await setupOwner(h.app);
    await createProject(h, host, 'AR');
    tenant = await createOwnerAccountWithProject(h, host, 'BR');
    developer = await addHumanAndLogin(h.app, { handle: 'dev', projectKey: 'AR' });
    logLines.length = 0;
    RAW_LOG.length = 0;
    h.app = await h.relaunch({
      engineMode: 'cloud',
      appVersion: 'test',
      claudeTmpRoots: [],
      clientIpHeader: 'x-test-client',
      logger: {
        level: 'info',
        stream: {
          write(line: string) {
            RAW_LOG.push(line);
            logLines.push(JSON.parse(line) as Record<string, unknown>);
          },
        },
      },
    });
    registry = h.app.projectman.engineRegistry!;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.close();
  });

  describe('the machine’s doors', () => {
    it('starts a pairing with a short code and stores only the hashes of the keys', async () => {
      const keys = machineKeys();
      const res = await start(keys);
      expect(res.statusCode).toBe(201);
      const body = StartEnginePairingResponse.parse(res.json());
      expect(body).toEqual({
        id: expect.stringMatching(/^epr_[0-9a-f]{16}$/),
        code: expect.stringMatching(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/),
        expiresAt: '2026-10-18T10:10:00.000Z',
        pollIntervalSeconds: 3,
      });
      expect(res.body).not.toContain(keys.machineKey);
      expect(res.body).not.toContain(keys.integratorKey);
      const row = h.app.projectman.repos.db.prepare('SELECT * FROM engine_pairings').get() as Record<
        string,
        unknown
      >;
      expect(row).toMatchObject({
        machine_key_hash: sha256(keys.machineKey),
        integrator_key_hash: sha256(keys.integratorKey),
        code_hash: sha256(body.code.replace('-', '')),
        state: 'pending',
      });
      expect(JSON.stringify(row)).not.toContain(keys.machineKey);
    });

    it('is not there on a board without engines (single mode)', async () => {
      h.app = await h.relaunch({});
      expect((await start()).statusCode).toBe(404);
      expect((await web('lookup', host, 'BCDF-GHJK')).statusCode).toBe(404);
    });

    it('needs HTTPS off the machine itself', async () => {
      const res = await h.app.inject({
        method: 'POST',
        url: routes.enginePairings(),
        remoteAddress: '203.0.113.9',
        payload: machineKeys().body(),
      });
      expect(res.statusCode).toBe(401);
    });

    it('refuses a key the hub already knows: an engine’s, an integrator key’s or a pending pairing’s', async () => {
      const engine = registry.create(
        'Known',
        h.app.projectman.repos.users.findByEmail(OWNER_LOGIN.email)!.id,
      );
      const known = machineKeys();
      const engineKey = {
        ...known.body(),
        machineKey: { hash: sha256(engine.key), prefix: engine.key.slice(0, 10) },
      };
      const manual = h.app.projectman.auth.createIntegratorAccessKey(tenant.userId, {
        mode: 'super',
        expiresInDays: 7,
      });
      const integratorKey = {
        ...known.body(),
        integratorKey: { hash: sha256(manual.secret), prefix: manual.secret.slice(0, 12) },
      };
      const { keys } = await started();
      for (const payload of [engineKey, integratorKey, keys.body()]) {
        const res = await h.app.inject({ method: 'POST', url: routes.enginePairings(), payload });
        expect([res.statusCode, errorCode(res)]).toEqual([400, 'invalid_request']);
      }
    });

    it('answers the machine’s polls by its key, and 404 for any other', async () => {
      const { keys, pairing } = await started();
      expect(EnginePairingStatus.parse((await poll(pairing.id, keys.machineKey)).json())).toEqual({
        state: 'pending',
        expiresAt: pairing.expiresAt,
      });
      for (const res of [
        await poll(pairing.id),
        await poll(pairing.id, machineKeys().machineKey),
        await poll('epr_0000000000000000', keys.machineKey),
      ])
        expect(res.statusCode).toBe(404);
      advance(10 * 60_000);
      expect((await poll(pairing.id, keys.machineKey)).json()).toEqual({ state: 'expired' });
    });

    it('cancels a pending pairing for its machine only, and the code no longer works', async () => {
      const { keys, pairing } = await started();
      expect((await cancel(pairing.id, machineKeys().machineKey)).statusCode).toBe(404);
      expect((await cancel(pairing.id, keys.machineKey)).statusCode).toBe(204);
      expect((await poll(pairing.id, keys.machineKey)).json()).toEqual({ state: 'cancelled' });
      expect(errorCode(await web('lookup', tenant.cookie, pairing.code))).toBe('pairing_code_invalid');
    });

    it('limits the starts per address with a retry-after', async () => {
      for (let i = 0; i < 10; i += 1) expect((await start()).statusCode).toBe(201);
      const refused = await start();
      expect([refused.statusCode, errorCode(refused)]).toEqual([429, 'too_many_attempts']);
      expect(refused.headers['retry-after']).toBe('900');
      expect(refused.json().error.details).toEqual({ retryAfterSeconds: 900 });
    });

    it('keeps at most 20 pairings pending at once, whatever their addresses', async () => {
      for (let i = 0; i < 20; i += 1)
        expect((await start(machineKeys(), { 'x-test-client': `198.51.100.${i}` })).statusCode).toBe(201);
      advance(60_000);
      const refused = await start(machineKeys(), { 'x-test-client': '198.51.100.99' });
      expect([refused.statusCode, errorCode(refused)]).toEqual([429, 'too_many_attempts']);
      expect(refused.headers['retry-after']).toBe('540');
    });
  });

  describe('the approver’s doors', () => {
    it('look at the right before the code: an integrator key and a member without an engine right learn nothing', async () => {
      const { pairing } = await started();
      const manual = h.app.projectman.auth.createIntegratorAccessKey(tenant.userId, {
        mode: 'super',
        expiresInDays: 7,
      });
      const viaKey = await h.app.inject({
        method: 'POST',
        url: routes.pairingLookup(),
        headers: { authorization: `Bearer ${manual.secret}` },
        payload: { code: pairing.code },
      });
      expect([viaKey.statusCode, errorCode(viaKey)]).toEqual([403, 'integrator_not_allowed']);
      for (const code of [pairing.code, 'BCDF-GHJK']) {
        const res = await web('approve', developer, code);
        expect([res.statusCode, errorCode(res)]).toEqual([403, 'owner_only']);
      }
    });

    it.each([
      ['an unknown code', 'BCDF-GHJK'],
      ['a malformed code', 'AEIO-1234'],
    ])('answer %s with pairing_code_invalid', async (_case, code) => {
      const res = await web('lookup', tenant.cookie, code);
      expect([res.statusCode, errorCode(res)]).toEqual([404, 'pairing_code_invalid']);
    });

    it('show a pending pairing however the code is typed, with the super key an approval replaces', async () => {
      const { pairing } = await started();
      const typed = pairing.code.toLowerCase().replace('-', ' ');
      expect(PairingView.parse((await web('lookup', tenant.cookie, typed)).json())).toEqual({
        state: 'pending',
        code: pairing.code,
        machineName: 'Friend Mac',
        requestedAt: '2026-10-18T10:00:00.000Z',
        expiresAt: pairing.expiresAt,
        replacesKeyPrefix: null,
      });
      const manual = h.app.projectman.auth.createIntegratorAccessKey(tenant.userId, {
        mode: 'super',
        expiresInDays: 7,
      });
      expect((await web('lookup', tenant.cookie, pairing.code)).json().replacesKeyPrefix).toBe(
        manual.key.prefix,
      );
    });

    it('stop working at expiry', async () => {
      const { pairing } = await started();
      advance(10 * 60_000);
      for (const action of ['lookup', 'approve', 'deny'] as const)
        expect(errorCode(await web(action, tenant.cookie, pairing.code))).toBe('pairing_code_invalid');
    });

    it('limit wrong codes per user with a retry-after, and a found code gives its slot back', async () => {
      const { pairing } = await started();
      for (let i = 0; i < 9; i += 1)
        expect((await web('lookup', tenant.cookie, 'BCDF-GHJK')).statusCode).toBe(404);
      expect((await web('lookup', tenant.cookie, pairing.code)).statusCode).toBe(200);
      expect((await web('lookup', tenant.cookie, 'BCDF-GHJK')).statusCode).toBe(404);
      const refused = await web('lookup', tenant.cookie, pairing.code);
      expect([refused.statusCode, errorCode(refused)]).toEqual([429, 'too_many_attempts']);
      expect(refused.headers['retry-after']).toBe('900');
      expect(refused.json().error.details).toEqual({ retryAfterSeconds: 900 });
    });
  });

  describe('the approval', () => {
    it('makes the engine and the super key from the hashes, in the approver’s name, and the machine learns it', async () => {
      const previous = h.app.projectman.auth.createIntegratorAccessKey(tenant.userId, {
        mode: 'super',
        expiresInDays: 7,
      });
      const { keys, pairing } = await started();
      const approved = await web('approve', tenant.cookie, pairing.code);
      expect(approved.statusCode, approved.body).toBe(200);
      const view = PairingView.parse(approved.json());
      expect(view).toMatchObject({ state: 'approved', code: pairing.code, machineName: 'Friend Mac' });
      const engineId = view.state === 'approved' ? view.engineId : '';

      expect(registry.resolve(keys.machineKey)).toBe(engineId);
      const engines = (await inject(h.app, 'GET', routes.engines(), tenant.cookie)).json() as EngineView[];
      expect(engines.find((engine) => engine.id === engineId)).toMatchObject({
        name: 'Friend Mac',
        paired: true,
      });
      const principal = h.app.projectman.auth.resolveIntegratorCredential(keys.integratorKey, 'mcp');
      expect(principal).toMatchObject({
        userId: tenant.userId,
        mode: 'super',
        prefix: keys.integratorKey.slice(0, 12),
      });
      const listed = await keysOf(tenant.cookie);
      expect(listed.map((key) => [key.prefix, key.state, key.paired ?? false])).toEqual([
        [keys.integratorKey.slice(0, 12), 'active', true],
        [previous.key.prefix, 'revoked', false],
      ]);
      expect(listed[0]!.expiresAt).toBe('2027-10-18T10:00:00.000Z');
      const audit = IntegratorKeyAuditPage.parse(
        (await inject(h.app, 'GET', routes.integratorKeyAudit(), tenant.cookie)).json(),
      ).entries;
      expect(audit.map((entry) => [entry.action, entry.paired ?? false])).toEqual([
        ['created', true],
        ['revoked', false],
        ['created', false],
      ]);

      for (let i = 0; i < 2; i += 1)
        expect(EnginePairingStatus.parse((await poll(pairing.id, keys.machineKey)).json())).toEqual({
          state: 'approved',
          engineId,
          engineName: 'Friend Mac',
          approvedBy: { name: 'tenant', email: tenant.email },
          integratorKeyExpiresAt: '2027-10-18T10:00:00.000Z',
        });
      expect(logLines.find((line) => line.msg === 'Engine pairing approved')).toMatchObject({
        pairingId: pairing.id,
        engineId,
        keyPrefix: keys.integratorKey.slice(0, 12),
        machineName: 'Friend Mac',
        userId: tenant.userId,
      });
      const log = RAW_LOG.join('');
      for (const secret of [keys.machineKey, keys.integratorKey, pairing.code])
        expect(log).not.toContain(secret);
      expect(h.app.projectman.repos.enginePairings.findById(pairing.id)).toMatchObject({
        state: 'approved',
        engineId,
      });
    });

    it('is single use: the decider sees the decided pairing again, anybody else a wrong code', async () => {
      const { pairing } = await started();
      expect((await web('approve', tenant.cookie, pairing.code)).statusCode).toBe(200);
      const again = await web('approve', tenant.cookie, pairing.code);
      expect([again.statusCode, again.json().state]).toEqual([200, 'approved']);
      expect((await web('lookup', tenant.cookie, pairing.code)).json().state).toBe('approved');
      expect(errorCode(await web('deny', tenant.cookie, pairing.code))).toBe('pairing_code_invalid');
      for (const action of ['lookup', 'approve', 'deny'] as const)
        expect(errorCode(await web(action, host, pairing.code))).toBe('pairing_code_invalid');
      expect(registry.list().filter((engine) => engine.name === 'Friend Mac')).toHaveLength(1);
    });

    it('rolls back whole when a step fails: no key, no engine, the old key lives and the pairing stays pending', async () => {
      const previous = h.app.projectman.auth.createIntegratorAccessKey(tenant.userId, {
        mode: 'super',
        expiresInDays: 7,
      });
      const { keys, pairing } = await started();
      const spy = vi.spyOn(h.app.projectman.repos.engines, 'create').mockImplementation(() => {
        throw new Error('disk full');
      });
      h.errors.length = 0;
      expect((await web('approve', tenant.cookie, pairing.code)).statusCode).toBe(500);
      h.errors.length = 0;
      spy.mockRestore();
      expect(registry.resolve(keys.machineKey)).toBeNull();
      expect(h.app.projectman.auth.resolveIntegratorCredential(keys.integratorKey, 'mcp')).toBeNull();
      expect((await keysOf(tenant.cookie)).map((key) => [key.id, key.state])).toEqual([
        [previous.key.id, 'active'],
      ]);
      expect((await poll(pairing.id, keys.machineKey)).json().state).toBe('pending');
      expect((await web('approve', tenant.cookie, pairing.code)).statusCode).toBe(200);
    });

    it('gives the paired key the scope of a key made by hand: own projects only, no release (PM-1428)', async () => {
      const { auth } = h.app.projectman;
      const reach = async (secret: string) => ({
        projects: (
          (
            await h.app.inject({ url: '/api/projects', headers: { authorization: `Bearer ${secret}` } })
          ).json() as { key: string }[]
        ).map((project) => project.key),
        connected: ['AR', 'BR'].filter((key) => auth.superKeyConnection(tenant.email, key) !== null),
      });
      const manual = auth.createIntegratorAccessKey(tenant.userId, { mode: 'super', expiresInDays: 7 });
      const byHand = await reach(manual.secret);
      expect(byHand.projects).toEqual(['BR']);
      const { keys, pairing } = await started();
      expect((await web('approve', tenant.cookie, pairing.code)).statusCode).toBe(200);
      expect(await reach(keys.integratorKey)).toEqual(byHand);
      const response = await h.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${keys.integratorKey}`,
        },
        payload: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'publish_release', arguments: { project_key: 'BR', summary: 'Release changes' } },
        }),
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().result.structuredContent?.errorCode).toBe('host_only');
    });

    it('leaves an engine and a key that are revoked like ones made by hand', async () => {
      const { keys, pairing } = await started();
      const view = (await web('approve', tenant.cookie, pairing.code)).json() as { engineId: string };
      expect(
        (await inject(h.app, 'POST', routes.revokeEngine(view.engineId), tenant.cookie)).statusCode,
      ).toBe(200);
      expect(registry.resolve(keys.machineKey)).toBeNull();
      const [key] = await keysOf(tenant.cookie);
      expect(
        (await inject(h.app, 'DELETE', routes.integratorAccessKey(key!.id), tenant.cookie)).statusCode,
      ).toBe(200);
      expect(h.app.projectman.auth.resolveIntegratorCredential(keys.integratorKey, 'mcp')).toBeNull();
    });
  });

  describe('the denial', () => {
    it('tells the machine, keeps the row and logs it without a secret', async () => {
      const { keys, pairing } = await started();
      expect(PairingView.parse((await web('deny', tenant.cookie, pairing.code)).json())).toEqual({
        state: 'denied',
        code: pairing.code,
        machineName: 'Friend Mac',
        decidedAt: '2026-10-18T10:00:00.000Z',
      });
      expect((await poll(pairing.id, keys.machineKey)).json()).toEqual({ state: 'denied' });
      expect(errorCode(await web('approve', tenant.cookie, pairing.code))).toBe('pairing_code_invalid');
      expect(logLines.find((line) => line.msg === 'Engine pairing denied')).toMatchObject({
        pairingId: pairing.id,
        userId: tenant.userId,
      });
      advance(3 * 24 * 60 * 60_000);
      await started();
      expect(h.app.projectman.repos.enginePairings.findById(pairing.id)?.state).toBe('denied');
      expect(registry.resolve(keys.machineKey)).toBeNull();
    });

    it('prunes long-expired pending and cancelled pairings at the next start', async () => {
      const expired = await started();
      const cancelled = await started();
      expect((await cancel(cancelled.pairing.id, cancelled.keys.machineKey)).statusCode).toBe(204);
      advance(25 * 60 * 60_000);
      await started();
      const { enginePairings } = h.app.projectman.repos;
      expect(enginePairings.findById(expired.pairing.id)).toBeNull();
      expect(enginePairings.findById(cancelled.pairing.id)).toBeNull();
    });
  });
});
