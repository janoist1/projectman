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

function run(file: string, args: string[], onLine?: (line: string, child: ReturnType<typeof spawn>) => void) {
  return new Promise<Run>((resolve) => {
    const child = spawn(process.execPath, [shotsScript, file, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let seen = 0;
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const lines = stdout.split('\n');
      while (seen < lines.length - 1) onLine?.(lines[seen++]!, child);
    });
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ status: code, stdout, stderr }));
  });
}

async function listening(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return true;
  } catch {
    return false;
  }
}

function browserProcesses(): number {
  const result = spawnSync('ps', ['-A', '-o', 'command='], { encoding: 'utf8' });
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
      const result = await run(file, ['--out', out]);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
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
      const result = await run(file, ['--out', out]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Step 1 "open the board" failed');
      expect(existsSync(join(out, 'error-1.png'))).toBe(true);
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
      const timedOut = await run(
        hang,
        ['--out', join(temp(), 'out'), '--timeout', '60', '--seed', 'none'],
        (line, child) => {
          if (line === 'hanging') setTimeout(() => child.kill('SIGTERM'), 200);
        },
      );
      expect(timedOut.status).toBe(1);
      expect(timedOut.stderr).toContain('Stopped by SIGTERM');
      await expectNothingLeft(timedOut.stdout, before);

      const slow = scenario(`
  log('urls ' + instance.serverUrl + ' ' + instance.webUrl);
  await new Promise(() => {});`);
      const expired = await run(slow, ['--out', join(temp(), 'out'), '--timeout', '25', '--seed', 'none']);
      expect(expired.status).toBe(1);
      expect(expired.stderr).toContain('--timeout');
      await expectNothingLeft(expired.stdout, before);
    },
    SLOW,
  );
});
