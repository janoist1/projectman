import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_QUEUE_UNAVAILABLE, parseHeavyArgs } from '../../../scripts/heavy/run';
import { acquireHeavyLock, readHeavyQueue } from '../src/full-test/heavy-lock';
import type { HeavyLock } from '../src/full-test/heavy-lock';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = path.join(ROOT, 'scripts/heavy/cli.ts');
const LOCK_MODULE = path.join(ROOT, 'apps/server/src/full-test/heavy-lock.ts');

let root: string;
let dir: string;
const locks: HeavyLock[] = [];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'pm-heavy-cli-'));
  dir = path.join(root, 'heavy');
});

afterEach(async () => {
  await Promise.all(locks.splice(0).map((lock) => lock.release()));
  rmSync(root, { recursive: true, force: true });
});

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** The CLI as a real process on a folder of its own; `onStderr` sees what it has written so far. */
function heavy(
  args: string[],
  env: Record<string, string | undefined> = {},
  onStderr?: (text: string) => void,
): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        PROJECTMAN_HEAVY_LOCK_DIR: dir,
        PROJECTMAN_HEAVY_LOCK_HELD: undefined,
        PROJECTMAN_SESSION_ID: undefined,
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      onStderr?.(stderr);
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const node = (script: string): string[] => ['node', '-e', script];

/** A command that prints the queue as it sees it: who holds the lock, and the variable. */
const queueReader = (): string[] => [
  process.execPath,
  '--import',
  'tsx',
  '--input-type=module',
  '-e',
  `const { readHeavyQueue } = await import(${JSON.stringify(LOCK_MODULE)});
   const queue = await readHeavyQueue(${JSON.stringify(dir)});
   console.log(JSON.stringify({ holder: queue.holder, held: process.env.PROJECTMAN_HEAVY_LOCK_HELD }));`,
];

describe('the arguments of the heavy CLI', () => {
  it('takes the options up to the first other argument, and everything after as the command', () => {
    expect(parseHeavyArgs(['--label', 'a b', '--max-wait', '90', 'npm', 'test', '--label', 'x'])).toEqual({
      label: 'a b',
      maxWaitSeconds: 90,
      command: ['npm', 'test', '--label', 'x'],
    });
    expect(parseHeavyArgs(['--', 'npm', '--version'])).toEqual({ command: ['npm', '--version'] });
    expect(parseHeavyArgs(['npm', 'run', 'x'])).toEqual({ command: ['npm', 'run', 'x'] });
  });

  it('refuses a missing command, an unknown option and a bad number', () => {
    expect(parseHeavyArgs([])).toEqual({ error: 'no command' });
    expect(parseHeavyArgs(['--label', 'x'])).toEqual({ error: 'no command' });
    expect(parseHeavyArgs(['--nope', 'x'])).toEqual({ error: 'unknown option --nope' });
    expect(parseHeavyArgs(['--max-wait'])).toEqual({ error: '--max-wait needs a value' });
    expect(parseHeavyArgs(['--max-wait', 'soon', 'x'])).toMatchObject({ error: expect.any(String) });
  });
});

describe('the heavy CLI', () => {
  it("exits with the command's status", async () => {
    expect((await heavy(node('process.exit(0)'))).code).toBe(0);
    expect((await heavy(node('process.exit(3)'))).code).toBe(3);
  });

  it('exits with 128 plus the number of the signal that ended the command', async () => {
    expect((await heavy(node("process.kill(process.pid, 'SIGTERM')"))).code).toBe(143);
  });

  it('exits with 127 for a command that does not exist, and 2 for a bad call', async () => {
    const missing = await heavy(['pm-no-such-command']);
    expect(missing.code).toBe(127);
    expect(missing.stderr).toContain('cannot run pm-no-such-command');
    const usage = await heavy([]);
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain('usage: npm run heavy');
  });

  it('holds the lock while the command runs, names the session, and releases it after', async () => {
    const ran = await heavy(['--label', 'my run', '--', ...queueReader()], {
      PROJECTMAN_SESSION_ID: 'ses_7',
    });
    expect(ran.stderr).toBe('');
    const seen = JSON.parse(ran.stdout) as { holder: { label: string; sessionId: string }; held: string };
    expect(seen.holder).toMatchObject({ label: 'my run', sessionId: 'ses_7' });
    expect(seen.held).toBe('1');
    expect((await readHeavyQueue(dir)).holder).toBeNull();
  });

  it('labels the run by the folder and the command, at most 120 characters', async () => {
    const ran = await heavy(queueReader());
    const { holder } = JSON.parse(ran.stdout) as { holder: { label: string } };
    expect(holder.label.startsWith(`${path.basename(ROOT)}: ${process.execPath}`)).toBe(true);
    expect(holder.label).toHaveLength(120);
  });

  it('says who it waits for, starts when the holder lets go, and says how long it waited', async () => {
    const holder = await acquireHeavyLock({ dir, label: 'the long test' });
    locks.push(holder);
    const ran = await heavy(['--label', 'next', ...node('process.exit(5)')], {}, (stderr) => {
      // Once it has told the wait, the holder lets go.
      if (stderr.includes('waiting')) void holder.release();
    });
    expect(ran.code).toBe(5);
    expect(ran.stderr).toMatch(
      /heavy: waiting for the machine's heavy-run queue: "the long test" since \d\d:\d\d:\d\d, 0 ahead of you \(waited 0m00s\)\n/,
    );
    expect(ran.stderr).toMatch(/heavy: started after 0m0\ds\n/);
  });

  it('exits with 75 when --max-wait runs out, and leaves the queue', async () => {
    const holder = await acquireHeavyLock({ dir, label: 'busy' });
    locks.push(holder);
    const ran = await heavy(['--max-wait', '0.4', ...node('process.exit(0)')]);
    expect(ran.code).toBe(75);
    expect(ran.stderr).toContain('waiting for the machine');
    const queue = await readHeavyQueue(dir);
    expect(queue.waiting).toEqual([]);
    expect(queue.holder?.label).toBe('busy');
  });

  it('does not queue inside a run that holds the lock', async () => {
    const holder = await acquireHeavyLock({ dir, label: 'the outer run' });
    locks.push(holder);
    const ran = await heavy(node('console.log(process.env.PROJECTMAN_HEAVY_LOCK_HELD)'), {
      PROJECTMAN_HEAVY_LOCK_HELD: '1',
    });
    expect(ran).toEqual({ code: 0, stdout: '1\n', stderr: '' });
    expect((await readHeavyQueue(dir)).holder?.label).toBe('the outer run');
  });

  it('does not run the command, and says so, when the folder is unusable (PM-346)', async () => {
    const marker = path.join(root, 'ran');
    // /tmp is not ours and not 0700: the queue cannot be used there, and nothing is made in it.
    const ran = await heavy(node(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`), {
      PROJECTMAN_HEAVY_LOCK_DIR: '/tmp/heavy',
    });
    expect(ran.code).toBe(EXIT_QUEUE_UNAVAILABLE);
    expect(EXIT_QUEUE_UNAVAILABLE).toBe(78);
    expect(existsSync(marker)).toBe(false);
    const lines = ran.stderr.trim().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^heavy: the machine's heavy-run queue cannot be used, so this did not run: /);
    expect(lines[1]).toMatch(/^heavy: .+/);
    expect(lines[2]).toContain('would overload the machine');
    expect(lines[3]).toContain('ask for the command to run outside your sandbox');
  });
});
