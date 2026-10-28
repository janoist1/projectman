import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedbackMarkDetail } from '@projectman/shared';
import { createController } from './controller';
import type { Controller, Deps, Target } from './controller';
import { ShareRefused } from './display-capture';
import type { DisplayShare } from './display-capture';
import { sessionKey } from './storage';
import {
  API,
  CODE,
  PAGE,
  detail,
  failure,
  fakeServer,
  flush,
  mark,
  pageAnchor,
  pointAnchor,
  reply,
  session,
  setUrl,
} from './test/helpers';
import type { Handler } from './test/helpers';

const scope = { apiOrigin: API, projectKey: 'PM' };
const KEY = sessionKey(scope);

const listOf = (...marks: ReturnType<typeof mark>[]) =>
  reply(200, { marks, markers: [], cursor: 'c1', me: session().me });

const okRoutes = (extra: Record<string, Handler> = {}): Record<string, Handler> => ({
  'POST /sessions': () => reply(201, session()),
  'GET /marks': () => listOf(),
  ...extra,
});

const pointTarget = (): Target => ({
  kind: 'point',
  anchor: pointAnchor(),
  label: 'Point',
  viewportRect: null,
  viewportPoint: { x: 100, y: 200 },
});

const shot = {
  upload: { mediaType: 'image/jpeg' as const, dataBase64: 'AAAA' },
  preview: 'data:image/jpeg;base64,AAAA',
};
const madeShot = { ok: true as const, ...shot, missing: [] as string[] };
const failedShot = { ok: false as const, failure: { kind: 'timeout' as const } };

const browserShot = {
  upload: { mediaType: 'image/jpeg' as const, dataBase64: 'BBBB' },
  preview: 'data:image/jpeg;base64,BBBB',
};

/** A screen share that needs no real media: `end()` is the browser's sharing bar stopping it. */
function fakeDisplay(options: { refuse?: 'denied' | 'error'; marked?: boolean } = {}) {
  const stop = vi.fn();
  let ended: (() => void) | null = null;
  const share: DisplayShare = {
    surface: 'browser',
    grab: vi.fn(async () => ({
      outcome: { ok: true as const, ...browserShot, missing: [] as string[] },
      marked: options.marked ?? true,
    })),
    stop,
    onEnded: (listener) => {
      ended = listener;
    },
  };
  const start = vi.fn(async () => {
    if (options.refuse) throw new ShareRefused(options.refuse);
    return share;
  });
  return { display: { can: () => true, start }, share, start, stop, end: () => ended?.() };
}

let controllers: Controller[] = [];
function build(
  routes: Record<string, Handler>,
  options: {
    capture?: () => Promise<typeof madeShot | typeof failedShot>;
    display?: Deps['display'];
  } = {},
) {
  const server = fakeServer(routes);
  const controller = createController({
    win: window,
    base: API,
    projectKey: 'PM',
    fetchImpl: server.fetchImpl,
    capture: (options.capture ?? (async () => madeShot)) as never,
    display: options.display ?? {
      can: () => false,
      start: async () => Promise.reject(new Error('no share')),
    },
  });
  controllers.push(controller);
  return { controller, server };
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  setUrl(PAGE);
});
afterEach(() => {
  for (const controller of controllers) controller.stop();
  controllers = [];
});

describe('starting', () => {
  it('requests nothing without a code and without a stored session', async () => {
    const { controller, server } = build(okRoutes());
    await controller.start();
    await flush();
    expect(server.calls).toEqual([]);
    expect(controller.getState()).toMatchObject({ phase: 'off', notice: null });
  });

  it('exchanges the code, stores the session under the API origin and key, and removes the code', async () => {
    setUrl(`${PAGE}#pm-feedback=${CODE}`);
    const { controller, server } = build(okRoutes());
    await controller.start();
    await flush();
    expect(server.calls[0]).toMatchObject({ method: 'POST', path: '/sessions', body: { code: CODE } });
    expect(server.calls[0]?.headers.authorization).toBeUndefined();
    expect(window.location.href).toBe(PAGE);
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? '{}')).toMatchObject({ token: 'tok_secret' });
    const listCall = server.calls.find((call) => call.method === 'GET');
    expect(listCall?.headers.authorization).toBe('Bearer tok_secret');
    expect(controller.getState()).toMatchObject({ phase: 'ready', loaded: true, welcomeOpen: true });
  });

  it('starts on a stored session without a code', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(session()));
    const { controller, server } = build(okRoutes());
    await controller.start();
    await flush();
    expect(server.calls.map((call) => `${call.method} ${call.path}`)).toEqual(['GET /marks']);
    expect(controller.getState().phase).toBe('ready');
  });

  it('says the code is no use when the server refuses it and there is no stored session', async () => {
    setUrl(`${PAGE}#pm-feedback=${CODE}`);
    const { controller } = build(okRoutes({ 'POST /sessions': () => failure(401, 'feedback_code_invalid') }));
    await controller.start();
    expect(controller.getState()).toMatchObject({ phase: 'off', notice: 'badCode' });
  });

  it('starts silently on the stored session when the server refuses the code', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(session()));
    setUrl(`${PAGE}#pm-feedback=${CODE}`);
    const { controller } = build(okRoutes({ 'POST /sessions': () => failure(401, 'feedback_code_invalid') }));
    await controller.start();
    await flush();
    expect(controller.getState()).toMatchObject({ phase: 'ready', notice: null });
  });

  it('refuses a malformed code without asking the server', async () => {
    setUrl(`${PAGE}#pm-feedback=nope`);
    const { controller, server } = build(okRoutes());
    await controller.start();
    expect(server.calls).toEqual([]);
    expect(controller.getState().notice).toBe('badCode');
  });

  it('reports a start error that can be retried', async () => {
    setUrl(`${PAGE}#pm-feedback=${CODE}`);
    let down = true;
    const { controller } = build(
      okRoutes({ 'POST /sessions': () => (down ? failure(503, 'unavailable') : reply(201, session())) }),
    );
    await controller.start();
    expect(controller.getState()).toMatchObject({ phase: 'off', notice: 'startError' });
    down = false;
    await controller.retryStart();
    await flush();
    expect(controller.getState()).toMatchObject({ phase: 'ready', notice: null });
  });

  it('refuses a session of another project', async () => {
    setUrl(`${PAGE}#pm-feedback=${CODE}`);
    const { controller } = build(
      okRoutes({ 'POST /sessions': () => reply(201, session({ project: { key: 'OTHER', name: 'x' } })) }),
    );
    await controller.start();
    expect(controller.getState().notice).toBe('badCode');
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });
});

describe('ending', () => {
  it('shows the expired state and clears the storage when the list answers 401', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(session()));
    const { controller } = build(okRoutes({ 'GET /marks': () => failure(401, 'feedback_session_invalid') }));
    await controller.start();
    await flush();
    expect(controller.getState()).toMatchObject({ phase: 'off', notice: 'expired' });
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('switches off with the signed-out state when another tab clears the session', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(session()));
    const { controller } = build(okRoutes());
    await controller.start();
    await flush();
    window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: null }));
    expect(controller.getState()).toMatchObject({ phase: 'off', notice: 'signedOut' });
  });

  it('clears the storage on logout even when the request fails', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(session()));
    const { controller, server } = build(
      okRoutes({ 'DELETE /sessions/current': () => failure(500, 'boom') }),
    );
    await controller.start();
    await flush();
    await controller.logout();
    expect(server.calls.some((call) => call.method === 'DELETE')).toBe(true);
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(controller.getState()).toMatchObject({ phase: 'off', notice: 'signedOut' });
  });

  it('goes offline after repeated failures and recovers on success', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(session()));
    let down = false;
    const { controller } = build(okRoutes({ 'GET /marks': () => (down ? failure(503, 'x') : listOf()) }));
    await controller.start();
    await flush();
    down = true;
    await controller.refresh();
    expect(controller.getState().offline).toBe(false);
    await controller.refresh();
    expect(controller.getState().offline).toBe(true);
    down = false;
    await controller.refresh();
    expect(controller.getState().offline).toBe(false);
  });
});

describe('refreshing', () => {
  it('asks for a full list again when the route changes', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(session()));
    const { controller, server } = build(okRoutes());
    await controller.start();
    await flush();
    window.history.pushState(null, '', '/elsewhere');
    await flush();
    const lists = server.calls.filter((call) => call.method === 'GET').map((call) => call.path);
    expect(lists).toEqual(['/marks', '/marks']);
    expect(controller.getState().place).toBe('/elsewhere');
  });

  it('asks for changes since the cursor on a later refresh', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(session()));
    const { controller, server } = build(okRoutes());
    await controller.start();
    await flush();
    await controller.refresh();
    expect(server.calls.filter((call) => call.method === 'GET').at(-1)?.path).toBe('/marks?since=c1');
  });
});

describe('sending a mark', () => {
  async function ready(
    extra: Record<string, Handler> = {},
    capture?: () => Promise<typeof madeShot | typeof failedShot>,
  ) {
    window.localStorage.setItem(KEY, JSON.stringify(session()));
    const built = build(okRoutes(extra), { capture });
    await built.controller.start();
    await flush();
    built.controller.chooseTarget(pointTarget());
    await flush();
    return built;
  }

  it('sends the text with the screenshot and puts the mark in the state', async () => {
    const created: FeedbackMarkDetail = detail({ id: 'fbm_new0000000', body: 'Looks off' });
    const { controller, server } = await ready({ 'POST /marks': () => reply(201, created) });
    controller.setBody('  Looks off  ');
    await controller.sendMark();
    const call = server.calls.find((c) => c.method === 'POST' && c.path === '/marks');
    expect(call?.body).toMatchObject({
      kind: 'point',
      body: 'Looks off',
      pageUrl: PAGE,
      screenshot: shot.upload,
    });
    const state = controller.getState();
    expect(state.marks.fbm_new0000000?.body).toBe('Looks off');
    expect(state).toMatchObject({ card: null, draft: null });
    expect(state.flash).toContain('Elküldve');
  });

  it('sends without a screenshot when the switch is off', async () => {
    const { controller, server } = await ready({ 'POST /marks': () => reply(201, detail()) });
    controller.setBody('x');
    controller.setShotEnabled(false);
    await controller.sendMark();
    expect(server.calls.find((c) => c.path === '/marks' && c.method === 'POST')?.body).toMatchObject({
      screenshot: null,
    });
  });

  it('sends without a screenshot when none could be made', async () => {
    const { controller, server } = await ready(
      { 'POST /marks': () => reply(201, detail()) },
      async () => failedShot,
    );
    expect(controller.getState().draft?.shot.status).toBe('failed');
    controller.setBody('x');
    await controller.sendMark();
    expect(server.calls.find((c) => c.path === '/marks' && c.method === 'POST')?.body).toMatchObject({
      screenshot: null,
    });
    expect(controller.getState().flash).toContain('képernyőkép nem készült el');
  });

  it('writes the reason of a failed picture to the console once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { controller } = await ready(
      {},
      async () =>
        ({ ok: false, failure: { kind: 'resource', urls: ['https://cdn.example/a.jpg'] } }) as never,
    );
    expect(controller.getState().draft?.shot.status).toBe('failed');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('https://cdn.example/a.jpg');
  });

  it('retries without the picture when the server rejects it', async () => {
    let attempts = 0;
    const { controller, server } = await ready({
      'POST /marks': () =>
        ++attempts === 1 ? failure(413, 'feedback_screenshot_too_large') : reply(201, detail()),
    });
    controller.setBody('x');
    await controller.sendMark();
    const posts = server.calls.filter((c) => c.method === 'POST' && c.path === '/marks');
    expect(posts.map((c) => (c.body as { screenshot: unknown }).screenshot !== null)).toEqual([true, false]);
    expect(controller.getState().draft).toBeNull();
  });

  it('keeps the text and offers a retry when sending fails', async () => {
    const { controller } = await ready({ 'POST /marks': () => failure(500, 'boom') });
    controller.setBody('Do not lose me');
    await controller.sendMark();
    expect(controller.getState().draft).toMatchObject({
      body: 'Do not lose me',
      sending: false,
      error: { kind: 'send' },
    });
  });

  it('keeps the text and gives the wait in whole minutes on 429', async () => {
    const { controller } = await ready({
      'POST /marks': () => failure(429, 'feedback_rate_limited', { 'retry-after': '90' }),
    });
    controller.setBody('Many marks');
    await controller.sendMark();
    expect(controller.getState().draft).toMatchObject({
      body: 'Many marks',
      error: { kind: 'rate', minutes: 2 },
    });
  });

  it('does not send an empty or too long text', async () => {
    const { controller, server } = await ready({ 'POST /marks': () => reply(201, detail()) });
    controller.setBody('   ');
    await controller.sendMark();
    controller.setBody('x'.repeat(4001));
    await controller.sendMark();
    expect(server.calls.some((c) => c.method === 'POST' && c.path === '/marks')).toBe(false);
  });

  it('sends a whole-page mark with an empty anchor', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(session()));
    const { controller, server } = build(
      okRoutes({ 'POST /marks': () => reply(201, detail({ kind: 'page' })) }),
    );
    await controller.start();
    await flush();
    controller.choosePage();
    controller.setBody('The whole page is slow');
    await controller.sendMark();
    const body = server.calls.find((c) => c.method === 'POST' && c.path === '/marks')?.body as {
      kind: string;
      anchor: unknown;
    };
    expect(body.kind).toBe('page');
    expect(body.anchor).toEqual(pageAnchor());
  });
});

describe('the browser picture (PM-921)', () => {
  const posts = (server: ReturnType<typeof build>['server']) =>
    server.calls.filter((c) => c.method === 'POST' && c.path === '/marks');

  async function open(
    fake: ReturnType<typeof fakeDisplay>,
    capture?: () => Promise<typeof madeShot | typeof failedShot>,
  ) {
    window.localStorage.setItem(KEY, JSON.stringify(session()));
    const built = build(okRoutes({ 'POST /marks': () => reply(201, detail()) }), {
      display: fake.display,
      capture,
    });
    await built.controller.start();
    await flush();
    built.controller.chooseTarget(pointTarget());
    await flush();
    return built;
  }

  it('replaces a ready automatic picture and the mark is sent with it', async () => {
    const fake = fakeDisplay();
    const { controller, server } = await open(fake);
    await controller.captureWithBrowser();
    expect(controller.getState()).toMatchObject({ sharing: true });
    expect(controller.getState().draft?.shot).toMatchObject({
      status: 'ready',
      source: 'browser',
      unmarked: false,
      browser: 'idle',
      preview: browserShot.preview,
    });
    controller.setBody('x');
    await controller.sendMark();
    expect(posts(server)[0]?.body).toMatchObject({ screenshot: browserShot.upload });
  });

  it('drops an automatic picture that arrives after the browser one', async () => {
    let finishAuto: (shot: typeof madeShot) => void = () => undefined;
    const fake = fakeDisplay();
    const { controller, server } = await open(
      fake,
      () => new Promise<typeof madeShot>((resolve) => (finishAuto = resolve)),
    );
    await controller.captureWithBrowser();
    finishAuto(madeShot);
    await flush();
    expect(controller.getState().draft?.shot).toMatchObject({
      source: 'browser',
      preview: browserShot.preview,
    });
    controller.setBody('x');
    await controller.sendMark();
    expect(posts(server)[0]?.body).toMatchObject({ screenshot: browserShot.upload });
  });

  it('marks a picture of a shared window as unmarked: the place is not on it', async () => {
    const { controller } = await open(fakeDisplay({ marked: false }));
    await controller.captureWithBrowser();
    expect(controller.getState().draft?.shot).toMatchObject({ source: 'browser', unmarked: true });
  });

  it('asks once and takes the next mark picture from the open share without the automatic one', async () => {
    const fake = fakeDisplay();
    const capture = vi.fn(async () => madeShot);
    const { controller } = await open(fake, capture);
    await controller.captureWithBrowser();
    controller.cancelDraft();
    controller.chooseTarget(pointTarget());
    await flush();
    expect(fake.start).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(controller.getState().draft?.shot).toMatchObject({ status: 'ready', source: 'browser' });
  });

  it('stops the share on logout, and without it the next mark picture is automatic again', async () => {
    const fake = fakeDisplay();
    const { controller } = await open(fake);
    await controller.captureWithBrowser();
    await controller.logout();
    expect(fake.stop).toHaveBeenCalledTimes(1);
    expect(controller.getState().sharing).toBe(false);
  });

  it('returns to the automatic picture after the share is stopped, and says so', async () => {
    const fake = fakeDisplay();
    const capture = vi.fn(async () => madeShot);
    const { controller } = await open(fake, capture);
    await controller.captureWithBrowser();
    controller.stopSharing();
    expect(fake.stop).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toMatchObject({ sharing: false });
    expect(controller.getState().flash).toContain('megosztás leállt');
    controller.cancelDraft();
    controller.chooseTarget(pointTarget());
    await flush();
    expect(capture).toHaveBeenCalledTimes(2);
    expect(controller.getState().draft?.shot.source).toBe('auto');
  });

  it('notices when the browser ends the share from its sharing bar', async () => {
    const fake = fakeDisplay();
    const { controller } = await open(fake);
    await controller.captureWithBrowser();
    fake.end();
    expect(controller.getState().sharing).toBe(false);
    expect(controller.getState().flash).toContain('megosztás leállt');
  });

  it('ends the share quietly when the page is left', async () => {
    const fake = fakeDisplay();
    const { controller } = await open(fake);
    await controller.captureWithBrowser();
    window.dispatchEvent(new Event('pagehide'));
    expect(fake.stop).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toMatchObject({ sharing: false, flash: null });
  });

  it('keeps the share when the marks are hidden', async () => {
    const fake = fakeDisplay();
    const { controller } = await open(fake);
    await controller.captureWithBrowser();
    controller.toggleHidden();
    expect(fake.stop).not.toHaveBeenCalled();
    expect(controller.getState().sharing).toBe(true);
  });

  it.each(['denied', 'error'] as const)(
    'sends the automatic picture when the share is %s',
    async (reason) => {
      const fake = fakeDisplay({ refuse: reason });
      const { controller, server } = await open(fake);
      await controller.captureWithBrowser();
      expect(controller.getState().draft?.shot).toMatchObject({ source: 'auto', browser: reason });
      expect(controller.getState().sharing).toBe(false);
      controller.setBody('x');
      await controller.sendMark();
      expect(posts(server)[0]?.body).toMatchObject({ screenshot: shot.upload });
    },
  );

  it('sends without a picture when the share is denied and the automatic one failed too', async () => {
    const fake = fakeDisplay({ refuse: 'denied' });
    const { controller, server } = await open(fake, async () => failedShot);
    await controller.captureWithBrowser();
    expect(controller.getState().draft?.shot).toMatchObject({ status: 'failed', browser: 'denied' });
    controller.setBody('x');
    await controller.sendMark();
    expect(posts(server)[0]?.body).toMatchObject({ screenshot: null });
  });

  it('does not ask again while an answer is awaited', async () => {
    let answer: (share: DisplayShare) => void = () => undefined;
    const fake = fakeDisplay();
    fake.start.mockImplementation(() => new Promise<DisplayShare>((resolve) => (answer = resolve)));
    const { controller } = await open(fake);
    const first = controller.captureWithBrowser();
    await controller.captureWithBrowser();
    expect(fake.start).toHaveBeenCalledTimes(1);
    answer(fake.share);
    await first;
  });
});

describe('threads', () => {
  it('opens a pinned mark as a card, loads its thread and marks it read', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(session()));
    const seen = mark({ id: 'fbm_unread0000', unread: true });
    const { controller, server } = build(
      okRoutes({
        'GET /marks': () => listOf(seen),
        'GET /marks/fbm_unread0000': () => reply(200, detail({ id: 'fbm_unread0000', unread: true })),
        'POST /marks/fbm_unread0000/read': () => reply(204),
      }),
    );
    await controller.start();
    await flush();
    controller.openMark('fbm_unread0000', { scroll: false });
    await flush();
    const state = controller.getState();
    expect(state.card).toEqual({ type: 'thread', markId: 'fbm_unread0000' });
    expect(state.threads.fbm_unread0000?.status).toBe('ready');
    expect(state.marks.fbm_unread0000?.unread).toBe(false);
    expect(server.calls.some((c) => c.path === '/marks/fbm_unread0000/read')).toBe(true);
  });

  it('opens a mark without a place in the panel', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(session()));
    const lost = mark({ id: 'fbm_lost000000', anchor: pointAnchor(99999, 99999) });
    const { controller } = build(
      okRoutes({
        'GET /marks': () => listOf(lost),
        'GET /marks/fbm_lost000000': () => reply(200, detail({ id: 'fbm_lost000000' })),
      }),
    );
    await controller.start();
    await flush();
    controller.openMark('fbm_lost000000');
    expect(controller.getState()).toMatchObject({ card: null, panel: { markId: 'fbm_lost000000' } });
  });

  it('keeps the reply text for a retry when a comment fails', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(session()));
    const { controller } = build(
      okRoutes({
        'GET /marks': () => listOf(mark()),
        'GET /marks/fbm_aaaaaaaaaa': () => reply(200, detail()),
        'POST /marks/fbm_aaaaaaaaaa/comments': () => failure(500, 'boom'),
      }),
    );
    await controller.start();
    await flush();
    controller.openMark('fbm_aaaaaaaaaa', { scroll: false });
    await flush();
    expect(await controller.sendComment('fbm_aaaaaaaaaa', 'Thanks')).toBe(false);
    expect(controller.getState().threads.fbm_aaaaaaaaaa).toMatchObject({ sending: false, sendError: true });
  });

  it('steps back one thing at a time with escape', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(session()));
    const { controller } = build(okRoutes());
    await controller.start();
    await flush();
    controller.beginMode('area');
    controller.toggleMenu(true);
    expect(controller.escape()).toBe(true);
    expect(controller.getState().menuOpen).toBe(false);
    controller.openPanel();
    expect(controller.escape()).toBe(true);
    expect(controller.getState().panel).toBeNull();
    expect(controller.escape()).toBe(false);
  });
});

describe('hiding', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('remembers the hidden choice in the storage', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(session()));
    const { controller } = build(okRoutes());
    await controller.start();
    await flush();
    controller.toggleHidden();
    expect(controller.getState().hidden).toBe(true);
    expect(window.localStorage.getItem(`${KEY}:hidden`)).toBe('1');
  });
});
