import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { routes } from '@projectman/shared';
import type {
  CreateFeedbackMarkRequest,
  FeedbackMarkDetail as MarkDetail,
  FeedbackSessionResponse as SessionResponse,
  FeedbackWidgetListResponse as WidgetList,
  ProjectConfig,
} from '@projectman/shared';
import { humanActor } from '../src/kernel';
import { addHumanAndLogin, createAppHarness, createProject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

const SHOP = 'https://shop.example.com';
const BLOG = 'https://blog.example.com';
const EVIL = 'https://evil.example.com';
const SURFACES = [
  { id: 'shop', name: 'Shop', origin: SHOP },
  { id: 'blog', name: 'Blog', origin: BLOG },
];
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const DAY_MS = 24 * 60 * 60 * 1000;

describe('feedback widget API (PM-509)', () => {
  let h: AppHarness;
  let dir: string;
  let widgetFile: string;
  let clock: Date;
  let owner: string;
  const cookies: Record<string, string> = {};
  const tokens: Record<string, string> = {};

  const feedback = () => h.app.projectman.domain.feedback;
  const repo = () => h.app.projectman.repos.feedback;
  const png = () =>
    sharp({ create: { width: 40, height: 30, channels: 3, background: '#cc3333' } })
      .png()
      .toBuffer();
  const markRequest = async (
    opts: { screenshot?: boolean; body?: string; pageUrl?: string } = {},
  ): Promise<CreateFeedbackMarkRequest> => ({
    pageUrl: opts.pageUrl ?? `${SHOP}/cart?step=2#top`,
    pageTitle: 'Cart',
    kind: 'point',
    body: opts.body ?? 'The total is wrong',
    anchor: {
      kind: 'point',
      selector: null,
      textSnippet: null,
      elementOffset: null,
      pagePoint: { x: 10, y: 20 },
      rect: null,
    },
    environment: {
      viewport: { width: 1280, height: 800 },
      scroll: { x: 0, y: 0 },
      devicePixelRatio: 2,
      userAgent: 'Mozilla/5.0 (test)',
      browser: 'Chrome 140',
      os: 'macOS',
      language: 'hu-HU',
    },
    screenshot: opts.screenshot
      ? { mediaType: 'image/png', dataBase64: (await png()).toString('base64') }
      : null,
  });

  /** A request to the widget API as a page of `origin` (none: a client that sends no Origin). */
  const api = (
    method: 'GET' | 'POST' | 'DELETE' | 'OPTIONS',
    path: string,
    opts: {
      origin?: string | null;
      token?: string;
      payload?: unknown;
      headers?: Record<string, string>;
    } = {},
  ) => {
    const origin = opts.origin === undefined ? SHOP : opts.origin;
    return h.app.inject({
      method,
      url: routes.feedbackWidgetApi(path),
      headers: {
        ...(origin ? { origin } : {}),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...opts.headers,
      },
      ...(opts.payload !== undefined ? { payload: opts.payload as object } : {}),
    });
  };
  const errorCode = (response: { json: () => unknown }) =>
    (response.json() as { error: { code: string } }).error.code;

  /** What the app gives a person to start the tool: the one-time code in the address. */
  const launchCode = async (cookie: string, payload: unknown = { surfaceId: 'shop' }) => {
    const response = await h.app.inject({
      method: 'POST',
      url: routes.feedbackLaunch('AR'),
      headers: { cookie, origin: 'http://localhost' },
      payload: payload as object,
    });
    expect(response.statusCode, response.body).toBe(201);
    const { url } = response.json() as { url: string };
    return url.split('pm-feedback=')[1]!.split('&')[0]!;
  };
  const startSession = async (cookie: string, origin: string = SHOP) => {
    const code = await launchCode(cookie);
    const response = await api('POST', '/sessions', { origin, payload: { code } });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as SessionResponse;
  };
  const editFeedback = (edit: (draft: ProjectConfig) => void) =>
    h.app.projectman.domain.projects.update(
      'AR',
      { actor: humanActor('owner'), author: { name: 'Owner', email: 'owner@example.com' } },
      (draft) => {
        edit(draft);
        return 'Change the feedback setup';
      },
    );
  const postMark = async (token: string, opts: Parameters<typeof markRequest>[0] = {}) =>
    api('POST', '/marks', { token, payload: await markRequest(opts) });
  const list = async (token: string, since?: string) => {
    const response = await api('GET', `/marks${since ? `?since=${since}` : ''}`, { token });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as WidgetList;
  };

  beforeEach(async () => {
    clock = new Date('2026-10-12T08:00:00.000Z');
    dir = mkdtempSync(join(tmpdir(), 'pm-widget-'));
    widgetFile = join(dir, 'widget.js');
    writeFileSync(widgetFile, '(function(){})();\n');
    h = await createAppHarness({ now: () => clock, app: { feedbackWidgetFile: widgetFile } });
    owner = await setupOwner(h.app);
    await createProject(h, owner);
    cookies.owner = owner;
    cookies.developer = await addHumanAndLogin(h.app, { handle: 'robin', access: 'developer' });
    cookies.client = await addHumanAndLogin(h.app, { handle: 'cleo', access: 'client' });
    cookies.viewer = await addHumanAndLogin(h.app, { handle: 'vic', access: 'viewer' });
    await editFeedback((draft) => {
      draft.project.feedback = { surfaces: SURFACES, blockedMarkers: [] };
    });
    tokens.client = (await startSession(cookies.client)).token;
    tokens.developer = (await startSession(cookies.developer)).token;
    tokens.owner = (await startSession(cookies.owner)).token;
  });
  afterEach(async () => {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('the script', () => {
    it('is served with a short cache and for any page, and is a 404 before the build exists', async () => {
      const served = await h.app.inject({ method: 'GET', url: routes.feedbackWidgetScript() });
      expect(served.statusCode).toBe(200);
      expect(served.headers['content-type']).toContain('text/javascript');
      expect(served.headers['cache-control']).toBe('public, max-age=300');
      expect(served.headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(served.body).toBe('(function(){})();\n');
      rmSync(widgetFile);
      const missing = await h.app.inject({ method: 'GET', url: routes.feedbackWidgetScript() });
      expect(missing.statusCode).toBe(404);
      expect(errorCode(missing)).toBe('not_found');
    });
  });

  describe('cross-origin access', () => {
    it('answers a preflight from the address of any surface, never allows credentials', async () => {
      for (const origin of [SHOP, BLOG]) {
        const response = await api('OPTIONS', '/marks', {
          origin,
          headers: { 'access-control-request-method': 'POST' },
        });
        expect(response.statusCode).toBe(204);
        expect(response.headers['access-control-allow-origin']).toBe(origin);
        expect(response.headers['access-control-allow-methods']).toBe('GET, POST, DELETE');
        expect(response.headers['access-control-allow-headers']).toBe('authorization, content-type');
        expect(response.headers['access-control-max-age']).toBe('600');
        expect(response.headers['access-control-allow-credentials']).toBeUndefined();
        expect(response.headers.vary).toContain('Origin');
        expect(response.headers['cache-control']).toBe('no-store');
      }
    });

    it('refuses an address that is no surface, with no CORS header, on every route', async () => {
      const calls = [
        api('OPTIONS', '/marks', { origin: EVIL }),
        api('GET', '/marks', { origin: EVIL, token: tokens.client }),
        api('POST', '/sessions', { origin: EVIL, payload: { code: 'x'.repeat(43) } }),
        api('GET', '/marks', { origin: null, token: tokens.client }),
        api('GET', '/marks', { origin: 'null', token: tokens.client }),
      ];
      for (const response of await Promise.all(calls)) {
        expect(response.statusCode).toBe(403);
        expect(errorCode(response)).toBe('feedback_origin_not_allowed');
        expect(response.headers['access-control-allow-origin']).toBeUndefined();
        expect(response.headers['access-control-allow-credentials']).toBeUndefined();
        expect(response.headers['cache-control']).toBe('no-store');
      }
    });

    it('marks every answer for the page that asked, uncached, without credentials', async () => {
      const response = await api('GET', '/marks', { token: tokens.client });
      expect(response.headers['access-control-allow-origin']).toBe(SHOP);
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
      expect(response.headers.vary).toContain('Origin');
      expect(response.headers['cache-control']).toBe('no-store');
      const unauthorized = await api('GET', '/marks');
      expect(unauthorized.statusCode).toBe(401);
      expect(unauthorized.headers['access-control-allow-origin']).toBe(SHOP);
    });

    it('is a JSON 404 for an unknown path of the API', async () => {
      const response = await api('GET', '/nothing', { token: tokens.client });
      expect(response.statusCode).toBe(404);
      expect(errorCode(response)).toBe('not_found');
    });
  });

  describe('exchanging the code', () => {
    it('gives a session once, and keeps only a hash of its token', async () => {
      const code = await launchCode(cookies.client!, { surfaceId: 'shop' });
      const response = await api('POST', '/sessions', { payload: { code } });
      expect(response.statusCode, response.body).toBe(201);
      const session = response.json() as SessionResponse;
      expect(session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(session).toMatchObject({
        me: { handle: 'cleo', kind: 'human' },
        project: { key: 'AR', name: 'acme' },
        surface: { id: 'shop', name: 'Shop', origin: SHOP },
        markId: null,
      });
      expect(session.me.color).toBeGreaterThanOrEqual(0);
      expect(session.appUrl).toBe('http://localhost/p/AR/feedback');
      expect(Date.parse(session.expiresAt) - clock.getTime()).toBe(30 * DAY_MS);
      expect(repo().sessionByTokenHash(session.token)).toBeNull();
      expect(repo().sessionByTokenHash(sha256(session.token))).toMatchObject({
        member: 'cleo',
        origin: SHOP,
        appOrigin: 'http://localhost',
      });

      const again = await api('POST', '/sessions', { payload: { code } });
      expect(again.statusCode).toBe(401);
      expect(errorCode(again)).toBe('feedback_code_invalid');
    });

    it('knows the mark it was started for', async () => {
      const made = await feedback().createMark({
        projectKey: 'AR',
        author: 'cleo',
        surfaceId: 'shop',
        request: await markRequest(),
      });
      const code = await launchCode(cookies.client!, { surfaceId: 'shop', markId: made.id });
      const session = (await api('POST', '/sessions', { payload: { code } })).json() as SessionResponse;
      expect(session.markId).toBe(made.id);
    });

    it('does not name a mark of another surface', async () => {
      const elsewhere = await feedback().createMark({
        projectKey: 'AR',
        author: 'cleo',
        surfaceId: 'blog',
        request: await markRequest({ pageUrl: `${BLOG}/post` }),
      });
      const code = await launchCode(cookies.client!, { surfaceId: 'shop', markId: elsewhere.id });
      const session = (await api('POST', '/sessions', { payload: { code } })).json() as SessionResponse;
      expect(session.markId).toBeNull();
    });

    it('refuses an expired code, a foreign page and a made-up one, all the same way', async () => {
      const expired = await launchCode(cookies.client!);
      clock = new Date(clock.getTime() + 121_000);
      const late = await api('POST', '/sessions', { payload: { code: expired } });
      expect(late.statusCode).toBe(401);
      expect(errorCode(late)).toBe('feedback_code_invalid');

      const foreign = await launchCode(cookies.client!);
      const other = await api('POST', '/sessions', { origin: BLOG, payload: { code: foreign } });
      expect(other.statusCode).toBe(401);
      expect(other.json().error).toEqual(late.json().error);
      // A code tried from the wrong page is used up: it opens nothing afterwards.
      expect((await api('POST', '/sessions', { payload: { code: foreign } })).statusCode).toBe(401);

      for (const code of ['a'.repeat(43), 'short', 42, null]) {
        const made = await api('POST', '/sessions', { payload: { code } });
        expect(made.statusCode).toBe(401);
        expect(made.json().error).toEqual(late.json().error);
      }
    });

    it('refuses a code once the person may no longer mark', async () => {
      const code = await launchCode(cookies.client!);
      await editFeedback((draft) => {
        draft.project.feedback!.blockedMarkers = ['cleo'];
      });
      const response = await api('POST', '/sessions', { payload: { code } });
      expect(response.statusCode).toBe(401);
      expect(errorCode(response)).toBe('feedback_code_invalid');
    });

    it('counts the wrong codes of an address and stops it', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) {
        const response = await api('POST', '/sessions', { payload: { code: `${i}`.padEnd(43, 'a') } });
        statuses.push(response.statusCode);
      }
      expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
      expect(statuses.slice(10)).toEqual([429, 429]);
      // A right code does not get through while the address is stopped.
      const code = await launchCode(cookies.developer!);
      const blocked = await api('POST', '/sessions', { payload: { code } });
      expect(blocked.statusCode).toBe(429);
      expect(errorCode(blocked)).toBe('too_many_attempts');
    });

    it('does not count successful exchanges', async () => {
      for (let i = 0; i < 12; i++) await startSession(cookies.client!);
    });
  });

  describe('marking and reading', () => {
    it('makes a mark, lists it, takes a comment and tracks the read state', async () => {
      const created = await postMark(tokens.client!, { screenshot: true });
      expect(created.statusCode, created.body).toBe(201);
      const mark = created.json() as MarkDetail;
      expect(mark).toMatchObject({
        status: 'new',
        pagePath: '/cart?step=2',
        author: { handle: 'cleo' },
        surface: { id: 'shop' },
        environment: null,
        screenshot: null,
        canProcess: false,
        canComment: true,
        hasScreenshot: true,
      });

      const first = await list(tokens.client!);
      expect(first.marks.map((m) => m.id)).toEqual([mark.id]);
      expect(first.me.handle).toBe('cleo');
      expect(first.markers).toEqual([{ handle: 'cleo', name: 'cleo', color: first.me.color }]);
      // Nothing changed since: an empty list and the same cursor.
      const idle = await list(tokens.client!, first.cursor);
      expect(idle.marks).toEqual([]);
      expect(idle.cursor).toBe(first.cursor);

      const second = await feedback().createMark({
        projectKey: 'AR',
        author: 'robin',
        surfaceId: 'shop',
        request: await markRequest({ body: 'Typo in the footer' }),
      });
      clock = new Date(clock.getTime() + 1000);
      const comment = await api('POST', `/marks/${mark.id}/comments`, {
        token: tokens.client!,
        payload: { body: 'Same on mobile' },
      });
      expect(comment.statusCode, comment.body).toBe(201);
      expect((comment.json() as MarkDetail).thread.map((e) => e.body)).toEqual(['Same on mobile']);
      const changed = await list(tokens.client!, first.cursor);
      expect(changed.marks.map((m) => m.id)).toEqual([second.id, mark.id]);
      expect(changed.marks[1]!.commentCount).toBe(1);

      const detail = await api('GET', `/marks/${mark.id}`, { token: tokens.client! });
      expect(detail.statusCode).toBe(200);
      expect((detail.json() as MarkDetail).id).toBe(mark.id);
    });

    it('shows a reply as unread until the person has read it', async () => {
      const mark = (await (await postMark(tokens.client!)).json()) as MarkDetail;
      const reply = await h.app.inject({
        method: 'POST',
        url: routes.feedbackComments('AR', mark.id),
        headers: { cookie: owner },
        payload: { body: 'Fixed' },
      });
      expect(reply.statusCode, reply.body).toBe(201);
      expect((await list(tokens.client!)).marks[0]).toMatchObject({ unread: true, status: 'handled' });
      const read = await api('POST', `/marks/${mark.id}/read`, { token: tokens.client! });
      expect(read.statusCode).toBe(204);
      expect((await list(tokens.client!)).marks[0]!.unread).toBe(false);
    });

    it('gives a processor no more than anyone else: no environment, screenshot or forward reason', async () => {
      const made = (await (await postMark(tokens.owner!, { screenshot: true })).json()) as MarkDetail;
      const app = await h.app.inject({
        method: 'GET',
        url: routes.feedbackMark('AR', made.id),
        headers: { cookie: owner },
      });
      expect(app.json()).toMatchObject({ canProcess: true, environment: { browser: 'Chrome 140' } });
      const widget = (await (
        await api('GET', `/marks/${made.id}`, { token: tokens.owner! })
      ).json()) as MarkDetail;
      expect(widget).toMatchObject({ canProcess: false, environment: null, screenshot: null });
    });

    it('keeps the key and the title of an internal card from a client', async () => {
      const made = (await (await postMark(tokens.client!)).json()) as MarkDetail;
      const created = await h.app.inject({
        method: 'POST',
        url: routes.feedbackTask('AR', made.id),
        headers: { cookie: owner },
        payload: { title: 'Secret rework', description: '', visibility: 'internal' },
      });
      expect(created.statusCode, created.body).toBe(201);
      for (const response of [
        await api('GET', `/marks/${made.id}`, { token: tokens.client! }),
        await api('GET', '/marks', { token: tokens.client! }),
      ]) {
        expect(response.statusCode).toBe(200);
        expect(response.body).not.toContain('AR-1');
        expect(response.body).not.toContain('Secret rework');
        expect(response.body).toContain('"visible":false');
      }
    });

    it('serves only the marks of its own surface', async () => {
      const elsewhere = await feedback().createMark({
        projectKey: 'AR',
        author: 'cleo',
        surfaceId: 'blog',
        request: await markRequest({ pageUrl: `${BLOG}/post` }),
      });
      expect((await list(tokens.client!)).marks).toEqual([]);
      for (const response of [
        await api('GET', `/marks/${elsewhere.id}`, { token: tokens.client! }),
        await api('POST', `/marks/${elsewhere.id}/comments`, {
          token: tokens.client!,
          payload: { body: 'x' },
        }),
        await api('POST', `/marks/${elsewhere.id}/read`, { token: tokens.client! }),
      ]) {
        expect(response.statusCode).toBe(404);
        expect(errorCode(response)).toBe('feedback_mark_not_found');
      }
    });

    it('refuses a page off the surface and a screenshot that is no image', async () => {
      const off = await postMark(tokens.client!, { pageUrl: `${BLOG}/post` });
      expect(off.statusCode).toBe(422);
      expect(errorCode(off)).toBe('feedback_page_mismatch');
      const fake = await markRequest();
      fake.screenshot = {
        mediaType: 'image/png',
        dataBase64: Buffer.from('<html>not an image</html>').toString('base64'),
      };
      const response = await api('POST', '/marks', { token: tokens.client!, payload: fake });
      expect(response.statusCode).toBe(422);
      expect(errorCode(response)).toBe('feedback_screenshot_invalid');
      expect(repo().listMarks('AR', { limit: 10 })).toEqual([]);
    });

    it('refuses a malformed cursor, mark id and body', async () => {
      expect((await api('GET', '/marks?since=***', { token: tokens.client! })).statusCode).toBe(400);
      expect(
        (
          await api('GET', `/marks?since=${Buffer.from('nonsense').toString('base64url')}`, {
            token: tokens.client!,
          })
        ).statusCode,
      ).toBe(400);
      expect((await api('GET', '/marks/nope', { token: tokens.client! })).statusCode).toBe(404);
      const response = await api('POST', '/marks', { token: tokens.client!, payload: { body: 'x' } });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('the session is checked on every request', () => {
    const lost = async (token: string, origin: string = SHOP) => {
      const response = await api('GET', '/marks', { token, origin });
      expect(response.statusCode, response.body).toBe(401);
      expect(errorCode(response)).toBe('feedback_session_invalid');
    };

    it('works only with a bearer that names a session, from the page it started on', async () => {
      expect((await api('GET', '/marks')).statusCode).toBe(401);
      await lost('x'.repeat(43));
      await lost('short');
      await lost(tokens.client!, BLOG);
      expect((await list(tokens.client!)).marks).toEqual([]);
    });

    it('ends when the person signs out', async () => {
      const out = await api('DELETE', '/sessions/current', { token: tokens.client! });
      expect(out.statusCode).toBe(204);
      await lost(tokens.client!);
      // Other sessions stay.
      expect((await list(tokens.developer!)).marks).toEqual([]);
    });

    it('ends when an owner signs the person out', async () => {
      const out = await h.app.inject({
        method: 'POST',
        url: routes.feedbackMarkerLogout('AR', 'cleo'),
        headers: { cookie: owner },
      });
      expect(out.statusCode).toBe(204);
      await lost(tokens.client!);
      expect((await list(tokens.developer!)).marks).toEqual([]);
    });

    it('ends when the person may no longer mark', async () => {
      await editFeedback((draft) => {
        draft.project.feedback!.blockedMarkers = ['cleo'];
      });
      await lost(tokens.client!);
      // The session is gone for good: allowing the person again needs a new code.
      await editFeedback((draft) => {
        draft.project.feedback!.blockedMarkers = [];
      });
      await lost(tokens.client!);
      expect(repo().sessionByTokenHash(sha256(tokens.client!))).toMatchObject({ revokedBy: 'system' });
      expect((await startSession(cookies.client!)).token).not.toBe(tokens.client);
    });

    it('ends when the person is removed from the team or made a viewer', async () => {
      await editFeedback((draft) => {
        draft.team.members = draft.team.members.filter((m) => m.handle !== 'cleo');
      });
      await lost(tokens.client!);
      await editFeedback((draft) => {
        const robin = draft.team.members.find((m) => m.handle === 'robin');
        if (robin?.kind === 'human') robin.access = 'viewer';
      });
      await lost(tokens.developer!);
    });

    it('stays ended when the handle of a removed member is given to someone else', async () => {
      // The token is not used between the removal and the new member: the removal itself ends it.
      await editFeedback((draft) => {
        draft.team.members = draft.team.members.filter((m) => m.handle !== 'cleo');
      });
      expect(repo().sessionByTokenHash(sha256(tokens.client!))!.revokedAt).not.toBeNull();
      await editFeedback((draft) => {
        draft.team.members.push({
          kind: 'human',
          handle: 'cleo',
          displayName: 'Another Cleo',
          email: 'another@example.test',
          access: 'client',
          roles: [],
        });
      });
      await lost(tokens.client!);
    });

    it('stays ended when a switched-off marker is back before the token is used again', async () => {
      await editFeedback((draft) => {
        draft.project.feedback!.blockedMarkers = ['cleo'];
      });
      await editFeedback((draft) => {
        draft.project.feedback!.blockedMarkers = [];
      });
      await lost(tokens.client!);
    });

    it('ends when the surface is replaced or deleted', async () => {
      // The address stays a surface (of another id): the session's surface is gone.
      await editFeedback((draft) => {
        draft.project.feedback!.surfaces = [{ id: 'shop-2', name: 'Shop', origin: SHOP }, SURFACES[1]!];
      });
      await lost(tokens.client!);
      // No surface has the address any more: the page is not allowed at all.
      await editFeedback((draft) => {
        draft.project.feedback!.surfaces = [SURFACES[1]!];
      });
      const response = await api('GET', '/marks', { token: tokens.developer! });
      expect(response.statusCode).toBe(403);
      expect(errorCode(response)).toBe('feedback_origin_not_allowed');
    });

    it('ends after 30 days unused, and after 90 days however often it is used', async () => {
      clock = new Date(clock.getTime() + 31 * DAY_MS);
      await lost(tokens.client!);

      // The developer's session slides while in use ...
      for (let day = 0; day < 3; day++) {
        clock = new Date(clock.getTime() - (day === 0 ? 31 * DAY_MS : 0) + 25 * DAY_MS);
        expect((await list(tokens.developer!)).marks).toEqual([]);
      }
      // ... but not past 90 days from its start (here day 75 + 16).
      clock = new Date(clock.getTime() + 16 * DAY_MS);
      await lost(tokens.developer!);
    });
  });

  describe('limits', () => {
    it('allows a session 30 marks an hour, then answers 429 with a Retry-After', async () => {
      for (let i = 0; i < 30; i++) {
        const response = await postMark(tokens.developer!, { body: `Mark ${i}` });
        expect(response.statusCode, response.body).toBe(201);
      }
      const over = await postMark(tokens.developer!);
      expect(over.statusCode).toBe(429);
      expect(errorCode(over)).toBe('feedback_rate_limited');
      expect(Number(over.headers['retry-after'])).toBeGreaterThan(3500);
      expect(Number(over.headers['retry-after'])).toBeLessThanOrEqual(3600);
      expect(over.headers['access-control-expose-headers']).toContain('retry-after');
      // Another session has its own allowance; the hour gives this one a new one.
      expect((await postMark(tokens.client!)).statusCode).toBe(201);
      clock = new Date(clock.getTime() + 3600_000 + 1000);
      expect((await postMark(tokens.developer!)).statusCode).toBe(201);
    });

    it('allows a session 120 comments an hour', async () => {
      const mark = (await (await postMark(tokens.client!)).json()) as MarkDetail;
      for (let i = 0; i < 120; i++) {
        const response = await api('POST', `/marks/${mark.id}/comments`, {
          token: tokens.client!,
          payload: { body: `Comment ${i}` },
        });
        expect(response.statusCode, response.body).toBe(201);
      }
      const over = await api('POST', `/marks/${mark.id}/comments`, {
        token: tokens.client!,
        payload: { body: 'One more' },
      });
      expect(over.statusCode).toBe(429);
      expect(errorCode(over)).toBe('feedback_rate_limited');
      expect(over.headers['retry-after']).toBeDefined();
    });

    it('allows a project 500 marks a day, whoever makes them', async () => {
      const request = await markRequest();
      for (let i = 0; i < 500; i++)
        await feedback().createMark({ projectKey: 'AR', author: 'robin', surfaceId: 'shop', request });
      const over = await postMark(tokens.client!);
      expect(over.statusCode).toBe(429);
      expect(errorCode(over)).toBe('feedback_rate_limited');
      expect(Number(over.headers['retry-after'])).toBeGreaterThan(86_000);
      clock = new Date(clock.getTime() + DAY_MS + 1000);
      expect((await postMark(tokens.client!)).statusCode).toBe(201);
    });

    it('counts marks that are being made against the day of the project', async () => {
      const request = await markRequest();
      for (let i = 0; i < 498; i++)
        await feedback().createMark({ projectKey: 'AR', author: 'robin', surfaceId: 'shop', request });
      // A screenshot makes each request wait, so all three pass the check before any is stored.
      const results = await Promise.all(
        [tokens.client!, tokens.developer!, tokens.owner!].map((token) =>
          postMark(token, { screenshot: true }),
        ),
      );
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 201, 429]);
      expect(repo().marksSince('AR', new Date(clock.getTime() - DAY_MS).toISOString()).count).toBe(500);
    });

    it('reads no body before the session is known, and caps it after', async () => {
      const big = { body: 'x'.repeat(4 * 1024 * 1024) };
      // Refused as unauthorised, not as too large: the body was not read.
      const anonymous = await api('POST', '/marks', { payload: big });
      expect(anonymous.statusCode).toBe(401);
      const marks = await api('POST', '/marks', { token: tokens.client!, payload: big });
      expect(marks.statusCode).toBe(413);
      expect(errorCode(marks)).toBe('payload_too_large');
      const mark = (await (await postMark(tokens.client!)).json()) as MarkDetail;
      const comment = await api('POST', `/marks/${mark.id}/comments`, {
        token: tokens.client!,
        payload: { body: 'x'.repeat(70 * 1024) },
      });
      expect(comment.statusCode).toBe(413);
      const exchange = await api('POST', '/sessions', { payload: { code: 'x'.repeat(70 * 1024) } });
      expect(exchange.statusCode).toBe(413);
      const signOut = await api('DELETE', '/sessions/current', {
        token: tokens.developer!,
        payload: { junk: 'x'.repeat(70 * 1024) },
      });
      expect(signOut.statusCode).toBe(413);
    });
  });
});
