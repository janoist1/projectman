import { describe, expect, it, vi } from 'vitest';
import { createShutdown } from './shutdown';

function setup(close: () => Promise<void>) {
  let time = 0;
  const exit = vi.fn();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const shutdown = createShutdown({ close, exit, log, now: () => time, graceMs: 3000 });
  return {
    shutdown,
    exit,
    log,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe('createShutdown', () => {
  it('closes the server and exits 0', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const { shutdown, exit } = setup(close);
    shutdown('SIGINT');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('ignores a repeated signal inside the grace period (npm forwards the signal twice)', async () => {
    let finish: () => void = () => {};
    const close = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const { shutdown, exit, advance } = setup(close);
    shutdown('SIGINT');
    advance(50);
    shutdown('SIGINT');
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('forces the exit on a repeated signal after the grace period', () => {
    const close = vi.fn(() => new Promise<void>(() => {}));
    const { shutdown, exit, log, advance } = setup(close);
    shutdown('SIGINT');
    advance(3000);
    shutdown('SIGINT');
    expect(exit).toHaveBeenCalledWith(1);
    expect(log.warn).toHaveBeenCalledWith({ signal: 'SIGINT' }, 'forced exit');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('exits 1 when closing fails', async () => {
    const { shutdown, exit, log } = setup(() => Promise.reject(new Error('boom')));
    shutdown('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(log.error).toHaveBeenCalled();
  });
});
