import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_WIDTHS,
  UsageError,
  browserStatus,
  browsersPath,
  createScenarioApi,
  isAllowedUrl,
  outputDirectory,
  parseArgs,
  viewportFor,
} from '../../../scripts/lib/browser.mjs';

/** scripts/lib/browser.mjs and scripts/shots.mjs without a browser (PM-270). */
const shotsScript = fileURLToPath(new URL('../../../scripts/shots.mjs', import.meta.url));
const temporary: string[] = [];

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shots-test-'));
  temporary.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fence = { webUrl: 'http://127.0.0.1:5199', serverUrl: 'http://127.0.0.1:4799' };

describe('the fence', () => {
  it.each([
    'http://127.0.0.1:5199/',
    'http://127.0.0.1:5199/tasks/AC-1?x=1',
    'ws://127.0.0.1:5199/?token=x',
    'http://127.0.0.1:4799/api/me',
    'ws://127.0.0.1:4799/ws',
    'data:image/png;base64,AAAA',
    'blob:http://127.0.0.1:5199/0b0a7d0c-5d4e-4a35-8a4f-1f5e8c1d0f0e',
  ])('lets %s through', (url) => {
    expect(isAllowedUrl(url, fence)).toBe(true);
  });

  it.each([
    'http://127.0.0.1:4800/api/me', // the live instance
    'ws://127.0.0.1:4800/ws',
    'http://localhost:5199/',
    'http://127.0.0.1:5198/',
    'https://127.0.0.1:5199/',
    'http://example.com/',
    'https://fonts.googleapis.com/css',
    'file:///etc/passwd',
    'ftp://127.0.0.1:5199/',
    'chrome://version',
    'not a url',
  ])('refuses %s', (url) => {
    expect(isAllowedUrl(url, fence)).toBe(false);
  });
});

describe('widths and heights', () => {
  it('pairs the four widths with their heights', () => {
    expect(DEFAULT_WIDTHS.map((width) => viewportFor(width))).toEqual([
      { width: 1512, height: 982 },
      { width: 800, height: 900 },
      { width: 390, height: 844 },
      { width: 375, height: 667 },
    ]);
  });

  it('gives another width the default height', () => {
    expect(viewportFor(1024)).toEqual({ width: 1024, height: 900 });
  });
});

describe('where the images go', () => {
  it('uses --out first', () => {
    expect(
      outputDirectory({ out: '/x/out', scenario: 'a/b.mjs', env: { PROJECTMAN_SESSION_DIR: '/s' } }),
    ).toBe('/x/out');
  });

  it('then the session folder, named after the scenario', () => {
    expect(outputDirectory({ scenario: 'scenarios/basket.mjs', env: { PROJECTMAN_SESSION_DIR: '/s' } })).toBe(
      '/s/shots/basket',
    );
  });

  it('then the temporary folder', () => {
    expect(outputDirectory({ scenario: 'basket.mjs', env: {}, tmp: '/t' })).toBe(
      '/t/projectman-shots/basket',
    );
  });
});

describe('the browsers folder', () => {
  it('is $PROJECTMAN_BROWSERS_PATH, else $PLAYWRIGHT_BROWSERS_PATH, else ~/.projectman/browsers', () => {
    expect(browsersPath({ PROJECTMAN_BROWSERS_PATH: '/b', PLAYWRIGHT_BROWSERS_PATH: '/p' }, '/home/x')).toBe(
      '/b',
    );
    expect(browsersPath({ PLAYWRIGHT_BROWSERS_PATH: '/p' }, '/home/x')).toBe('/p');
    expect(browsersPath({}, '/home/x')).toBe('/home/x/.projectman/browsers');
  });

  it('is found installed only with the completed-install marker', () => {
    const dir = temp();
    const missing = browserStatus({ PROJECTMAN_BROWSERS_PATH: dir });
    expect(missing.installed).toBe(false);
    expect(missing.version).toMatch(/^\d+\./);
  });
});

describe('the arguments', () => {
  it('takes the defaults', () => {
    expect(parseArgs(['scenario.mjs'])).toEqual({
      scenario: 'scenario.mjs',
      out: undefined,
      widths: [1512, 800, 390, 375],
      fullPage: false,
      scale: 1,
      timeoutSeconds: 240,
      seed: 'demo',
      keepData: false,
    });
  });

  it('reads every option', () => {
    expect(
      parseArgs([
        '--out',
        'o',
        's.mjs',
        '--widths',
        '1512,390',
        '--full-page',
        '--scale',
        '2',
        '--timeout',
        '30',
        '--seed',
        'none',
        '--keep-data',
      ]),
    ).toEqual({
      scenario: 's.mjs',
      out: 'o',
      widths: [1512, 390],
      fullPage: true,
      scale: 2,
      timeoutSeconds: 30,
      seed: 'none',
      keepData: true,
    });
  });

  it.each([
    [[]],
    [['a.mjs', 'b.mjs']],
    [['a.mjs', '--wat']],
    [['a.mjs', '--widths', '12,x']],
    [['a.mjs', '--scale', '3']],
    [['a.mjs', '--seed', 'big']],
    [['a.mjs', '--out']],
    [['a.mjs', '--timeout', '0']],
  ])('refuses %j as wrong use', (args) => {
    expect(() => parseArgs(args)).toThrow(UsageError);
  });
});

/** A PNG header with the given size: all `shoot` reads of the image. */
function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function fakePage(calls: string[]) {
  let viewport = { width: 0, height: 0 };
  let closed = false;
  const page = {
    setViewportSize: async (size: { width: number; height: number }) => {
      viewport = size;
      calls.push(`viewport ${size.width}x${size.height}`);
    },
    evaluate: async () => {},
    waitForLoadState: async () => {},
    addStyleTag: async () => {
      calls.push('style');
    },
    goto: async (url: string) => {
      calls.push(`goto ${url}`);
    },
    close: async () => {
      closed = true;
      calls.push('close');
    },
    locator: (selector: string) => ({
      first: () => ({
        evaluate: async () => calls.push(`mark ${selector}`),
        scrollIntoViewIfNeeded: async () => calls.push(`scroll ${selector}`),
      }),
      ariaSnapshot: async () => `- text: ${selector}`,
      selector,
    }),
    screenshot: async (options: { path: string; fullPage?: boolean; mask?: unknown[] }) => {
      calls.push(`screenshot ${options.path} full=${options.fullPage} masks=${options.mask?.length ?? 0}`);
      return png(viewport.width, viewport.height);
    },
    isClosed: () => closed,
  };
  return page;
}

describe('the scenario API', () => {
  function api(printed: string[]) {
    const calls: string[] = [];
    const page = fakePage(calls);
    const instance = {
      ...fence,
      owner: { email: 'owner@x.test', name: 'Owner' },
      storageState: async () => ({ cookies: [], origins: [] }),
    };
    const browser = {
      newContext: async () => ({
        route: async () => {},
        routeWebSocket: async () => {},
        on: () => {},
        newPage: async () => page,
      }),
    };
    const scenario = createScenarioApi({
      browser,
      instance: instance as never,
      out: '/unused-dir-is-made-below',
      print: (line) => printed.push(line),
    });
    return { scenario, page, calls };
  }

  it('writes one image per width, named after the width, and prints each', async () => {
    const out = join(temp(), 'shots');
    const printed: string[] = [];
    const calls: string[] = [];
    const page = fakePage(calls);
    const { shoot } = createScenarioApi({
      browser: {},
      instance: {
        ...fence,
        owner: { email: 'o@x.test', name: 'O' },
        storageState: async () => ({}),
      } as never,
      out,
      print: (line) => printed.push(line),
    });
    const files = await shoot(page, 'basket', {
      highlight: '#buy',
      mask: ['.price', '.name'],
      fullPage: true,
    });
    expect(files).toEqual([1512, 800, 390, 375].map((width) => join(out, `basket-${width}.png`)));
    expect(printed).toEqual([
      `shot ${out}/basket-1512.png 1512x982`,
      `shot ${out}/basket-800.png 800x900`,
      `shot ${out}/basket-390.png 390x844`,
      `shot ${out}/basket-375.png 375x667`,
    ]);
    expect(calls.filter((call) => call.startsWith('screenshot'))).toHaveLength(4);
    expect(calls).toContain(`screenshot ${out}/basket-390.png full=true masks=2`);
    expect(calls.filter((call) => call === 'mark #buy')).toHaveLength(4);
    expect(calls.filter((call) => call === 'scroll #buy')).toHaveLength(4);
  });

  it('refuses a name that would leave the folder', async () => {
    const { scenario, page } = api([]);
    await expect(scenario.shoot(page, '../escape')).rejects.toThrow(/invalid name/);
    await expect(scenario.shoot(page, 'a/b')).rejects.toThrow(/invalid name/);
  });

  it('opens a path of the web instance only', async () => {
    const { scenario } = api([]);
    await expect(scenario.open({ path: 'tasks' })).rejects.toThrow(/starts with "\/"/);
    await expect(scenario.open({ path: '//example.com/x' })).rejects.toThrow(/leaves the instance/);
  });

  it('uses one browser context for the whole run and logs in again for another account', async () => {
    const calls: string[] = [];
    const pages: ReturnType<typeof fakePage>[] = [];
    let contexts = 0;
    let onPage: (page: unknown) => void = () => {};
    const browser = {
      newContext: async () => {
        contexts += 1;
        return {
          route: async () => {},
          routeWebSocket: async () => {},
          on: (_: string, handler: (page: unknown) => void) => (onPage = handler),
          clearCookies: async () => {
            calls.push('clear cookies');
          },
          addCookies: async (cookies: { value: string }[]) => {
            calls.push(`add cookies ${cookies.map((cookie) => cookie.value).join(',')}`);
          },
          newPage: async () => {
            const page = fakePage(calls);
            pages.push(page);
            onPage(page);
            return page;
          },
        };
      },
    };
    const owner = { email: 'owner@x.test', name: 'Owner' };
    const dana = { email: 'dana@x.test', name: 'Dana' };
    const { open } = createScenarioApi({
      browser,
      instance: {
        ...fence,
        owner,
        storageState: async (account: { email: string }) => ({
          cookies: [{ value: account.email }],
          origins: [],
        }),
      } as never,
      out: '/unused',
      print: () => {},
    });

    const first = await open({ path: '/p/AC' });
    const second = await open({ path: '/p/AC/team' });
    expect(contexts).toBe(1);
    expect(first.isClosed()).toBe(false); // the same account: pages live side by side
    expect(second.isClosed()).toBe(false);

    await open({ as: dana, path: '/p/AC' });
    expect(contexts).toBe(1);
    expect(first.isClosed()).toBe(true); // another account: the open pages are closed first
    expect(second.isClosed()).toBe(true);
    expect(calls).toContain('clear cookies');
    expect(calls).toContain('add cookies dana@x.test');

    await open({ path: '/p/AC' });
    expect(calls).toContain('add cookies owner@x.test');
    expect(contexts).toBe(1);
  });

  it('names the failed step and writes error-<n>.png', async () => {
    const printed: string[] = [];
    const out = join(temp(), 'shots');
    const calls: string[] = [];
    const page = fakePage(calls);
    const { step, open } = createScenarioApi({
      browser: {
        newContext: async () => ({
          route: async () => {},
          routeWebSocket: async () => {},
          on: (_: string, handler: (page: unknown) => void) => handler(page),
          newPage: async () => ({ ...page, goto: async () => {} }),
        }),
      },
      instance: {
        ...fence,
        owner: { email: 'o@x.test', name: 'O' },
        storageState: async () => ({}),
      } as never,
      out,
      print: (line) => printed.push(line),
    });
    await open();
    await step('fine', async () => {});
    await expect(
      step('open the card', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('Step 2 "open the card" failed: boom');
    expect(calls.some((call) => call.includes('error-2.png'))).toBe(true);
    expect(printed.at(0)).toBe('step 1: fine');
  });
});

describe('npm run shots without a browser', () => {
  function run(args: string[], browsers = temp()) {
    return spawnSync(process.execPath, [shotsScript, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PROJECTMAN_BROWSERS_PATH: browsers },
      timeout: 60_000,
    });
  }

  it('exits 2 and names the install command when the browser is missing', () => {
    const dir = temp();
    const scenario = join(dir, 'a.mjs');
    writeFileSync(scenario, 'export default async () => {};\n');
    const result = run([scenario, '--out', join(dir, 'out')]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('npm run browsers -- install');
    expect(existsSync(join(dir, 'out'))).toBe(false);
  });

  it('exits 2 for a wrong command line and for a scenario that cannot load', () => {
    expect(run([]).status).toBe(2);
    const dir = temp();
    expect(run([join(dir, 'missing.mjs')]).status).toBe(2);
    const noFunction = join(dir, 'b.mjs');
    writeFileSync(noFunction, 'export const x = 1;\n');
    const result = run([noFunction]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('default async function');
    expect(readFileSync(noFunction, 'utf8')).toContain('x = 1');
  });
});
