import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BILLING_ENV_VARS, OWNER_COMMAND_OUTPUT_BYTES } from '@projectman/shared';
import { createOwnerCommandRunner } from './owner-command';

const COMMAND = {
  kind: 'owner_command',
  target: { kind: 'hub' },
  command: 'printf hello',
  timeoutSeconds: 1,
  reason: 'Inspect fixture',
} as const;

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    pid: 1234,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const start = vi.fn(
    (_shell: string, _args: readonly string[], _options: SpawnOptionsWithoutStdio) =>
      child as unknown as ChildProcessWithoutNullStreams,
  );
  const killGroup = vi.fn();
  const env = { PATH: '/bin', ...Object.fromEntries(BILLING_ENV_VARS.map((name) => [name, 'fixture'])) };
  const run = createOwnerCommandRunner('/bin/sh', { spawn: start, killGroup, env, home: '/fixture/home' });
  const abort = new AbortController();
  return { child, start, killGroup, run, abort };
}

afterEach(() => vi.useRealTimers());

describe('owner command process boundary', () => {
  it('runs the configured shell in its own group with the home default and removes every billing override', async () => {
    const f = fixture();
    const pending = f.run(COMMAND, f.abort.signal);
    expect(f.start).toHaveBeenCalledWith('/bin/sh', ['-c', COMMAND.command], {
      cwd: '/fixture/home',
      detached: true,
      stdio: 'pipe',
      env: { PATH: '/bin' },
    });
    f.child.emit('close', 7, null);
    expect(await pending).toMatchObject({ exitCode: 7, signal: null, truncated: false });
  });

  it('uses an explicitly approved working directory', async () => {
    const f = fixture();
    const pending = f.run({ ...COMMAND, cwd: '/fixture/work' }, f.abort.signal);
    expect(f.start.mock.calls[0]?.[2]).toMatchObject({ cwd: '/fixture/work' });
    f.child.emit('close', 0, null);
    await pending;
  });

  it('redacts secrets split across chunks and bounds both streams in bytes', async () => {
    const f = fixture();
    const pending = f.run(COMMAND, f.abort.signal);
    f.child.stdout.write('token=fixture-');
    f.child.stdout.write('secret\n');
    f.child.stdout.write('\x1b[31m\x1b]0;fixture-title\x07\x00\x7f');
    f.child.stdout.write('"\\\té🙂'.repeat(OWNER_COMMAND_OUTPUT_BYTES));
    f.child.stderr.write('pmk_fixture_secret\n');
    f.child.stderr.write('x'.repeat(OWNER_COMMAND_OUTPUT_BYTES));
    f.child.emit('close', null, 'SIGTERM');
    const result = await pending;
    expect(result).toMatchObject({ exitCode: null, signal: 'SIGTERM', truncated: true });
    for (const text of [result.stdout, result.stderr]) {
      expect(Buffer.byteLength(JSON.stringify(text))).toBeLessThanOrEqual(OWNER_COMMAND_OUTPUT_BYTES);
      expect(text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
      expect(text).not.toContain('fixture-title');
      expect(text).not.toMatch(/[\uD800-\uDFFF]/u);
      expect(text).toContain('[redacted]');
      expect(text).not.toContain('fixture-secret');
      expect(text).not.toContain('fixture_secret');
    }
  });

  it('sends TERM at the timeout and KILL to the group ten seconds later even if the shell has exited', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = f.run(COMMAND, f.abort.signal);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.killGroup.mock.calls).toEqual([[1234, 'SIGTERM']]);
    f.child.emit('close', null, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(9999);
    expect(f.killGroup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.killGroup.mock.calls).toEqual([
      [1234, 'SIGTERM'],
      [1234, 'SIGKILL'],
    ]);
    expect(await pending).toMatchObject({ durationMs: 11_000, signal: 'SIGTERM' });
  });

  it('clears the timeout after an ordinary exit', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = f.run(COMMAND, f.abort.signal);
    f.child.emit('close', 0, null);
    await pending;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.killGroup).not.toHaveBeenCalled();
  });

  it('stops the group on supervisor shutdown', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = f.run(COMMAND, f.abort.signal);
    f.abort.abort();
    expect(f.killGroup).toHaveBeenCalledWith(1234, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.killGroup).toHaveBeenLastCalledWith(1234, 'SIGKILL');
    f.child.emit('close', null, 'SIGKILL');
    await pending;
  });

  it('rejects a shell launch error and clears its timers', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = f.run(COMMAND, f.abort.signal);
    const failed = expect(pending).rejects.toThrow('fixture launch failure');
    f.child.emit('error', new Error('fixture launch failure'));
    await failed;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.killGroup).not.toHaveBeenCalled();
  });
});
