import { getEventListeners } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runPromise } from '../kernel';
import { runProcessGroup } from './run-sandboxed-core';
import { quoteShellWord } from './sandbox';

const run = (
  command: string,
  options: {
    timeoutMs?: number;
    killGraceMs?: number;
    signal?: AbortSignal;
    cwd?: string;
    file?: string;
  } = {},
) =>
  runPromise(
    runProcessGroup({
      file: '/bin/sh',
      args: ['-c', command],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 5000,
      killGraceMs: 40,
      signal: new AbortController().signal,
      ...options,
    }),
  );

describe('process group execution', () => {
  it('collects stdout, stderr and the exit code and removes the abort listener', async () => {
    const signal = new AbortController().signal;
    const end = await run('echo out; echo err >&2; exit 7', { signal });
    expect(end).toMatchObject({ exitCode: 7, timedOut: false, aborted: false });
    expect(end.output).toContain('out');
    expect(end.output).toContain('err');
    expect(getEventListeners(signal, 'abort')).toEqual([]);
  });
  it('terminates on timeout', async () => {
    // Leave time for the Node guard and shell to start on a loaded CI host.
    // Both TERM and the grace-period KILL terminate the timed-out process group.
    expect(await run('sleep 30', { timeoutMs: 5000 })).toMatchObject({
      timedOut: true,
      signal: expect.stringMatching(/^SIG(?:TERM|KILL)$/),
    });
  });
  it('kills a group that ignores TERM after the grace period', async () => {
    const started = Date.now();
    const end = await run("trap '' TERM; echo ready; sleep 30", {
      timeoutMs: 5000,
      killGraceMs: 200,
    });
    expect(end.output).toContain('ready');
    expect(end).toMatchObject({ timedOut: true, signal: 'SIGKILL' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(5190);
  });
  it.each(['timeout', 'abort'] as const)(
    'keeps the grace period and kills the worker after its parent exits on %s',
    async (mode) => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'pm-group-'));
      const ready = path.join(dir, 'ready');
      const controller = new AbortController();
      let pids: number[] = [];
      try {
        // Like a merge-test launcher: the parent exits on TERM, but the worker ignores it
        // and closes the launcher's pipes, so `close` does not prove the group is gone.
        const worker = `trap '' TERM; echo $$ > ${quoteShellWord(ready)}; while :; do sleep 1; done`;
        const runStarted = Date.now();
        const pending = run(
          `trap 'exit 0' TERM; /bin/sh -c ${quoteShellWord(worker)} >/dev/null 2>&1 & echo $$; echo $!; wait`,
          { timeoutMs: mode === 'timeout' ? 500 : 5000, killGraceMs: 200, signal: controller.signal },
        );
        await expect.poll(() => readFile(ready, 'utf8')).toMatch(/^\d+\n$/);
        const workerPid = Number(await readFile(ready, 'utf8'));
        pids.push(workerPid);
        const started = Date.now();
        if (mode === 'abort') controller.abort();
        const end = await pending;
        pids = end.output.trim().split('\n').map(Number);
        expect(pids).toContain(workerPid);
        expect(end).toMatchObject({ timedOut: mode === 'timeout', aborted: mode === 'abort' });
        expect(Date.now() - (mode === 'timeout' ? runStarted : started)).toBeGreaterThanOrEqual(
          mode === 'timeout' ? 690 : 190,
        );
        for (const pid of pids) await expect.poll(() => isGone(pid)).toBe(true);
      } finally {
        controller.abort();
        for (const pid of pids) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* Already gone. */
          }
        }
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
  it('handles abort during execution and removes the listener', async () => {
    const controller = new AbortController();
    const pending = run('sleep 30', { signal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ aborted: true });
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  });
  it('handles an already aborted signal after spawning', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await run('sleep 30', { signal: controller.signal })).toMatchObject({ aborted: true });
  });
  it('reports a spawn error', async () => {
    expect((await run('true', { cwd: '/missing-projectman-test-directory' })).spawnError).toBeInstanceOf(
      Error,
    );
  });
  it('preserves a command signal', async () => {
    expect(await run('kill -USR1 $$')).toMatchObject({ exitCode: null, signal: 'SIGUSR1' });
  });
  it('reports a command spawn error through the guard', async () => {
    expect((await run('true', { file: '/missing-projectman-test-command' })).spawnError).toBeInstanceOf(
      Error,
    );
  });
  it('kills the group when its engine is killed without running finalizers', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pm-engine-death-'));
    const ready = path.join(dir, 'worker.json');
    const worker = `
      const { writeFileSync } = require('node:fs');
      process.on('SIGTERM', () => {});
      writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ worker: process.pid, guard: process.ppid }));
      setInterval(() => {}, 1000);
    `;
    // A disposable engine imports the actual runner; SIGKILL bypasses every Effect finalizer.
    const script = `
      import { runPromise } from ${JSON.stringify(new URL('../kernel/index.ts', import.meta.url).href)};
      import { runProcessGroup } from ${JSON.stringify(new URL('./run-sandboxed-core.ts', import.meta.url).href)};
      await runPromise(runProcessGroup({
        file: process.execPath, args: ['-e', ${JSON.stringify(worker)}],
        cwd: process.cwd(), env: {}, timeoutMs: 30000, killGraceMs: 200,
        signal: new AbortController().signal,
      }));
    `;
    const engine = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errors = '';
    engine.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      errors += chunk;
    });
    const exited = new Promise<void>((resolve, reject) => {
      engine.on('error', reject);
      engine.on('exit', () => resolve());
    });
    let pids: { worker: number; guard: number } | undefined;
    try {
      await expect
        .poll(
          async () => {
            try {
              pids = JSON.parse(await readFile(ready, 'utf8'));
              return true;
            } catch {
              return errors || false;
            }
          },
          { timeout: 10_000 },
        )
        .toBe(true);
      expect(isGone(pids!.worker)).toBe(false);
      engine.kill('SIGKILL');
      await exited;
      await expect.poll(() => isGone(pids!.worker)).toBe(true);
      await expect.poll(() => isGone(pids!.guard)).toBe(true);
      expect(pids!.guard).not.toBe(engine.pid);
    } finally {
      engine.kill('SIGKILL');
      await exited;
      if (pids) {
        try {
          process.kill(-pids.guard, 'SIGKILL');
        } catch {
          /* Already gone. */
        }
        try {
          process.kill(pids.worker, 'SIGKILL');
        } catch {
          /* Also clean up when checking the unguarded implementation. */
        }
      }
      engine.stderr.destroy();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('kills a background grandchild when the shell exits', async () => {
    // Redirect the pipes so the shell close event does not wait for the grandchild.
    const end = await run('sleep 30 >/dev/null 2>&1 & echo $!');
    const pid = Number(end.output.trim());
    expect(pid).toBeGreaterThan(0);
    await expect.poll(() => isGone(pid), { timeout: 5000, interval: 50 }).toBe(true);
  });
});

function isGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    throw error;
  }
}
