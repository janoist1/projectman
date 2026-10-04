import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { browserStatus } from '../../../scripts/lib/browser.mjs';

/**
 * `npm run shots` with the real headless Chromium (PM-270). Skipped, with a note in the output, when
 * the browser is not installed (`npm run browsers -- install`, outside the sandbox).
 */
const status = browserStatus();
const SLOW = 180_000;
const QUESTION = 'Which colour should the basket button be?';
const shotsScript = fileURLToPath(new URL('../../../scripts/shots.mjs', import.meta.url));
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

const askQuestion = `
  const developer = (await instance.api('/api/projects/AC/members')).find(
    (member) => member.kind === 'ai' && member.role === 'developer',
  );
  const sessionId = await instance.startSession('AC', 'AC-1', developer.handle);
  await instance.waitIdle('AC', sessionId);
  await instance.setFakeCalls([{ tool: 'ask_human', arguments: { question: ${JSON.stringify(QUESTION)} } }]);
  await instance.say('AC', sessionId, 'CALLS please');
  await instance.waitIdle('AC', sessionId);
  const colleague = await instance.invite({ project: 'AC', email: 'dana@acme.test', name: 'Dana Dev', access: 'developer' });
  log('urls ' + instance.serverUrl + ' ' + instance.webUrl);
`;

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

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
  return new Promise<Run & { killed: boolean }>((resolve) => {
    const child = spawn(process.execPath, [shotsScript, file, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
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
      resolve({ status: code, stdout, stderr, killed });
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
function why(result: Run & { killed: boolean }): string {
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

function browserProcesses(): number {
  const result = spawnSync('ps', ['-A', '-o', 'command='], { encoding: 'utf8' });
  if (result.error || result.status !== 0 || !result.stdout) {
    // A member's sandbox may not allow `ps`: the process check then cannot say anything.
    if (!psWarned)
      console.warn('shots-browser.test.ts: `ps` is not available, the leftover-browser check is skipped.');
    psWarned = true;
    return 0;
  }
  return result.stdout.split('\n').filter((line) => /headless[-_]shell/.test(line)).length;
}

/** Nothing of the run is left: no browser, and the instance's ports are free. */
async function expectNothingLeft(output: string, browsersBefore: number) {
  const urls = /^urls (\S+) (\S+)$/m.exec(output);
  if (urls) {
    expect(await listening(urls[1]!)).toBe(false);
    expect(await listening(urls[2]!)).toBe(false);
  }
  expect(browserProcesses()).toBeLessThanOrEqual(browsersBefore);
}

function pngSize(file: string) {
  const buffer = readFileSync(file);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

describe.skipIf(!status.installed)('npm run shots with a browser', () => {
  it(
    'opens a card with an open question as a non-admin and writes four images of the given sizes',
    async () => {
      const out = join(temp(), 'out');
      const before = browserProcesses();
      const file = scenario(`${askQuestion}
  await step('open the card', async () => {
    const page = await open({ as: colleague, path: '/p/AC/tasks/AC-1' });
    await page.waitForFunction((text) => document.body.innerText.includes(text), ${JSON.stringify(QUESTION)});
    await shoot(page, 'card');
  });`);
      const result = await run(file, ['--out', out, '--timeout', '80'], { limitMs: 100_000 });
      expect(result.status, why(result)).toBe(0);
      expect(result.stderr.slice(0, 2000)).toBe('');
      const sizes = [...result.stdout.matchAll(/^shot (\S+) (\d+)x(\d+)$/gm)].map((m) => [m[1], m[2], m[3]]);
      expect(sizes).toEqual([
        [join(out, 'card-1512.png'), '1512', '982'],
        [join(out, 'card-800.png'), '800', '900'],
        [join(out, 'card-390.png'), '390', '844'],
        [join(out, 'card-375.png'), '375', '667'],
      ]);
      for (const [path, width, height] of sizes)
        expect(pngSize(path!)).toEqual({ width: Number(width), height: Number(height) });
      await expectNothingLeft(result.stdout, before);
    },
    SLOW,
  );

  it(
    'exits 1 after a failed step, with an error image, and leaves nothing running',
    async () => {
      const out = join(temp(), 'out');
      const before = browserProcesses();
      const file = scenario(`
  log('urls ' + instance.serverUrl + ' ' + instance.webUrl);
  await step('open the board', async () => {
    const page = await open({ path: '/p/AC' });
    await page.locator('#does-not-exist').click({ timeout: 1000 });
  });`);
      const result = await run(file, ['--out', out, '--timeout', '80'], { limitMs: 100_000 });
      expect(result.status, why(result)).toBe(1);
      expect(result.stderr).toContain('Step 1 "open the board" failed');
      expect(existsSync(join(out, 'error-1.png'))).toBe(true);
      await expectNothingLeft(result.stdout, before);
    },
    SLOW,
  );

  it(
    'logs in again for another account in the same browser and back',
    async () => {
      const out = join(temp(), 'out');
      const before = browserProcesses();
      const file = scenario(`
  const colleague = await instance.invite({ project: 'AC', email: 'dana@acme.test', name: 'Dana Dev', access: 'developer' });
  log('urls ' + instance.serverUrl + ' ' + instance.webUrl);
  await step('three logins, one after the other', async () => {
    for (const [name, account] of [['owner', undefined], ['colleague', colleague], ['owner-again', undefined]]) {
      const page = await open({ as: account, path: '/p/AC' });
      await page.waitForURL(/\\/p\\/AC$/, { timeout: 15000 });
      await shoot(page, name, { widths: [1512] });
    }
  });`);
      const result = await run(file, ['--out', out, '--timeout', '80'], { limitMs: 100_000 });
      expect(result.status, why(result)).toBe(0);
      for (const name of ['owner', 'colleague', 'owner-again'])
        expect(pngSize(join(out, `${name}-1512.png`))).toEqual({ width: 1512, height: 982 });
      await expectNothingLeft(result.stdout, before);
    },
    SLOW,
  );

  it(
    'stops everything at the timeout and on SIGTERM',
    async () => {
      const before = browserProcesses();
      const hang = scenario(`
  log('urls ' + instance.serverUrl + ' ' + instance.webUrl);
  await open({ path: '/' });
  log('hanging');
  await new Promise(() => {});`);
      const timedOut = await run(hang, ['--out', join(temp(), 'out'), '--timeout', '50', '--seed', 'none'], {
        limitMs: 60_000,
        onLine: (line, child) => {
          if (line === 'hanging') setTimeout(() => child.kill('SIGTERM'), 200);
        },
      });
      expect(timedOut.status, why(timedOut)).toBe(1);
      expect(timedOut.stderr).toContain('Stopped by SIGTERM');
      await expectNothingLeft(timedOut.stdout, before);

      const slow = scenario(`
  log('urls ' + instance.serverUrl + ' ' + instance.webUrl);
  await new Promise(() => {});`);
      const expired = await run(slow, ['--out', join(temp(), 'out'), '--timeout', '25', '--seed', 'none'], {
        limitMs: 60_000,
      });
      expect(expired.status, why(expired)).toBe(1);
      expect(expired.stderr).toContain('--timeout');
      await expectNothingLeft(expired.stdout, before);
    },
    SLOW,
  );
});
