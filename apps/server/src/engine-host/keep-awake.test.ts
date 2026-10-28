import { describe, expect, it, vi } from 'vitest';
import { CAFFEINATE, createKeepAwake } from './keep-awake';
import type { KeepAwakeOptions } from './keep-awake';

const MINUTE = 60_000;

function setup(over: Partial<KeepAwakeOptions> = {}) {
  let clock = Date.parse('2026-10-28T10:00:00Z');
  const spawned: Array<{ command: string; args: string[]; kills: string[]; exit: () => void }> = [];
  const log = { info: vi.fn(), warn: vi.fn() };
  const keepAwake = createKeepAwake({
    mode: 'while_working',
    platform: 'darwin',
    enginePid: 4242,
    now: () => clock,
    log,
    spawn: (command, args) => {
      let listener: () => void = () => undefined;
      const entry = {
        command,
        args,
        kills: [] as string[],
        exit: () => listener(),
      };
      spawned.push(entry);
      return {
        kill: (signal) => void entry.kills.push(signal ?? 'SIGTERM'),
        onExit: (next) => void (listener = next),
      };
    },
    ...over,
  });
  return {
    keepAwake,
    spawned,
    log,
    advance: (ms: number) => void (clock += ms),
  };
}

describe('keep awake while working', () => {
  it('starts caffeinate once for the engine process when work begins', () => {
    const { keepAwake, spawned } = setup();
    keepAwake.update(true);
    keepAwake.update(true);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({ command: CAFFEINATE, args: ['-i', '-s', '-w', '4242'] });
    expect(keepAwake.state()).toMatchObject({ mode: 'while_working', holding: true });
    expect(keepAwake.state().since).toBe('2026-10-28T10:00:00.000Z');
  });

  it('keeps holding through a short idle time, and through a gap between two jobs', () => {
    const { keepAwake, spawned, advance } = setup();
    keepAwake.update(true);
    advance(MINUTE);
    keepAwake.update(false);
    advance(MINUTE);
    keepAwake.update(true); // a new job before the delay is over
    advance(MINUTE);
    keepAwake.update(false);
    advance(MINUTE);
    keepAwake.update(false);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.kills).toEqual([]);
    expect(keepAwake.state().holding).toBe(true);
  });

  it('lets go with SIGTERM once the machine has been idle for the whole delay', () => {
    const { keepAwake, spawned, advance } = setup();
    keepAwake.update(true);
    keepAwake.update(false);
    advance(2 * MINUTE);
    keepAwake.update(false);
    expect(spawned[0]!.kills).toEqual(['SIGTERM']);
    expect(keepAwake.state()).toEqual({ mode: 'while_working', holding: false });
    keepAwake.update(true); // later work holds again at once
    expect(spawned).toHaveLength(2);
  });

  it.each([
    ['the mode is off', { mode: 'off' as const }, undefined],
    ['the platform is not macOS', { platform: 'linux' as const }, true],
  ])('never starts anything when %s', (_name, over, unsupported) => {
    const { keepAwake, spawned } = setup(over);
    keepAwake.update(true);
    expect(spawned).toHaveLength(0);
    expect(keepAwake.state().holding).toBe(false);
    expect(keepAwake.state().unsupported).toBe(unsupported);
  });

  it('starts caffeinate again after it ended by itself, at most once a minute, and says so', () => {
    const { keepAwake, spawned, advance, log } = setup();
    keepAwake.update(true);
    spawned[0]!.exit();
    expect(keepAwake.state().holding).toBe(false);
    expect(log.warn).toHaveBeenCalledOnce();
    advance(10_000);
    keepAwake.update(true);
    expect(spawned).toHaveLength(1);
    advance(MINUTE);
    keepAwake.update(true);
    expect(spawned).toHaveLength(2);
    expect(keepAwake.state().holding).toBe(true);
  });

  it('does not count its own release as an unexpected exit', () => {
    const { keepAwake, spawned, advance, log } = setup();
    keepAwake.update(true);
    keepAwake.update(false);
    advance(2 * MINUTE);
    keepAwake.update(false);
    spawned[0]!.exit(); // the killed process reports its exit
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('stops caffeinate on close and starts nothing afterwards', () => {
    const { keepAwake, spawned } = setup();
    keepAwake.update(true);
    keepAwake.close();
    expect(spawned[0]!.kills).toEqual(['SIGTERM']);
    expect(keepAwake.state().holding).toBe(false);
    keepAwake.update(true);
    expect(spawned).toHaveLength(1);
  });

  it('survives a start that fails', () => {
    const { keepAwake, log } = setup({
      spawn: () => {
        throw new Error('ENOENT');
      },
    });
    keepAwake.update(true);
    expect(keepAwake.state().holding).toBe(false);
    expect(log.warn).toHaveBeenCalledOnce();
  });
});
