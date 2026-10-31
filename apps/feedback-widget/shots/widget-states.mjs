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
const pageHtml = (lang) =>
  readFileSync(new URL('../dev/index.html', here), 'utf8')
    .replace(
      /<script type="module"[^>]*><\/script>/,
      '<script src="/feedback/widget.js" data-project="PM" defer></script>',
    )
    .replace('<html lang="hu">', `<html lang="${lang}">`);
// The words the scenario presses, in the widget's language (PM-1184: `widget-states-en.mjs` runs it in English).
const UI = {
  hu: { start: 'Kezdjük', retry: 'Újra', send: 'Küldés', point: 'Pont', area: 'Terület' },
  en: { start: 'Let’s start', retry: 'Try again', send: 'Send', point: 'Point', area: 'Area' },
};
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
  canDelete: false,
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

export async function run({ instance, open, shoot: takeShots, step, log }, lang) {
  const ui = UI[lang];
  const PAGE_HTML = pageHtml(lang);
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
    // An area pinned to its element (PM-917): it follows the element at every window width.
    mark('fbm_pinned00001', {
      author: anna,
      kind: 'area',
      body: 'Ez a cím eleje legyen kiemelve.',
      anchor: anchorOf({
        kind: 'area',
        selector: '#hero-title',
        textSnippet: 'Kézzel készült',
        elementOffset: { x: 0.05, y: 0.1 },
        elementRect: { x: 0.05, y: 0.1, width: 0.45, height: 0.8 },
        pagePoint: { x: 610, y: 140 },
        rect: { x: 560, y: 120, width: 200, height: 50 },
      }),
    }),
    mark('fbm_whole000001', {
      author: bela,
      kind: 'page',
      body: 'Az oldal mobilon lassan tölt be.',
      anchor: anchorOf({ kind: 'page' }),
      working: true,
      lastActivityAt: ago(1),
    }),
    // A closed mark, weeks old (PM-1184): the thread shows events, a closing line and an older date.
    mark('fbm_closed00001', {
      author: anna,
      kind: 'point',
      body: 'Az ár formátuma hibás.',
      anchor: anchorOf({ kind: 'point', pagePoint: { x: 430, y: 380 } }),
      status: 'closed',
      outcome: 'answered',
      createdAt: ago(60 * 24 * 20),
      lastActivityAt: ago(60 * 24 * 18),
      closedAt: ago(60 * 24 * 18),
      commentCount: 1,
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

  // The viewer's own mark with a card (PM-1189): shown only by the delete step, so the other shots stay as they are.
  const deletable = mark('fbm_delete00001', {
    author: anna,
    kind: 'point',
    body: 'A szállítási díj nem látszik a kosárban.',
    anchor: anchorOf({ kind: 'point', pagePoint: { x: 480, y: 300 } }),
    status: 'handled',
    outcome: 'card_created',
    card: { visible: true, key: 'PM-512', title: 'Szállítási díj a kosárban', stageName: 'Fejlesztés' },
    canDelete: true,
  });

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
    fbm_closed00001: [
      comment('fbe_6', pm, 'Köszönöm, ez a javítás már bekerült.', 60 * 24 * 19),
      { id: 'fbe_7', type: 'forwarded', actor: pm, body: null, card: null, createdAt: ago(60 * 24 * 19 - 5) },
      { id: 'fbe_8', type: 'closed', actor: pm, body: null, card: null, createdAt: ago(60 * 24 * 18) },
    ],
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
  const server = { exchange: 'ok', list: 'ok', create: 'ok', remove: 'ok', visibleMarks: marks };
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
        const view = server.visibleMarks.find((m) => m.id === detail[1]);
        return view ? reply(route, 200, detailOf(view)) : failure(route, 404, 'not_found');
      }
      if (detail && method === 'DELETE') {
        if (server.remove === 'error') return failure(route, 500, 'internal');
        server.visibleMarks = server.visibleMarks.filter((m) => m.id !== detail[1]);
        return reply(route, 204);
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

  // The browser's screen sharing (PM-921) is faked: a canvas stream stands for the shared tab, so that no
  // permission prompt is needed. `__share` is 'tab' (the page itself), 'window', 'deny' or 'hold' (the
  // permission question stays open until `__holdDeny()`); the storage flag `__noShare` removes the API.
  await app.addInitScript(() => {
    window.__share = 'tab';
    window.__shareCalls = 0;
    if (!navigator.mediaDevices) return;
    try {
      if (window.localStorage.getItem('__noShare')) {
        navigator.mediaDevices.getDisplayMedia = undefined;
        return;
      }
    } catch {
      // storage is closed: the share stays available
    }
    navigator.mediaDevices.getDisplayMedia = async () => {
      window.__shareCalls += 1;
      if (window.__share === 'hold') {
        return new Promise((_, reject) => {
          window.__holdDeny = () => reject(new DOMException('denied', 'NotAllowedError'));
        });
      }
      if (window.__share === 'deny') throw new DOMException('denied', 'NotAllowedError');
      const canvas = document.createElement('canvas');
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      const context = canvas.getContext('2d');
      context.fillStyle = '#eef2f7';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#334155';
      context.font = '28px sans-serif';
      context.fillText('Megosztott kép (próba)', 40, 80);
      // A still canvas gives no new frame; redrawing keeps the stream alive, as a real page does.
      let frame = 0;
      setInterval(() => {
        context.fillStyle = '#eef2f7';
        context.fillRect(0, 100, 300, 40);
        context.fillStyle = '#334155';
        context.fillText(String(frame++), 40, 130);
      }, 100);
      const stream = canvas.captureStream(5);
      const track = stream.getVideoTracks()[0];
      const surface = window.__share === 'window' ? 'window' : 'browser';
      const settings = track.getSettings.bind(track);
      track.getSettings = () => ({ ...settings(), displaySurface: surface });
      return stream;
    };
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
    await press(app, ui.start);
    await widgetReady(app);
    await settle(app);
  });

  await step('launcher and the three targeting modes', async () => {
    await shoot(app, 'widget-launcher', { widths: [1512, 390] });
    await app.locator('.l-main').click();
    await app.mouse.move(520, 330);
    await settle(app);
    await shoot(app, 'widget-mode-element', { widths: [1512, 390] });
    await app.locator('.mode', { hasText: ui.point }).click();
    await app.mouse.move(600, 420);
    await settle(app);
    await shoot(app, 'widget-mode-point', { widths: [1512, 390] });
    await app.locator('.mode', { hasText: ui.area }).click();
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
    await startMark(app, ui.point, { x: 300, y: 420 });
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
    await startMark(app, ui.point, { x: 300, y: 420 });
    await app.locator('textarea').fill('Ez a rész lemarad a képernyő szélén.');
    await settle(app);
    await shoot(app, 'widget-new-image-wait', { widths: [1512, 390] });
    await cancelCard(app);
    await release();
    await app.evaluate(() => {
      window.__shotSlow = false;
      window.__shotFails = true;
    });
    await startMark(app, ui.point, { x: 300, y: 420 });
    await app.locator('textarea').fill('Ez a rész lemarad a képernyő szélén.');
    await settle(app, 1500);
    await shoot(app, 'widget-new-image-failed', { widths: [1512, 390] });
    server.create = 'error';
    await press(app, ui.send);
    await settle(app, 600);
    await shoot(app, 'widget-new-send-error', { widths: [1512, 390] });
    server.create = 'rate';
    await press(app, ui.retry);
    await settle(app, 600);
    await shoot(app, 'widget-new-rate-limited', { widths: [1512, 390] });
    await app.locator('textarea').fill('x'.repeat(3850));
    await settle(app, 300);
    await shoot(app, 'widget-new-long-text', { widths: [1512, 390] });
    // Over the limit by one character and by many (the singular and the plural of the counter).
    await app.locator('textarea').fill('x'.repeat(3999));
    await settle(app, 300);
    await shoot(app, 'widget-new-left-1', { widths: [1512, 390] });
    await app.locator('textarea').fill('x'.repeat(4001));
    await settle(app, 300);
    await shoot(app, 'widget-new-over-1', { widths: [1512, 390] });
    await app.locator('textarea').fill('x'.repeat(4120));
    await settle(app, 300);
    await shoot(app, 'widget-new-over-many', { widths: [1512, 390] });
    await cancelCard(app);
    await app.evaluate(() => {
      window.__shotFails = false;
    });
    normal();
  });

  await step('browser picture: offer, share, denied (PM-921)', async () => {
    const say = async (name) => {
      await settle(app, 500);
      await shoot(app, name, { widths: [1512, 390] });
    };
    const text = () => app.locator('textarea').fill('A kép nem mutatja, amit látok.');

    // The automatic picture failed: the browser picture is the main button; its question stays open.
    await app.evaluate(() => {
      window.__shotFails = true;
      window.__share = 'hold';
    });
    await startMark(app, ui.point, { x: 300, y: 420 });
    await text();
    await settle(app, 1500);
    await shoot(app, 'widget-browser-offer-failed', { widths: [1512, 390] });
    await app.locator('.shot-offer .btn').click();
    await settle(app, 300);
    await shoot(app, 'widget-browser-asking', { widths: [1512, 390] });
    await app.evaluate(() => window.__holdDeny?.());
    await settle(app, 300);
    await shoot(app, 'widget-browser-denied-none', { widths: [1512, 390] });
    // The picture of the browser has to be able to succeed: the canvas switch is off for it.
    await app.evaluate(() => {
      window.__share = 'tab';
      window.__shotFails = false;
    });
    await app.locator('.shot-offer .btn').click();
    await app.waitForSelector('.preview img', { timeout: 15000 }).catch(() => log('no browser picture'));
    await say('widget-browser-picture');
    await shoot(app, 'widget-launcher-sharing', { widths: [1512, 390] });
    await cancelCard(app);

    // The share stays open: the next mark takes its picture from it without asking.
    await startMark(app, ui.point, { x: 300, y: 420 });
    await text();
    await app.waitForSelector('.preview img', { timeout: 15000 }).catch(() => log('no shared picture'));
    await say('widget-browser-picture-next');
    await app.locator('.l-share').click();
    await settle(app, 400);
    await shoot(app, 'widget-share-stopped', { widths: [1512, 390] });
    await cancelCard(app);

    // A shared window cannot show the marked place: the picture says so and offers another try.
    await app.evaluate(() => {
      window.__shotFails = false;
      window.__share = 'window';
    });
    await startMark(app, ui.point, { x: 300, y: 420 });
    await text();
    await app.waitForSelector('.preview img', { timeout: 15000 }).catch(() => log('no preview'));
    await app.locator('.shot-offer .link').click();
    await app.waitForSelector('.preview img', { timeout: 15000 }).catch(() => log('no window picture'));
    await say('widget-browser-picture-window');
    await app.locator('.l-share').click();
    await cancelCard(app);

    // The question on a ready picture, then denied: the automatic picture stays, with a plain line.
    await app.evaluate(() => {
      window.__share = 'hold';
    });
    await startMark(app, ui.point, { x: 300, y: 420 });
    await text();
    await app.waitForSelector('.preview img', { timeout: 15000 }).catch(() => log('no preview'));
    await app.locator('.shot-offer .link').click();
    await settle(app, 300);
    await shoot(app, 'widget-browser-asking-ready', { widths: [1512, 390] });
    await app.evaluate(() => window.__holdDeny?.());
    await say('widget-browser-denied-auto');
    await cancelCard(app);
    await app.evaluate(() => {
      window.__share = 'tab';
    });
  });

  await step("a browser that cannot share keeps today's card (PM-921)", async () => {
    await app.evaluate(() => window.localStorage.setItem('__noShare', '1'));
    await boot(app);
    await app
      .locator(`button:has-text("${ui.start}")`)
      .click({ timeout: 3000 })
      .catch(() => log('no welcome'));
    await app.evaluate(() => {
      window.__shotFails = true;
    });
    await startMark(app, ui.point, { x: 300, y: 420 });
    await app.locator('textarea').fill('A kép nem mutatja, amit látok.');
    await settle(app, 1500);
    await shoot(app, 'widget-browser-unsupported', { widths: [1512, 390] });
    await cancelCard(app);
    await app.evaluate(() => {
      window.__shotFails = false;
      window.localStorage.removeItem('__noShare');
    });
    await boot(app);
  });

  await step('area pinned to its element at two window widths (PM-917)', async () => {
    await refresh(app);
    await app.locator('.pin[aria-label*="cím eleje"]').click();
    await app.waitForSelector('[role="dialog"]');
    await settle(app);
    await shoot(app, 'widget-pinned-area', { widths: [1512, 390] });
    await cancelCard(app);
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

  // Deleting one's own mark (PM-1189): the button, the confirmation, the error with a retry, the notice.
  await step('deleting a mark', async () => {
    server.visibleMarks = [...marks, deletable];
    await refresh(app);
    await app.locator('.pin[aria-label*="szállítási díj"]').click();
    await app.waitForSelector('[role="dialog"]');
    await settle(app);
    await shoot(app, 'widget-delete-button', { widths: [1512, 390] });
    await app.locator('[role="dialog"] .link.danger').click();
    await settle(app, 500);
    await shoot(app, 'widget-delete-confirm', { widths: [1512, 390] });
    server.remove = 'error';
    await app.locator('[role="group"] .btn.danger').click();
    await app.waitForSelector('[role="group"] [role="alert"]');
    await settle(app, 300);
    await shoot(app, 'widget-delete-error', { widths: [1512, 390] });
    server.remove = 'ok';
    await app.locator('[role="group"] .btn.danger').click();
    await app.waitForSelector('[role="dialog"]', { state: 'detached' });
    await settle(app, 400);
    await shoot(app, 'widget-delete-done', { widths: [1512, 390] });
    server.visibleMarks = marks;
    await refresh(app);
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

    // A closed thread, with events and an older date (PM-1184).
    await app.locator('.l-list').click();
    await app.waitForSelector('[role="dialog"]');
    await app.locator('[role="dialog"] >> text=Az ár formátuma hibás.').first().click();
    await settle(app, 600);
    await shoot(app, 'widget-thread-closed', { widths: [1512, 390] });
    await cancelCard(app);
    await cancelCard(app);

    // The list with no marks, on both tabs.
    // A refresh keeps the marks it already has, so the widget starts again from an empty browser.
    server.visibleMarks = [];
    await clearBrowser(app);
    await boot(app, { ready: false });
    await app.locator(`button:has-text("${ui.start}")`).click({ timeout: 5000 });
    await widgetReady(app);
    await settle(app);
    await app.locator('.l-list').click();
    await app.waitForSelector('[role="dialog"]');
    await settle(app);
    await shoot(app, 'widget-panel-empty', { widths: [1512, 390] });
    await app.locator('[role="tab"]').nth(1).click();
    await settle(app, 300);
    await shoot(app, 'widget-panel-empty-all', { widths: [1512, 390] });
    await cancelCard(app);
    await cancelCard(app);
    server.visibleMarks = marks;
    await refresh(app);
    log(
      `root lang: ${await app.evaluate(() => document.querySelector('[data-pm-feedback-host]')?.shadowRoot?.querySelector('.w')?.getAttribute('lang'))}`,
    );
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
    const outDir = join(
      process.env.PROJECTMAN_SESSION_DIR ?? tmpdir(),
      'shots',
      lang === 'hu' ? 'widget-states' : `widget-states-${lang}`,
    );
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
}

export default (context) => run(context, 'hu');
