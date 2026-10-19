import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { browserStatus, createScenarioApi, launchBrowser } from '../../../scripts/lib/browser.mjs';
import type { ScenarioApi } from '../../../scripts/lib/browser.mjs';
import { startInstance } from '../../../scripts/lib/instance.mjs';
import type { Account, Instance } from '../../../scripts/lib/instance.mjs';

/**
 * `npm run shots` with the real headless Chromium (PM-270). Skipped, with a note in the output, when
 * the browser is not installed (`npm run browsers -- install`, outside the sandbox).
 */
// Without the playwright-core package (no `npm install`) there is no browser either.
const status = (() => {
  try {
    return browserStatus();
  } catch {
    return { installed: false, path: 'node_modules/playwright-core', revision: '?' };
  }
})();
const SLOW = 180_000;
const QUESTION = 'Which colour should the basket button be?';
const shotsScript = fileURLToPath(new URL('../../../scripts/shots.mjs', import.meta.url));
const calmMachineFile = fileURLToPath(
  new URL('../../../scripts/fixtures/machine/calm.json', import.meta.url),
);
const calmMachine = readFileSync(calmMachineFile, 'utf8');
const temporary: string[] = [];

if (!status.installed)
  console.warn(
    `shots-browser.test.ts is skipped: ${status.path} has no chromium-headless-shell ${status.revision} ` +
      '(npm run browsers -- install).',
  );

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shots-browser-'));
  temporary.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scenario(body: string): string {
  const file = join(temp(), 'scenario.mjs');
  writeFileSync(
    file,
    `export default async ({ instance, open, shoot, snapshot, step, log }) => {\n${body}\n};\n`,
  );
  return file;
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** A finished run, and the temporary directory it had as its own. */
type Finished = Run & { killed: boolean; tmp: string };

const OUTPUT_LIMIT = 64_000;

/**
 * Runs `npm run shots` as its own process group with a hard limit: when it does not end in time (a
 * browser that hangs or spins), the whole group is killed and the test fails with what was printed,
 * instead of waiting for it.
 */
function run(
  file: string,
  args: string[],
  {
    onLine,
    limitMs = 120_000,
  }: { onLine?: (line: string, child: ReturnType<typeof spawn>) => void; limitMs?: number } = {},
) {
  return new Promise<Finished>((resolve) => {
    // The run's own temporary directory: Playwright puts the browser's profile folder under it, so the
    // browser's command line names it and no other run's browser does (see `browserProcesses`).
    const tmp = temp();
    const child = spawn(process.execPath, [shotsScript, file, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, TMPDIR: tmp },
    });
    let stdout = '';
    let stderr = '';
    let partial = '';
    let killed = false;
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(limit);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ status: code, stdout, stderr, killed, tmp });
    };
    const limit = setTimeout(() => {
      killed = true;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, limitMs);
    child.stdout.on('data', (chunk) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk;
      partial += chunk;
      const lines = partial.split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) onLine?.(line, child);
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += chunk;
    });
    // 'exit', not 'close': a grandchild that keeps the pipes open must not keep the test waiting.
    child.on('exit', (code) => setTimeout(() => finish(code), 500));
  });
}

/** A failed run says why, in a short string (never a diff of a huge one). */
function why(result: Finished): string {
  return `${result.killed ? 'KILLED at the time limit; ' : ''}status ${result.status}\n${result.stderr.slice(0, 2000)}\n${result.stdout.slice(-2000)}`;
}

async function listening(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return true;
  } catch {
    return false;
  }
}

let psWarned = false;

/**
 * The headless browsers of one run: those whose command line names the run's temporary directory (its
 * profile folder). Other members' and other tests' browsers on the machine are not counted.
 */
function browserProcesses(tmp: string): number {
  const result = spawnSync('ps', ['-A', '-o', 'command='], { encoding: 'utf8' });
  if (result.error || result.status !== 0 || !result.stdout) {
    // A member's sandbox may not allow `ps`: the process check then cannot say anything.
    if (!psWarned)
      console.warn('shots-browser.test.ts: `ps` is not available, the leftover-browser check is skipped.');
    psWarned = true;
    return 0;
  }
  return result.stdout
    .split('\n')
    .filter((line) => /headless[-_]shell/.test(line) && line.includes(`${tmp}/`)).length;
}

/** Nothing of the run is left: no browser of its own, and the instance's ports are free. */
async function expectNothingLeft(finished: Finished) {
  const urls = /^urls (\S+) (\S+)$/m.exec(finished.stdout);
  if (urls) {
    expect(await listening(urls[1]!)).toBe(false);
    expect(await listening(urls[2]!)).toBe(false);
  }
  expect(browserProcesses(finished.tmp)).toBe(0);
}

function pngSize(file: string) {
  const buffer = readFileSync(file);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

describe.skipIf(!status.installed)('npm run shots with a browser', () => {
  let browser: any;
  let realContext: any;
  let httpHandler: ((route: any) => unknown) | undefined;
  let wsHandler: ((socket: any) => void) | undefined;
  let sharedInstance: Instance;
  let colleague: Account;
  let seededSessionId: string;
  const cleanups: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    [browser, sharedInstance] = await Promise.all([launchBrowser(), startInstance({ machine: calmMachine })]);
    [seededSessionId, colleague] = await Promise.all([
      (async () => {
        const developer = (await sharedInstance.api('/api/projects/AC/members')).find(
          (member: { kind: string; role: string }) => member.kind === 'ai' && member.role === 'developer',
        );
        const id = await sharedInstance.startSession('AC', 'AC-1', developer.handle);
        await sharedInstance.waitIdle('AC', id);
        await sharedInstance.setFakeCalls([{ tool: 'ask_human', arguments: { question: QUESTION } }]);
        await sharedInstance.say('AC', id, 'CALLS please');
        await sharedInstance.waitIdle('AC', id);
        await sharedInstance.setFakeCalls([]);
        return id;
      })(),
      (async () => {
        colleague = await sharedInstance.invite({
          project: 'AC',
          email: 'dana@acme.test',
          name: 'Dana Dev',
          access: 'developer',
        });
        // Warm up Vite module transformation while the fake AI session runs its turns.
        const { api } = sharedScenario(join(temp(), 'warmup'));
        const page = await api.open({ as: colleague, path: '/p/AC/tasks/AC-1/timeline' });
        await page.waitForURL(/\/p\/AC\/tasks\/AC-1\/timeline$/, { timeout: 15_000 }).catch(() => {});
        for (const cleanup of cleanups.splice(0)) await cleanup();
        return colleague;
      })(),
    ]);
  }, SLOW);

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
  });

  afterAll(async () => {
    await realContext?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await sharedInstance?.stop();
  }, SLOW);

  function sharedScenario(out: string) {
    const lines: string[] = [];
    const testBrowser = {
      // Single-process Chromium crashes (SIGTRAP) on a second Playwright BrowserContext (scripts/lib/browser.mjs),
      // so each test gets a freshly reset context state (pages closed, storage/cookies/routes replaced).
      newContext: async (options: { storageState?: { cookies?: unknown[] }; [key: string]: unknown }) => {
        const pageListeners: ((page: unknown) => void)[] = [];
        if (!realContext) {
          realContext = await browser.newContext(options);
          await realContext.route(/.*/, (route: any) => httpHandler?.(route));
          await realContext.routeWebSocket(/.*/, (socket: any) => wsHandler?.(socket));
        } else {
          await realContext.clearCookies();
          if (options.storageState?.cookies?.length) {
            await realContext.addCookies(options.storageState.cookies);
          }
        }
        cleanups.push(async () => {
          for (const listener of pageListeners) realContext.off('page', listener);
          for (const page of realContext?.pages() ?? []) {
            if (!page.isClosed()) {
              await page
                .evaluate(() => {
                  localStorage.clear();
                  sessionStorage.clear();
                })
                .catch(() => {});
              await page.close().catch(() => {});
            }
          }
        });
        return {
          route: async (_url: unknown, handler: (route: any) => unknown) => {
            httpHandler = handler;
          },
          routeWebSocket: async (_url: unknown, handler: (socket: any) => void) => {
            wsHandler = handler;
          },
          on: (event: string, listener: (page: unknown) => void) => {
            if (event === 'page') pageListeners.push(listener);
            realContext.on(event, listener);
          },
          newPage: () => realContext.newPage(),
          clearCookies: () => realContext.clearCookies(),
          addCookies: (cookies: unknown) => realContext.addCookies(cookies),
        };
      },
    };
    const instance: Instance = {
      ...sharedInstance,
      get serverUrl() {
        return sharedInstance.serverUrl;
      },
      get webUrl() {
        return sharedInstance.webUrl;
      },
      startSession: async (project, taskKey, assignee) =>
        project === 'AC' && taskKey === 'AC-1'
          ? seededSessionId
          : sharedInstance.startSession(project, taskKey, assignee),
      waitIdle: async (project, sessionId, timeoutMs) =>
        sessionId === seededSessionId ? undefined : sharedInstance.waitIdle(project, sessionId, timeoutMs),
      setFakeCalls: async () => {},
      say: async (project, sessionId, text) =>
        sessionId === seededSessionId ? undefined : sharedInstance.say(project, sessionId, text),
      invite: async (input) =>
        input.email.toLowerCase() === colleague.email ? colleague : sharedInstance.invite(input),
    };
    const api: ScenarioApi = createScenarioApi({
      browser: testBrowser,
      instance,
      out,
      print: (line) => lines.push(line),
    });
    return { api, lines };
  }

  it(
    'opens a card with an open question as a non-admin and writes four images of the given sizes',
    async () => {
      const out = join(temp(), 'out');
      const { api, lines } = sharedScenario(out);
      await api.step('open the card', async () => {
        const page = await api.open({ as: colleague, path: '/p/AC/tasks/AC-1/timeline' });
        await page.waitForFunction((text: string) => document.body.innerText.includes(text), QUESTION);
        await api.shoot(page, 'card');
      });
      const stdout = lines.join('\n');
      const sizes = [...stdout.matchAll(/^shot (\S+) (\d+)x(\d+)$/gm)].map((m) => [m[1], m[2], m[3]]);
      expect(sizes).toEqual([
        [join(out, 'card-1512.png'), '1512', '982'],
        [join(out, 'card-800.png'), '800', '900'],
        [join(out, 'card-390.png'), '390', '844'],
        [join(out, 'card-375.png'), '375', '667'],
      ]);
      for (const [path, width, height] of sizes)
        expect(pngSize(path!)).toEqual({ width: Number(width), height: Number(height) });
    },
    SLOW,
  );

  it(
    'exits 1 after a failed step, with an error image, and leaves nothing running',
    async () => {
      const out = join(temp(), 'out');
      const { api } = sharedScenario(out);
      await expect(
        api.step('open the board', async () => {
          const page = await api.open({ path: '/p/AC' });
          await page.locator('#does-not-exist').click({ timeout: 1000 });
        }),
      ).rejects.toThrow('Step 1 "open the board" failed');
      expect(existsSync(join(out, 'error-1.png'))).toBe(true);
    },
    SLOW,
  );

  it(
    'runs the sample scenario of the documentation: a non-admin sees the card, two images',
    async () => {
      const out = join(temp(), 'out');
      const { api, lines } = sharedScenario(out);
      const sample = fileURLToPath(
        new URL('../../../scripts/scenarios/card-with-question.mjs', import.meta.url),
      );
      const { default: runSample } = (await import(pathToFileURL(sample).href)) as {
        default: (api: ScenarioApi) => Promise<void>;
      };
      await runSample(api);
      expect(lines.join('\n')).toContain('signed in as dana@acme.test: [{"key":"AC","access":"developer"}]');
      for (const width of [1512, 390])
        expect(pngSize(join(out, `card-question-${width}.png`)).width).toBe(width);
    },
    SLOW,
  );

  it(
    'logs in again for another account in the same browser and back',
    async () => {
      const out = join(temp(), 'out');
      const { api } = sharedScenario(out);
      await api.step('three logins, one after the other', async () => {
        for (const [name, account] of [
          ['owner', undefined],
          ['colleague', colleague],
          ['owner-again', undefined],
        ] as const) {
          const page = await api.open({ as: account, path: '/p/AC' });
          await page.waitForURL(/\/p\/AC$/, { timeout: 15000 });
          await api.shoot(page, name, { widths: [1512] });
        }
      });
      for (const name of ['owner', 'colleague', 'owner-again'])
        expect(pngSize(join(out, `${name}-1512.png`))).toEqual({ width: 1512, height: 982 });
    },
    SLOW,
  );

  it(
    'stops everything at the timeout, on SIGINT and on SIGTERM: exit code 1, no data folder left',
    async () => {
      // Separate `--seed none` instances: this test kills the shots CLI and checks that its instance directory and processes are gone.
      const hang = scenario(`
  log('urls ' + instance.serverUrl + ' ' + instance.webUrl);
  log('dir ' + instance.dir);
  await open({ path: '/' });
  log('hanging');
  await new Promise(() => {});`);
      const slow = scenario(`
  log('urls ' + instance.serverUrl + ' ' + instance.webUrl);
  await new Promise(() => {});`);

      const [sigint, sigterm, expired] = await Promise.all([
        run(
          hang,
          ['--out', join(temp(), 'out'), '--timeout', '50', '--seed', 'none', '--machine', calmMachineFile],
          {
            limitMs: 50_000,
            onLine: (line, child) => {
              if (line === 'hanging') setTimeout(() => child.kill('SIGINT'), 200);
            },
          },
        ),
        run(
          hang,
          ['--out', join(temp(), 'out'), '--timeout', '50', '--seed', 'none', '--machine', calmMachineFile],
          {
            limitMs: 50_000,
            onLine: (line, child) => {
              if (line === 'hanging') setTimeout(() => child.kill('SIGTERM'), 200);
            },
          },
        ),
        run(
          slow,
          ['--out', join(temp(), 'out'), '--timeout', '12', '--seed', 'none', '--machine', calmMachineFile],
          {
            limitMs: 60_000,
          },
        ),
      ]);

      for (const [signal, interrupted] of [
        ['SIGINT', sigint],
        ['SIGTERM', sigterm],
      ] as const) {
        // Exit code 1 and the message, not death by the signal (130 for SIGINT, no code for SIGTERM).
        expect(interrupted.status, why(interrupted)).toBe(1);
        expect(interrupted.stderr).toContain(`Stopped by ${signal}`);
        const dir = /^dir (.+)$/m.exec(interrupted.stdout)?.[1];
        expect(dir).toBeTruthy();
        expect(existsSync(dir!)).toBe(false);
        await expectNothingLeft(interrupted);
      }

      expect(expired.status, why(expired)).toBe(1);
      expect(expired.stderr).toContain('--timeout');
      await expectNothingLeft(expired);
    },
    SLOW,
  );
});
