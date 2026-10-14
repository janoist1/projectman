import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { runPromise } from '../kernel';
import { runProcessGroup } from './run-sandboxed-core';

const run = (
  command: string,
  options: { timeoutMs?: number; killGraceMs?: number; signal?: AbortSignal; cwd?: string } = {},
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
    expect(await run('sleep 30', { timeoutMs: 50 })).toMatchObject({ timedOut: true, signal: 'SIGTERM' });
  });
  it('kills a group that ignores TERM after the grace period', async () => {
    const started = Date.now();
    const end = await run("trap '' TERM; sleep 30", { timeoutMs: 100, killGraceMs: 80 });
    expect(end).toMatchObject({ timedOut: true, signal: 'SIGKILL' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(180);
  });
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
  it('kills a background grandchild when the shell exits', async () => {
    // Redirect the pipes so the shell close event does not wait for the grandchild.
    const end = await run('sleep 30 >/dev/null 2>&1 & echo $!');
    const pid = Number(end.output.trim());
    expect(pid).toBeGreaterThan(0);
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        expect(error).toMatchObject({ code: 'ESRCH' });
        return;
      }
      await new Promise(setImmediate);
    }
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
