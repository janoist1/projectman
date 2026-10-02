import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { routes } from '@projectman/shared';
import type { CreatedInvitation } from '@projectman/shared';
import { MAX_FAILED_ATTEMPTS_ALL_CLIENTS } from '../src/auth';
import { cookieOf, createAppHarness, createProject, OWNER_LOGIN, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { htmlBytes, pngBytes, uploadFile } from './helpers/attachments';
import { OWNER_ACTOR } from './helpers/domain-harness';

const HEADER = 'cf-connecting-ip';
const PER_CLIENT = 10;
const clientOf = (n: number) => `203.0.113.${n}`;

describe('limits per client address behind a trusted entrance (PM-211)', () => {
  let h: AppHarness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  /** The server with the trusted header set, or (`false`) without the setting. */
  async function start(trusted = true) {
    h = await createAppHarness({ app: { clientIpHeader: trusted ? HEADER : undefined } });
    return h;
  }

  /** A request from the proxy (loopback) or from `remoteAddress`, naming its client in the header. */
  function login(
    password: string,
    client: string | undefined,
    { remoteAddress, email = OWNER_LOGIN.email }: { remoteAddress?: string; email?: string } = {},
  ) {
    return h!.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: client === undefined ? {} : { [HEADER]: client },
      payload: { email, password },
      ...(remoteAddress ? { remoteAddress } : {}),
    });
  }
  const wrong = (client: string | undefined, remoteAddress?: string) =>
    login('incorrect password', client, { remoteAddress });
  const right = (client: string | undefined) => login(OWNER_LOGIN.password, client);
  const statuses = async (n: number, attempt: (i: number) => Promise<{ statusCode: number }>) => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push((await attempt(i)).statusCode);
    return out;
  };

  describe('login', () => {
    it('counts the failures of two clients apart: locking one out leaves the other in', async () => {
      await start();
      await setupOwner(h!.app);
      await statuses(PER_CLIENT, () => wrong(clientOf(1)));
      const locked = await wrong(clientOf(1));
      expect([locked.statusCode, locked.json().error.code]).toEqual([429, 'too_many_attempts']);
      // Even the right password is refused for the locked-out client...
      expect((await right(clientOf(1))).statusCode).toBe(429);
      // ...while the other client still logs in, and fails with 401 rather than 429.
      expect((await wrong(clientOf(2))).statusCode).toBe(401);
      expect((await right(clientOf(2))).statusCode).toBe(200);
    });

    it('has no effect without the setting: everyone is the proxy address', async () => {
      await start(false);
      await setupOwner(h!.app);
      await statuses(PER_CLIENT, (i) => wrong(clientOf(i + 1)));
      expect((await wrong(clientOf(99))).statusCode).toBe(429);
      expect((await right(undefined)).statusCode).toBe(429);
    });

    it('ignores the header on a request that did not come from loopback', async () => {
      await start();
      await setupOwner(h!.app);
      const remote = '100.64.0.7';
      // Ten different claimed clients, one real address: they share that address's budget.
      await statuses(PER_CLIENT, (i) => wrong(clientOf(i + 1), remote));
      expect((await wrong(clientOf(99), remote)).statusCode).toBe(429);
      // The proxy's own clients are untouched.
      expect((await wrong(clientOf(99))).statusCode).toBe(401);
    });

    it('counts a missing, empty, repeated or invalid header under the connection address', async () => {
      await start();
      await setupOwner(h!.app);
      const bad = [undefined, '', 'not-an-ip', '203.0.113.1, 203.0.113.2', '203.0.113.300'];
      await statuses(PER_CLIENT, (i) => wrong(bad[i % bad.length]));
      expect((await wrong('also invalid')).statusCode).toBe(429);
      expect((await wrong(undefined)).statusCode).toBe(429);
      // A client that is named properly has a budget of its own.
      expect((await wrong(clientOf(1))).statusCode).toBe(401);
    });

    it('never reads X-Forwarded-For, even when the setting names a client header', async () => {
      await start();
      await setupOwner(h!.app);
      const forwarded = (client: string) =>
        h!.app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { 'x-forwarded-for': client },
          payload: { email: OWNER_LOGIN.email, password: 'incorrect password' },
        });
      await statuses(PER_CLIENT, (i) => forwarded(clientOf(i + 1)));
      expect((await forwarded(clientOf(99))).statusCode).toBe(429);
    });

    it('stops all clients together at the shared cap, however many addresses they use', async () => {
      await start();
      await setupOwner(h!.app);
      const clients = MAX_FAILED_ATTEMPTS_ALL_CLIENTS / PER_CLIENT;
      for (let c = 1; c <= clients; c++) {
        expect(await statuses(PER_CLIENT, () => wrong(clientOf(c)))).toEqual(Array(PER_CLIENT).fill(401));
      }
      const fresh = await wrong(clientOf(clients + 1));
      expect([fresh.statusCode, fresh.json().error.code]).toEqual([429, 'too_many_attempts']);
      expect((await right(clientOf(clients + 2))).statusCode).toBe(429);
    });

    it('gives a successful login its slot back in both budgets', async () => {
      await start();
      await setupOwner(h!.app);
      // 49 failures from five clients, none at its own limit.
      for (let n = 0; n < MAX_FAILED_ATTEMPTS_ALL_CLIENTS - 1; n++) {
        expect((await wrong(clientOf(1 + Math.floor(n / PER_CLIENT)))).statusCode).toBe(401);
      }
      // Successes never use up the last slot, whoever they come from.
      // (clientOf(5) has 9 of its 10 failures.)
      for (const client of [clientOf(10), clientOf(10), clientOf(5), clientOf(11)]) {
        expect((await right(client)).statusCode).toBe(200);
      }
      // One more failure takes it; the next attempt, success or not, is refused.
      expect((await wrong(clientOf(12))).statusCode).toBe(401);
      expect((await right(clientOf(13))).statusCode).toBe(429);
    });
  });

  describe('invitations', () => {
    const newAccount = { name: 'Kata', password: 'correct horse battery' };
    const inspect = (client: string | undefined, token = 'unknown', remoteAddress?: string) =>
      h!.app.inject({
        method: 'GET',
        url: `/api/invites/${token}`,
        headers: client === undefined ? {} : { [HEADER]: client },
        ...(remoteAddress ? { remoteAddress } : {}),
      });
    const accept = (client: string | undefined, token = 'unknown') =>
      h!.app.inject({
        method: 'POST',
        url: `/api/invites/${token}/accept`,
        headers: client === undefined ? {} : { [HEADER]: client },
        payload: newAccount,
      });

    async function invite(): Promise<CreatedInvitation> {
      const owner = cookieOf(await login(OWNER_LOGIN.password, clientOf(200)));
      const response = await h!.app.inject({
        method: 'POST',
        url: '/api/projects/AR/invites',
        headers: { cookie: owner },
        payload: { email: 'kata@acme.test', displayName: 'Kata', access: 'developer', roles: ['qa'] },
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json();
    }

    async function startWithProject() {
      await start();
      const owner = await setupOwner(h!.app);
      await createProject(h!, owner);
    }

    it('counts inspections and acceptances per client, and refuses with 429 at the limit', async () => {
      await startWithProject();
      await statuses(PER_CLIENT / 2, () => inspect(clientOf(1)));
      await statuses(PER_CLIENT / 2, () => accept(clientOf(1)));
      for (const response of [await inspect(clientOf(1)), await accept(clientOf(1))]) {
        expect([response.statusCode, response.json().error.code]).toEqual([429, 'too_many_attempts']);
      }
      expect((await inspect(clientOf(2))).statusCode).toBe(404);
      expect((await accept(clientOf(2))).statusCode).toBe(404);
    });

    it('has no effect without the setting, from a non-loopback peer or with an invalid header', async () => {
      await startWithProject();
      await statuses(PER_CLIENT, (i) => inspect(clientOf(i + 1), 'unknown', '100.64.0.7'));
      expect((await inspect(clientOf(99), 'unknown', '100.64.0.7')).statusCode).toBe(429);
      expect((await inspect(clientOf(99))).statusCode).toBe(404);
      await statuses(PER_CLIENT, (i) => inspect(i % 2 ? '' : 'nonsense'));
      expect((await inspect('203.0.113.1, 203.0.113.2')).statusCode).toBe(429);
      expect((await inspect(clientOf(98))).statusCode).toBe(404);

      await h!.close();
      await start(false);
      await statuses(PER_CLIENT, (i) => inspect(clientOf(i + 1)));
      expect((await inspect(clientOf(99))).statusCode).toBe(429);
    });

    it('stops all clients together at the shared cap and gives successes their slot back', async () => {
      await startWithProject();
      const created = await invite();
      const path = created.path.replace('/invite/', '');
      const clients = MAX_FAILED_ATTEMPTS_ALL_CLIENTS / PER_CLIENT;
      for (let n = 0; n < MAX_FAILED_ATTEMPTS_ALL_CLIENTS - 1; n++) {
        expect((await inspect(clientOf(1 + Math.floor(n / PER_CLIENT)))).statusCode).toBe(404);
      }
      for (const client of [clientOf(10), clientOf(10), clientOf(11)]) {
        expect((await inspect(client, path)).statusCode).toBe(200);
      }
      expect((await inspect(clientOf(12))).statusCode).toBe(404);
      const refused = await inspect(clientOf(clients + 20));
      expect([refused.statusCode, refused.json().error.code]).toEqual([429, 'too_many_attempts']);
      expect((await accept(clientOf(clients + 21), path)).statusCode).toBe(429);
    });
  });
});

describe('clickjacking headers (PM-211)', () => {
  let h: AppHarness;
  let dist: string | undefined;
  afterEach(async () => {
    await h.close();
    if (dist) rmSync(dist, { recursive: true, force: true });
    dist = undefined;
  });

  const framing = (headers: Record<string, unknown>) => ({
    csp: String(headers['content-security-policy']),
    frame: headers['x-frame-options'],
  });

  it('forbids framing on the HTML page, the API, errors and the attachment routes', async () => {
    dist = mkdtempSync(join(tmpdir(), 'pm-web-'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>projectman</title>');
    h = await createAppHarness({ webDistDir: dist });
    const owner = await setupOwner(h.app);
    await createProject(h, owner);
    await h.app.projectman.domain.tasks.create('AR', { title: 'Internal task' }, OWNER_ACTOR);

    const get = (url: string, cookie?: string) =>
      h.app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
    const page = await get('/board/AR');
    expect(page.statusCode).toBe(200);
    const pages = [page, await get('/')];
    const api = [
      await get('/api/projects', owner),
      await get('/api/setup'),
      await get('/api/projects', undefined),
      await get('/api/unknown-route', owner),
    ];
    expect(api.map((r) => r.statusCode)).toEqual([200, 200, 401, 404]);
    for (const response of [...pages, ...api]) {
      expect(framing(response.headers), response.body).toEqual({
        csp: "frame-ancestors 'none'",
        frame: 'DENY',
      });
    }

    const png = (await uploadFile(h.app, owner, pngBytes(), {})).json().attachment;
    const html = (await uploadFile(h.app, owner, htmlBytes(), { fileName: 'page.html' })).json().attachment;
    for (const attachment of [png, html]) {
      for (const route of ['attachmentContent', 'attachmentDownload'] as const) {
        const response = await get(routes[route]('AR', 'AR-1', attachment.id), owner);
        expect(response.statusCode, route).toBe(200);
        expect(framing(response.headers)).toEqual({
          csp: "default-src 'none'; sandbox; frame-ancestors 'none'",
          frame: 'DENY',
        });
      }
    }
  });
});
