import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CreatedInvitation, ServerEvent, SetupStatus, Task } from '@projectman/shared';
import { routes } from '@projectman/shared';
import type { FastifyInstance } from 'fastify';
import {
  assertPublicBoardReady,
  parsePublicBoardEnv,
  PUBLIC_BOARD_REQUIRES_CLOUD,
  PUBLIC_BOARD_REQUIRES_EMAIL_LOGIN,
  PUBLIC_BOARD_REQUIRES_SETUP,
  PublicBoardNotReadyError,
} from '../src/auth';
import type { EmailCodeMailInput, EmailCodeMailer } from '../src/contracts';
import { cookieOf, createAppHarness, createProject, inject, OWNER_LOGIN } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { flush } from './helpers/fakes';

/**
 * The public board (PM-672): the start-time switch and its readiness conditions, and the boundary the board
 * keeps by itself (its own login) once Cloudflare Access is not in front of its pages.
 */

const HOST = 'board.example.com';
const CODE = 'ABCD-2345-WXYZ';
const TUNNEL_HEADERS = {
  host: HOST,
  'x-forwarded-for': '203.0.113.9',
  'cf-connecting-ip': '203.0.113.9',
  'x-forwarded-proto': 'https',
};
const IP_HEADER = 'cf-connecting-ip';

class FakeMailer implements EmailCodeMailer {
  sent: EmailCodeMailInput[] = [];
  async send(input: EmailCodeMailInput): Promise<void> {
    this.sent.push(input);
  }
  codeFor(to: string): string {
    const letter = [...this.sent].reverse().find((s) => s.to === to);
    if (!letter) throw new Error(`no letter to ${to}`);
    return letter.code;
  }
}

interface TestSocket {
  send(data: string): void;
  terminate(): void;
  on(event: 'message', listener: (data: Buffer) => void): void;
}

describe('the environment switch', () => {
  it('is off by default and takes 0 or 1 only', () => {
    expect(parsePublicBoardEnv({})).toBe(false);
    expect(parsePublicBoardEnv({ PROJECTMAN_PUBLIC_BOARD: '' })).toBe(false);
    expect(parsePublicBoardEnv({ PROJECTMAN_PUBLIC_BOARD: '0' })).toBe(false);
    expect(parsePublicBoardEnv({ PROJECTMAN_PUBLIC_BOARD: ' 1 ' })).toBe(true);
    for (const bad of ['true', 'yes', '2', 'on'])
      expect(() => parsePublicBoardEnv({ PROJECTMAN_PUBLIC_BOARD: bad })).toThrow(
        /invalid PROJECTMAN_PUBLIC_BOARD/,
      );
  });
});

describe('the readiness conditions', () => {
  const ready = { cloud: true, needsSetup: false, emailLogin: true };
  const codeOf = (state: Parameters<typeof assertPublicBoardReady>[0]) => {
    try {
      assertPublicBoardReady(state);
    } catch (error) {
      expect(error).toBeInstanceOf(PublicBoardNotReadyError);
      return (error as PublicBoardNotReadyError).code;
    }
    return null;
  };

  it('starts only in cloud mode, with an owner set up and a working e-mail login', () => {
    expect(codeOf(ready)).toBeNull();
    expect(codeOf({ ...ready, cloud: false })).toBe(PUBLIC_BOARD_REQUIRES_CLOUD);
    expect(codeOf({ ...ready, needsSetup: true })).toBe(PUBLIC_BOARD_REQUIRES_SETUP);
    expect(codeOf({ ...ready, emailLogin: false })).toBe(PUBLIC_BOARD_REQUIRES_EMAIL_LOGIN);
  });

  it('names the first missing condition, and puts the code first in the message', () => {
    expect(codeOf({ cloud: false, needsSetup: true, emailLogin: false })).toBe(PUBLIC_BOARD_REQUIRES_CLOUD);
    expect(codeOf({ cloud: true, needsSetup: true, emailLogin: false })).toBe(PUBLIC_BOARD_REQUIRES_SETUP);
    expect(() => assertPublicBoardReady({ ...ready, emailLogin: false })).toThrow(
      /^public_board_requires_email_login: /,
    );
  });
});

describe('the board that starts as public', () => {
  let h: AppHarness;
  let mailer: FakeMailer;
  let owner: string;
  let app: FastifyInstance;

  const withHeaders = (cookie?: string, extra: Record<string, string> = {}) => ({
    ...TUNNEL_HEADERS,
    ...(cookie ? { cookie } : {}),
    ...extra,
  });
  const get = (url: string, cookie?: string, extra: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers: withHeaders(cookie, extra) });
  const post = (url: string, payload: object, cookie?: string, extra: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, headers: withHeaders(cookie, extra), payload });

  beforeEach(async () => {
    mailer = new FakeMailer();
    // A project needs a connected engine in cloud mode, so the owner and the project are made in a single-mode
    // start; the same home and database are then started again as the cloud board.
    h = await createAppHarness({ app: { clientIpHeader: IP_HEADER, emailCodeMailer: mailer } });
    app = h.app;
    owner = cookieOf(await app.inject({ method: 'POST', url: routes.setup(), payload: OWNER_LOGIN }));
    await createProject(h, owner);
  });
  afterEach(async () => {
    await h.close();
  });

  /** Starts again over the same database as the public board. */
  async function goPublic(): Promise<void> {
    app = await h.relaunch({ engineMode: 'cloud', publicBoard: true });
  }

  it('refuses to start without cloud mode, without an owner, and without the e-mail login', async () => {
    await expect(h.relaunch({ publicBoard: true })).rejects.toMatchObject({
      code: PUBLIC_BOARD_REQUIRES_CLOUD,
    });
    await expect(
      h.relaunch({ engineMode: 'cloud', publicBoard: true, emailCodeMailer: undefined }),
    ).rejects.toMatchObject({ code: PUBLIC_BOARD_REQUIRES_EMAIL_LOGIN });
    const fresh = createAppHarness({
      app: { engineMode: 'cloud', publicBoard: true, emailCodeMailer: mailer, setupCode: CODE },
    });
    await expect(fresh).rejects.toMatchObject({ code: PUBLIC_BOARD_REQUIRES_SETUP });
  });

  it('says so in the setup status, and a board that is not public does not', async () => {
    const before = (await get(routes.setupStatus())).json() as SetupStatus;
    expect(before).not.toHaveProperty('publicBoard');
    await goPublic();
    const after = (await get(routes.setupStatus())).json() as SetupStatus;
    expect(after).toMatchObject({ needsSetup: false, emailLoginEnabled: true, publicBoard: true });
  });

  it('keeps everything behind the login closed to an anonymous caller', async () => {
    await goPublic();
    for (const url of [
      routes.me(),
      routes.projects(),
      routes.tasks('AR'),
      routes.task('AR', 'AR-1'),
      routes.taskAttachments('AR', 'AR-1'),
    ]) {
      const res = await get(url);
      expect([url, res.statusCode]).toEqual([url, 401]);
    }
    await expect(app.injectWS('/ws', { headers: TUNNEL_HEADERS })).rejects.toThrow();
  });

  it('answers the engine’s doors and the API only when the path is spelled out, not percent-encoded', async () => {
    await goPublic();
    // The tunnel's audience rule for /engine and the origin check for /api match the raw path; the router decodes.
    const literal = await get('/engine/link');
    expect(literal.statusCode).not.toBe(404);
    for (const url of [
      '/%65ngine/link',
      '/%65ngine/files/downloads/smoke-test',
      '/%45ngine/link',
      '/engin%65/link',
    ]) {
      const res = await get(url);
      expect([url, res.statusCode]).toEqual([url, 404]);
    }
    const upload = await post('/%65ngine/files/uploads/smoke-test', {});
    expect(upload.statusCode).toBe(404);
    await expect(app.injectWS('/%65ngine/link', { headers: TUNNEL_HEADERS })).rejects.toThrow();
    // A write to the API without the board's origin is refused when spelled out; encoded it is not routed at all.
    const own = await post(routes.logout(), {}, undefined, { origin: 'https://evil.example' });
    expect(own.statusCode).toBe(403);
    const hidden = await post('/%61pi/auth/logout', {}, undefined, { origin: 'https://evil.example' });
    expect(hidden.statusCode).toBe(404);
  });

  it('refuses a cross-origin login and accepts the board’s own origin', async () => {
    await goPublic();
    for (const origin of ['https://evil.example', 'http://localhost:5173', 'null']) {
      const res = await post(routes.emailLoginRequest(), { email: 'kata@acme.test' }, undefined, { origin });
      expect([origin, res.statusCode]).toEqual([origin, 403]);
    }
    const own = await post(routes.emailLoginRequest(), { email: 'kata@acme.test' }, undefined, {
      origin: `https://${HOST}`,
    });
    expect(own.statusCode).toBe(202);
  });

  describe('a client who logged in with an e-mailed code', () => {
    const ADDRESS = 'kata@acme.test';
    let client: string;
    let sharedKey: string;
    let internalKey: string;

    beforeEach(async () => {
      const invited = await inject(app, 'POST', '/api/projects/AR/invites', owner, {
        email: ADDRESS,
        displayName: 'Kata',
        access: 'client',
        roles: [],
      });
      expect(invited.statusCode, invited.body).toBe(201);
      void (invited.json() as CreatedInvitation);
      const shared = await inject(app, 'POST', routes.tasks('AR'), owner, {
        title: 'Shared',
        visibility: 'shared',
      });
      sharedKey = (shared.json() as Task).key;
      const internal = await inject(app, 'POST', routes.tasks('AR'), owner, {
        title: 'Internal',
        visibility: 'internal',
      });
      internalKey = (internal.json() as Task).key;
      await goPublic();
      await post(routes.emailLoginRequest(), { email: ADDRESS });
      await app.projectman.domain.emailLogin!.settled();
      const login = await post(routes.emailLoginVerify(), { email: ADDRESS, code: mailer.codeFor(ADDRESS) });
      expect(login.statusCode, login.body).toBe(200);
      const cookie = String(login.headers['set-cookie']);
      // The session cookie is the only credential: not readable by scripts, not sent cross-site, HTTPS only.
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Secure');
      expect(cookie).toMatch(/SameSite=(Lax|Strict)/);
      client = cookie.split(';')[0]!;
    });

    it('sees the shared card and the project only through their own access', async () => {
      const me = await get(routes.me(), client);
      expect(me.statusCode).toBe(200);
      const list = (await get(routes.tasks('AR'), client)).json() as Task[];
      expect(list.map((task) => task.key)).toEqual([sharedKey]);
      expect((await get(routes.task('AR', sharedKey), client)).statusCode).toBe(200);
    });

    it('cannot tell an internal card from one that does not exist', async () => {
      const internal = await get(routes.task('AR', internalKey), client);
      const missing = await get(routes.task('AR', 'AR-999'), client);
      expect(internal.statusCode).toBe(missing.statusCode);
      expect(internal.statusCode).toBeGreaterThanOrEqual(400);
      expect((internal.json() as { error: { code: string } }).error.code).toBe(
        (missing.json() as { error: { code: string } }).error.code,
      );
      const files = await get(routes.taskAttachments('AR', internalKey), client);
      const none = await get(routes.taskAttachments('AR', 'AR-999'), client);
      expect(files.statusCode).toBe(none.statusCode);
      expect(files.statusCode).toBeGreaterThanOrEqual(400);
    });

    it('has no way into another project or into the internal pages', async () => {
      for (const url of [routes.tasks('BR'), routes.task('BR', 'BR-1')]) {
        const res = await get(url, client);
        expect([url, res.statusCode >= 400]).toEqual([url, true]);
      }
      const projects = (await get(routes.projects(), client)).json() as { key: string }[];
      expect(projects.map((project) => project.key)).toEqual(['AR']);
    });

    it('hears nothing of an internal card on the live connection', async () => {
      const events: ServerEvent[] = [];
      const ws = (await app.injectWS(
        '/ws',
        { headers: { ...TUNNEL_HEADERS, cookie: client } },
        {
          onInit: (socket) =>
            (socket as unknown as TestSocket).on('message', (data) =>
              events.push(JSON.parse(data.toString()) as ServerEvent),
            ),
        },
      )) as unknown as TestSocket;
      try {
        ws.send(JSON.stringify({ type: 'subscribe_project', projectKey: 'AR' }));
        await flush();
        events.length = 0;
        const made = await inject(app, 'POST', routes.tasks('AR'), owner, {
          title: 'Another internal',
          visibility: 'internal',
        });
        const madeKey = (made.json() as Task).key;
        await inject(app, 'POST', routes.tasks('AR'), owner, {
          title: 'Another shared',
          visibility: 'shared',
        });
        await flush();
        const seen = events.flatMap((event) => (event.type === 'task_upserted' ? [event.task.key] : []));
        expect(seen).not.toContain(madeKey);
        expect(seen).not.toContain(internalKey);
        expect(seen.length).toBeGreaterThan(0);
      } finally {
        ws.terminate();
      }
    });
  });
});
