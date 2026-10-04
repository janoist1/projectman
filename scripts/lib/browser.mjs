/**
 * The browser side of `npm run shots` (PM-270): where the browser and the images live, the fence
 * that keeps the browser on the disposable instance, the scenario API (`open`, `shoot`, `snapshot`,
 * `step`, `log`) and the argument parsing. `scripts/shots.mjs` runs it, `scripts/browsers.mjs`
 * installs the browser.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));

export const DEFAULT_WIDTHS = [1512, 800, 390, 375];
const HEIGHTS = new Map([
  [1512, 982],
  [800, 900],
  [390, 844],
  [375, 667],
]);
const DEFAULT_HEIGHT = 900;
const MIN_WIDTH = 200;
const MAX_WIDTH = 4000;
const DEFAULT_TIMEOUT_S = 240;
const HIGHLIGHT_ATTRIBUTE = 'data-shots-highlight';
const HIGHLIGHT_CSS = `[${HIGHLIGHT_ATTRIBUTE}] { outline: 3px solid #ff2d55 !important; outline-offset: -3px !important; }`;
const SHOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const BROWSER_NAME = 'chromium-headless-shell';

/** A wrong command line or a missing browser: the exit code is 2. */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/** The viewport of a screenshot width: the height is fixed per known width. */
export function viewportFor(width) {
  return { width, height: HEIGHTS.get(width) ?? DEFAULT_HEIGHT };
}

// ---- Where things are ----

/**
 * The browsers folder: `$PROJECTMAN_BROWSERS_PATH`, else `$PLAYWRIGHT_BROWSERS_PATH` (what the server
 * gives a member's session, PM-268), else `~/.projectman/browsers`.
 */
export function browsersPath(env = process.env, home = homedir()) {
  return resolve(
    env.PROJECTMAN_BROWSERS_PATH || env.PLAYWRIGHT_BROWSERS_PATH || join(home, '.projectman', 'browsers'),
  );
}

/** What Playwright expects to find, and whether the folder holds it (its completed-install marker). */
export function browserStatus(env = process.env, home = homedir()) {
  let browsers;
  try {
    ({ browsers } = JSON.parse(
      readFileSync(join(repo, 'node_modules/playwright-core/browsers.json'), 'utf8'),
    ));
  } catch {
    throw new UsageError('The playwright-core package is missing from node_modules: run npm install.');
  }
  const entry = browsers.find((browser) => browser.name === BROWSER_NAME);
  const path = browsersPath(env, home);
  const directory = join(path, `${BROWSER_NAME.replace(/-/g, '_')}-${entry.revision}`);
  return {
    path,
    revision: entry.revision,
    version: entry.browserVersion,
    installed: existsSync(join(directory, 'INSTALLATION_COMPLETE')),
  };
}

export const INSTALL_HINT = 'Install it, outside the sandbox, with: npm run browsers -- install';

/** Where the images go: `--out`, else `$PROJECTMAN_SESSION_DIR/shots/<name>`, else a temporary folder. */
export function outputDirectory({ out, scenario, env = process.env, tmp = tmpdir() }) {
  if (out) return resolve(out);
  const name = basename(scenario, extname(scenario));
  return env.PROJECTMAN_SESSION_DIR
    ? join(resolve(env.PROJECTMAN_SESSION_DIR), 'shots', name)
    : join(tmp, 'projectman-shots', name);
}

// ---- The fence ----

const SCHEME_GROUP = { 'http:': 'http', 'ws:': 'http', 'https:': 'https', 'wss:': 'https' };

/**
 * May the browser load this URL? Only the instance's web and server, `data:` and `blob:`. Everything
 * else is refused, `file:` and the live instance's 127.0.0.1:4800 included. On the Mac this guards
 * against an accident; it is not a security boundary.
 */
export function isAllowedUrl(raw, { webUrl, serverUrl }) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === 'data:' || url.protocol === 'blob:') return true;
  const group = SCHEME_GROUP[url.protocol];
  if (!group) return false;
  return [webUrl, serverUrl].some((allowed) => {
    if (!allowed) return false;
    const base = new URL(allowed);
    return SCHEME_GROUP[base.protocol] === group && base.host === url.host;
  });
}

// ---- Arguments ----

export const USAGE =
  'Usage: npm run shots -- <scenario.mjs> [--out <dir>] [--widths 1512,800,390,375] [--full-page]\n' +
  '       [--scale 1|2] [--timeout <seconds>] [--seed demo|none] [--keep-data]';

function integer(value, name, min, max) {
  if (!/^\d+$/.test(value ?? '')) throw new UsageError(`${name} needs a whole number.\n${USAGE}`);
  const number = Number(value);
  if (number < min || number > max) throw new UsageError(`${name} must be from ${min} to ${max}.`);
  return number;
}

export function parseWidths(text) {
  const widths = (text ?? '')
    .split(',')
    .map((part) => integer(part.trim(), '--widths', MIN_WIDTH, MAX_WIDTH));
  return [...new Set(widths)];
}

export function parseArgs(argv) {
  const options = {
    scenario: undefined,
    out: undefined,
    widths: DEFAULT_WIDTHS,
    fullPage: false,
    scale: 1,
    timeoutSeconds: DEFAULT_TIMEOUT_S,
    seed: 'demo',
    keepData: false,
  };
  const args = [...argv];
  const value = (flag) => {
    const next = args.shift();
    if (next === undefined || next.startsWith('--')) throw new UsageError(`${flag} needs a value.\n${USAGE}`);
    return next;
  };
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--out') options.out = value(arg);
    else if (arg === '--widths') options.widths = parseWidths(value(arg));
    else if (arg === '--full-page') options.fullPage = true;
    else if (arg === '--scale') {
      options.scale = integer(value(arg), '--scale', 1, 2);
    } else if (arg === '--timeout') options.timeoutSeconds = integer(value(arg), '--timeout', 1, 3600);
    else if (arg === '--seed') {
      options.seed = value(arg);
      if (options.seed !== 'demo' && options.seed !== 'none')
        throw new UsageError(`--seed is demo or none, not ${options.seed}.`);
    } else if (arg === '--keep-data') options.keepData = true;
    else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}.\n${USAGE}`);
    else if (options.scenario === undefined) options.scenario = arg;
    else throw new UsageError(`Only one scenario is run, not ${options.scenario} and ${arg}.\n${USAGE}`);
  }
  if (options.scenario === undefined) throw new UsageError(`Name the scenario file.\n${USAGE}`);
  return options;
}

// ---- The browser ----

/**
 * Starts Chromium (the headless shell). `--single-process --no-zygote` and no Chromium sandbox: a
 * member's own Seatbelt sandbox refuses the Mach ports the normal mode needs (PM-270).
 */
export async function launchBrowser(env = process.env) {
  const status = browserStatus(env);
  if (!status.installed)
    throw new UsageError(
      `The ${BROWSER_NAME} browser (revision ${status.revision}) is not in ${status.path}.\n${INSTALL_HINT}`,
    );
  // Playwright reads the folder when it loads, so this comes before the import.
  process.env.PLAYWRIGHT_BROWSERS_PATH = status.path;
  const { chromium } = await import('playwright-core');
  return chromium.launch({
    headless: true,
    chromiumSandbox: false,
    // The script handles the signals (scripts/shots.mjs): Playwright's own handlers would close the
    // browser and exit with the signal's code before the cleanup runs.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    args: ['--single-process', '--no-zygote', '--no-proxy-server'],
  });
}

function pngSize(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * The scenario's API. `instance` is the running disposable instance, `browser` the started browser,
 * `out` the (existing or creatable) folder of the images.
 */
export function createScenarioApi({
  browser,
  instance,
  out,
  widths: defaultWidths = DEFAULT_WIDTHS,
  fullPage: defaultFullPage = false,
  scale = 1,
  print = (line) => console.log(line),
}) {
  const fence = { webUrl: instance.webUrl, serverUrl: instance.serverUrl };
  const blocked = new Set();
  const pages = new Set(); // every page and popup, in the order they opened
  let stepNumber = 0;

  const refuse = (url) => {
    if (blocked.has(url)) return;
    blocked.add(url);
    print(`blocked ${url}`);
  };

  async function fenceContext(context) {
    await context.route(/.*/, async (route) => {
      const url = route.request().url();
      if (isAllowedUrl(url, fence)) {
        await route.continue().catch(() => {});
      } else {
        refuse(url);
        await route.abort('blockedbyclient').catch(() => {});
      }
    });
    await context.routeWebSocket(/.*/, (socket) => {
      const url = socket.url();
      if (isAllowedUrl(url, fence)) socket.connectToServer();
      else {
        refuse(url);
        void socket.close();
      }
    });
  }

  /**
   * The one browser context of the run. The single-process Chromium crashes (SIGTRAP) when a second
   * context is created, so there is only one: another account is a new login in the same context.
   */
  let shared; // { context, email }

  async function closePages() {
    for (const opened of pages) if (!opened.isClosed()) await opened.close().catch(() => {});
  }

  async function contextFor(account, width) {
    if (!shared) {
      const context = await browser.newContext({
        locale: 'hu-HU',
        timezoneId: 'Europe/Budapest',
        serviceWorkers: 'block',
        acceptDownloads: false,
        storageState: await instance.storageState(account),
        viewport: viewportFor(width),
        deviceScaleFactor: scale,
      });
      await fenceContext(context);
      context.on('page', (opened) => pages.add(opened));
      shared = { context, email: account.email };
      return context;
    }
    if (shared.email !== account.email) {
      const { context } = shared;
      await closePages();
      await context.clearCookies();
      // What the previous account left in the browser's storage must not reach the next one.
      const blank = await context.newPage();
      await blank.goto(new URL('/', instance.webUrl).href);
      await blank.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
      });
      await blank.close();
      await context.addCookies((await instance.storageState(account)).cookies);
      shared.email = account.email;
    }
    return shared.context;
  }

  /**
   * A page opened on the web instance, logged in as `as` (the owner by default). Pages of the same
   * account live side by side; another account closes every open page first (one context only).
   */
  async function open({ as, path = '/', width = DEFAULT_WIDTHS[0] } = {}) {
    if (typeof path !== 'string' || !path.startsWith('/'))
      throw new Error(`open: path starts with "/", not ${path}.`);
    const target = new URL(path, instance.webUrl);
    if (target.origin !== new URL(instance.webUrl).origin)
      throw new Error(`open: ${path} leaves the instance.`);
    const context = await contextFor(as ?? instance.owner, width);
    const page = await context.newPage();
    await page.setViewportSize(viewportFor(width));
    await page.goto(target.href);
    return page;
  }

  async function settle(page) {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    // Two frames, so that a resize has laid the page out again.
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
  }

  async function shoot(
    page,
    name,
    { widths = defaultWidths, fullPage = defaultFullPage, highlight, mask = [] } = {},
  ) {
    if (typeof name !== 'string' || !SHOT_NAME.test(name))
      throw new Error(`shoot: invalid name ${JSON.stringify(name)}.`);
    mkdirSync(out, { recursive: true });
    const written = [];
    for (const width of widths) {
      await page.setViewportSize(viewportFor(width));
      await settle(page);
      if (highlight) {
        const element = page.locator(highlight).first();
        await element.evaluate((node, attribute) => node.setAttribute(attribute, ''), HIGHLIGHT_ATTRIBUTE);
        await page.addStyleTag({ content: HIGHLIGHT_CSS });
        // What is highlighted is what the image is about: scroll it into view (a drawer scrolls too).
        await element.scrollIntoViewIfNeeded();
      }
      try {
        const file = join(out, `${name}-${width}.png`);
        const buffer = await page.screenshot({
          path: file,
          fullPage,
          animations: 'disabled',
          caret: 'hide',
          mask: mask.map((selector) => page.locator(selector)),
          maskColor: '#888888',
        });
        const size = pngSize(buffer);
        print(`shot ${file} ${size.width}x${size.height}`);
        written.push(file);
      } finally {
        if (highlight) {
          await page
            .evaluate((attribute) => {
              document.querySelectorAll(`[${attribute}]`).forEach((node) => node.removeAttribute(attribute));
            }, HIGHLIGHT_ATTRIBUTE)
            .catch(() => {});
        }
      }
    }
    return written;
  }

  function snapshot(page) {
    return page.locator('body').ariaSnapshot();
  }

  async function step(title, fn) {
    const number = ++stepNumber;
    print(`step ${number}: ${title}`);
    try {
      return await fn();
    } catch (err) {
      if (err?.shotsStep !== undefined) throw err;
      const page = [...pages].reverse().find((candidate) => !candidate.isClosed());
      if (page) {
        mkdirSync(out, { recursive: true });
        const file = join(out, `error-${number}.png`);
        const taken = await page.screenshot({ path: file, animations: 'disabled' }).catch(() => null);
        if (taken) print(`shot ${file} ${pngSize(taken).width}x${pngSize(taken).height}`);
      }
      const failure = new Error(`Step ${number} "${title}" failed: ${err?.message ?? err}`, { cause: err });
      failure.shotsStep = number;
      throw failure;
    }
  }

  return { instance, open, shoot, snapshot, step, log: (text) => print(String(text)) };
}
