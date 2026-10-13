// Screenshots of the feedback widget (PM-510) for the UI/UX review.
//
//   npm run build -w @projectman/feedback-widget
//   npm run shots -- apps/feedback-widget/shots/widget-states.mjs --widths 1512,390
//
// The disposable instance serves the app only. The scenario puts the sample page (dev/index.html) and the
// built widget on the instance's own address and answers the widget API itself (page.route), so every state
// can be shown without a second origin and without the real data.
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const here = new URL('.', import.meta.url);
const WIDGET_JS = readFileSync(new URL('../dist/widget.js', here), 'utf8');
const PAGE_HTML = readFileSync(new URL('../dev/index.html', here), 'utf8').replace(
  /<script type="module"[^>]*><\/script>/,
  '<script src="/feedback/widget.js" data-project="PM" defer></script>',
);
const DEMO_PATH = '/widget-demo';
const CODE = 'a'.repeat(43);
const API = '/feedback/api/v1';
const TOKEN = 'tok_demo';

const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const anna = { handle: 'anna', name: 'Kovács Anna', kind: 'human', color: 1 };
const bela = { handle: 'bela', name: 'Szabó Béla', kind: 'human', color: 3 };
const pm = { handle: 'pm', name: 'Projektmenedzser', kind: 'ai', color: null };

const base = {
  projectKey: 'PM',
  pageTitle: 'Minta Műhely',
  status: 'new',
  outcome: null,
  card: null,
  working: false,
  commentCount: 0,
  unread: false,
  hasScreenshot: false,
  closedAt: null,
};
const anchorOf = (fields) => ({
  selector: null,
  textSnippet: null,
  elementOffset: null,
  pagePoint: null,
  rect: null,
  ...fields,
});

export default async ({ instance, open, shoot: takeShots, step, log }) => {
  const app = await open({ path: '/' });
  // `shoot` leaves the viewport at the last width; the steps go on at the desktop width.
  const shoot = async (page, name, options) => {
    const paths = await takeShots(page, name, options);
    await page.setViewportSize({ width: 1512, height: 982 });
    await page.waitForTimeout(300);
    return paths;
  };
  const origin = new URL(app.url()).origin;
  const pageUrl = `${origin}${DEMO_PATH}`;
  const surface = { id: 'fbs_1', name: 'Minta Műhely', origin };

  const mark = (id, fields) => ({
    ...base,
    id,
    surface,
    pageUrl,
    pagePath: DEMO_PATH,
    createdAt: ago(300),
    updatedAt: ago(30),
    lastActivityAt: ago(30),
    ...fields,
  });

  const marks = [
    mark('fbm_cart000001', {
      author: bela,
      kind: 'element',
      body: 'A kosár gomb telefonon alig látszik, és nem is nyomható rendesen.',
      anchor: anchorOf({
        kind: 'element',
        selector: '#add-to-cart',
        textSnippet: 'Kosárba teszem',
        elementOffset: { x: 0.5, y: 0.5 },
        pagePoint: { x: 520, y: 330 },
      }),
      commentCount: 2,
      unread: true,
    }),
    mark('fbm_point000001', {
      author: anna,
      kind: 'point',
      body: 'Itt a szöveg túl közel van a képhez.',
      anchor: anchorOf({ kind: 'point', pagePoint: { x: 470, y: 230 } }),
      status: 'waiting_owner',
      commentCount: 1,
    }),
    mark('fbm_changed0001', {
      author: bela,
      kind: 'element',
      body: 'Ez a cím legyen kisebb.',
      anchor: anchorOf({
        kind: 'element',
        selector: '#hero-title',
        textSnippet: 'Egy régebbi cím',
        elementOffset: { x: 0.3, y: 0.5 },
        pagePoint: { x: 620, y: 150 },
      }),
    }),
    mark('fbm_lost0000001', {
      author: anna,
      kind: 'element',
      body: 'A régi banner szövege elírás.',
      anchor: anchorOf({
        kind: 'element',
        selector: '#banner-that-is-gone',
        textSnippet: 'Őszi vásár',
        elementOffset: { x: 0.5, y: 0.5 },
        // Below the end of the page: nothing is left to pin it to.
        pagePoint: { x: 300, y: 90000 },
      }),
      status: 'handled',
      outcome: 'answered',
      commentCount: 1,
    }),
    mark('fbm_whole000001', {
      author: bela,
      kind: 'page',
      body: 'Az oldal mobilon lassan tölt be.',
      anchor: anchorOf({ kind: 'page' }),
      working: true,
    }),
    mark('fbm_area0000001', {
      author: bela,
      kind: 'area',
      body: 'Ezeket a kártyákat egy sorba kellene tenni.',
      anchor: anchorOf({ kind: 'area', rect: { x: 40, y: 470, width: 700, height: 150 } }),
      status: 'handled',
      outcome: 'card_created',
      card: { visible: false },
    }),
  ];

  const comment = (id, actor, body, minutes) => ({
    id,
    type: 'comment',
    actor,
    body,
    card: null,
    createdAt: ago(minutes),
  });
  const threads = {
    fbm_cart000001: [
      comment('fbe_1', pm, 'Köszönöm, megnézem, mekkora a gomb telefonon. Melyik készüléken látod?', 200),
      comment('fbe_2', bela, 'iPhone SE-n, a 375 pixeles szélességnél.', 120),
    ],
    fbm_point000001: [comment('fbe_3', pm, 'Ezt a tulajdonosnak kell eldöntenie, továbbítottam.', 90)],
    fbm_lost0000001: [comment('fbe_4', pm, 'A banner már nincs az oldalon, ezért lezártam.', 60)],
    fbm_area0000001: [
      {
        id: 'fbe_5',
        type: 'card_created',
        actor: pm,
        body: null,
        card: { visible: false },
        createdAt: ago(45),
      },
    ],
  };
  const detailOf = (view) => ({
    ...view,
    thread: threads[view.id] ?? [],
    environment: null,
    screenshot: null,
    canProcess: false,
    canComment: true,
  });
  const sessionResponse = {
    token: TOKEN,
    expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    me: anna,
    project: { key: 'PM', name: 'projectman' },
    surface,
    markId: null,
    appUrl: `${origin}/p/PM/feedback`,
  };

  // What the pretend server answers; a step changes it before it triggers the widget.
  const server = { exchange: 'ok', list: 'ok', create: 'ok', visibleMarks: marks };
  const reply = (route, status, body, headers = {}) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      headers,
      body: body === undefined ? '' : JSON.stringify(body),
    });
  const failure = (route, status, code, headers) =>
    reply(route, status, { error: { code, message: code, details: null } }, headers);

  await app.route(
    (url) => url.pathname === DEMO_PATH,
    (route) => route.fulfill({ status: 200, contentType: 'text/html', body: PAGE_HTML }),
  );
  await app.route(
    (url) => url.pathname === '/feedback/widget.js',
    (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: WIDGET_JS }),
  );
  // Requests that never answer, so that a state that waits (the picture, the start) can be shot.
  const hung = [];
  const release = async () => {
    await Promise.all(hung.splice(0).map((route) => route.abort().catch(() => undefined)));
  };
  await app.route(
    (url) => url.pathname === '/feedback/hang.svg',
    (route) => {
      hung.push(route);
    },
  );
  await app.route(
    (url) => url.pathname.startsWith(`${API}/`),
    async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname.slice(API.length);
      const method = request.method();
      if (path === '/sessions' && method === 'POST') {
        if (server.exchange === 'down') return route.abort('failed');
        if (server.exchange === 'hang') {
          hung.push(route);
          return undefined;
        }
        if (server.exchange === 'bad') return failure(route, 401, 'feedback_code_invalid');
        return reply(route, 201, sessionResponse);
      }
      if (path === '/sessions/current') return reply(route, 204);
      if (path === '/marks' && method === 'GET') {
        if (server.list === 'down') return route.abort('failed');
        if (server.list === 'expired') return failure(route, 401, 'feedback_session_invalid');
        return reply(route, 200, {
          marks: server.visibleMarks,
          markers: [anna, bela],
          cursor: 'c1',
          me: anna,
        });
      }
      if (path === '/marks' && method === 'POST') {
        if (server.create === 'rate')
          return failure(route, 429, 'feedback_rate_limited', { 'retry-after': '90' });
        if (server.create === 'error') return failure(route, 500, 'internal');
        const sent = request.postDataJSON();
        const created = mark('fbm_new00000001', {
          author: anna,
          kind: sent.kind,
          body: sent.body,
          anchor: sent.anchor,
          createdAt: ago(0),
        });
        return reply(route, 201, detailOf(created));
      }
      const detail = /^\/marks\/(fbm_[a-z0-9]+)$/.exec(path);
      if (detail && method === 'GET') {
        const view = marks.find((m) => m.id === detail[1]);
        return view ? reply(route, 200, detailOf(view)) : failure(route, 404, 'not_found');
      }
      if (/\/read$/.test(path)) return reply(route, 204);
      return failure(route, 404, 'not_found');
    },
  );
  // The picture is made from an SVG image; these switches let a step make it slow or fail.
  await app.addInitScript(() => {
    const toDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      if (window.__shotFails) throw new Error('canvas blocked');
      return toDataURL.apply(this, args);
    };
    const srcSetter = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      ...srcSetter,
      set(value) {
        // A request that never answers keeps the picture really pending (a missing src would end it at once).
        const slow = window.__shotSlow && String(value).startsWith('data:image/svg');
        srcSetter.set.call(this, slow ? `${location.origin}/feedback/hang.svg?${Math.random()}` : value);
      },
    });
  });

  // --- helpers
  const widgetReady = (page) => page.waitForSelector('[role="toolbar"]:not([aria-busy])', { timeout: 15000 });
  const settle = (page, ms = 400) => page.waitForTimeout(ms);
  const clearBrowser = async (page) => {
    await page.evaluate(() => {
      window.localStorage.clear();
      window.sessionStorage.clear();
    });
  };
  const boot = async (page, { code = true, ready = true } = {}) => {
    // A goto that only changes the hash would not reload the page, so leave it first.
    await page.goto('about:blank');
    await page.goto(`${pageUrl}${code ? `#pm-feedback=${CODE}` : ''}`);
    if (ready) await widgetReady(page);
    await settle(page);
  };
  const refresh = async (page) => {
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await settle(page, 600);
  };
  const press = (page, text) => page.locator(`button:has-text("${text}")`).first().click();
  const startMark = async (page, mode, at) => {
    await page.locator('.l-main').click();
    await page.locator('.mode', { hasText: mode }).click();
    if (at) await page.mouse.click(at.x, at.y);
    await page.waitForSelector('[role="dialog"]');
  };
  const cancelCard = async (page) => {
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await settle(page, 200);
  };
  const normal = () => {
    server.exchange = 'ok';
    server.list = 'ok';
    server.create = 'ok';
  };

  // --- the first start
  await step('welcome on the first start', async () => {
    await boot(app, { ready: false });
    await app.waitForSelector('[role="dialog"]');
    await settle(app);
    await shoot(app, 'widget-welcome', { widths: [1512, 390] });
    await press(app, 'Kezdjük');
    await widgetReady(app);
    await settle(app);
  });

  await step('launcher and the three targeting modes', async () => {
    await shoot(app, 'widget-launcher', { widths: [1512, 390] });
    await app.locator('.l-main').click();
    await app.mouse.move(520, 330);
    await settle(app);
    await shoot(app, 'widget-mode-element', { widths: [1512, 390] });
    await app.locator('.mode', { hasText: 'Pont' }).click();
    await app.mouse.move(600, 420);
    await settle(app);
    await shoot(app, 'widget-mode-point', { widths: [1512, 390] });
    await app.locator('.mode', { hasText: 'Terület' }).click();
    await app.mouse.move(100, 500);
    await app.mouse.down();
    await app.mouse.move(380, 640, { steps: 6 });
    await settle(app);
    await shoot(app, 'widget-mode-area', { widths: [1512, 390] });
    await app.mouse.up();
    await app.waitForSelector('[role="dialog"]');
    await cancelCard(app);
  });
  await step('new mark card: picture, waiting, none, errors', async () => {
    // x stays inside 390 px: the same page point has to be on the screen at the phone width too.
    await startMark(app, 'Pont', { x: 300, y: 420 });
    await app.locator('textarea').fill('Ez a rész lemarad a képernyő szélén.');
    await app
      .waitForSelector('[role="dialog"] img', { timeout: 15000 })
      .catch(() => log('no preview image appeared'));
    await settle(app);
    await shoot(app, 'widget-new-with-image', { widths: [1512, 390] });
    await app
      .locator('[role="dialog"] [role="switch"], [role="dialog"] input[type="checkbox"]')
      .first()
      .click();
    await settle(app, 200);
    await shoot(app, 'widget-new-no-image', { widths: [1512, 390] });
    await cancelCard(app);

    await app.evaluate(() => {
      window.__shotSlow = true;
    });
    await startMark(app, 'Pont', { x: 300, y: 420 });
    await app.locator('textarea').fill('Ez a rész lemarad a képernyő szélén.');
    await settle(app);
    await shoot(app, 'widget-new-image-wait', { widths: [1512, 390] });
    await cancelCard(app);
    await release();
    await app.evaluate(() => {
      window.__shotSlow = false;
      window.__shotFails = true;
    });
    await startMark(app, 'Pont', { x: 300, y: 420 });
    await app.locator('textarea').fill('Ez a rész lemarad a képernyő szélén.');
    await settle(app, 1500);
    await shoot(app, 'widget-new-image-failed', { widths: [1512, 390] });
    server.create = 'error';
    await press(app, 'Küldés');
    await settle(app, 600);
    await shoot(app, 'widget-new-send-error', { widths: [1512, 390] });
    server.create = 'rate';
    await press(app, 'Újra');
    await settle(app, 600);
    await shoot(app, 'widget-new-rate-limited', { widths: [1512, 390] });
    await app.locator('textarea').fill('x'.repeat(3850));
    await settle(app, 300);
    await shoot(app, 'widget-new-long-text', { widths: [1512, 390] });
    await cancelCard(app);
    await app.evaluate(() => {
      window.__shotFails = false;
    });
    normal();
  });

  await step('threads', async () => {
    await refresh(app);
    await app.locator('.pin[aria-label*="kosár gomb"]').click();
    await app.waitForSelector('[role="dialog"]');
    await settle(app);
    await shoot(app, 'widget-thread-reply', { widths: [1512, 390] });
    await cancelCard(app);
    await app.locator('.pin[aria-label*="túl közel"]').click();
    await app.waitForSelector('[role="dialog"]');
    await settle(app);
    await shoot(app, 'widget-thread-owner-decides', { widths: [1512, 390] });
    await cancelCard(app);
    await app.locator('.pin[aria-label*="cím legyen kisebb"]').click();
    await app.waitForSelector('[role="dialog"]');
    await settle(app);
    await shoot(app, 'widget-thread-changed', { widths: [1512, 390] });
    await cancelCard(app);
    await app.locator('.pin[aria-label*="egy sorba"]').click();
    await app.waitForSelector('[role="dialog"]');
    await settle(app);
    await shoot(app, 'widget-thread-internal-card', { widths: [1512, 390] });
    await cancelCard(app);
  });

  await step('list panel', async () => {
    await app.locator('.l-list').click();
    await app.waitForSelector('[role="dialog"]');
    await settle(app);
    await shoot(app, 'widget-panel', { widths: [1512, 390] });
    await app.locator('[role="dialog"] >> text=A régi banner szövege elírás.').first().click();
    await settle(app, 600);
    await shoot(app, 'widget-panel-thread', { widths: [1512, 390] });
    await cancelCard(app);
    await cancelCard(app);
  });

  await step('menu and states of the start', async () => {
    await app.locator('.l-more').click();
    await settle(app);
    await shoot(app, 'widget-menu', { widths: [1512, 390] });
    await cancelCard(app);

    // No connection: two failed refreshes in a row.
    server.list = 'down';
    await refresh(app);
    await refresh(app);
    await app.locator('.l-more').click();
    await settle(app);
    await shoot(app, 'widget-offline-menu', { widths: [1512, 390] });
    await cancelCard(app);

    // Expired session.
    server.list = 'expired';
    await refresh(app);
    await settle(app);
    await shoot(app, 'widget-expired', { widths: [1512, 390] });
    normal();

    // Invalid code and no stored session.
    await clearBrowser(app);
    server.exchange = 'bad';
    await boot(app, { ready: false });
    await settle(app, 800);
    await shoot(app, 'widget-bad-code', { widths: [1512, 390] });

    // Start error.
    await clearBrowser(app);
    server.exchange = 'down';
    await boot(app, { ready: false });
    await settle(app, 800);
    await shoot(app, 'widget-start-error', { widths: [1512, 390] });

    // Turning on: the code exchange has not answered yet.
    await clearBrowser(app);
    server.exchange = 'hang';
    await boot(app, { ready: false });
    await settle(app, 800);
    // The runner's shoot waits up to 10 s for the network to go idle, which is as long as the widget
    // waits for the exchange: it would show the timeout error. Take these two images directly.
    const outDir = join(process.env.PROJECTMAN_SESSION_DIR ?? tmpdir(), 'shots', 'widget-states');
    await mkdir(outDir, { recursive: true });
    for (const [width, height] of [
      [1512, 982],
      [390, 844],
    ]) {
      await app.setViewportSize({ width, height });
      await app.waitForTimeout(500);
      await app.screenshot({ path: join(outDir, `widget-activating-${width}.png`), animations: 'disabled' });
    }
    await app.setViewportSize({ width: 1512, height: 982 });
    await release();
    normal();
  });
};
