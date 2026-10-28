import { describe, expect, it, vi } from 'vitest';
import { SessionLifecycle } from './lifecycle';

/** A lifecycle whose subscription and shutdown write a call log. */
function lifecycleOf() {
  const log: string[] = [];
  const lifecycle: { current?: SessionLifecycle } = {};
  const subscribe = vi.fn(() => {
    log.push('subscribe');
    return () => log.push('unsubscribe');
  });
  const onClose = vi.fn(() => log.push(`onClose (running ${lifecycle.current?.running})`));
  lifecycle.current = new SessionLifecycle({ subscribe, onClose });
  return { lifecycle: lifecycle.current, log, subscribe, onClose };
}

/** A promise settled from outside. */
function deferred<A = void>() {
  let resolve!: (value: A) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<A>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('SessionLifecycle', () => {
  it('subscribes once, in the constructor', () => {
    const { subscribe, log } = lifecycleOf();
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(log).toEqual(['subscribe']);
  });

  it('closes in the order unsubscribe, end of the tracking, onClose', () => {
    const { lifecycle, log } = lifecycleOf();
    void lifecycle.run(() => new Promise<void>(() => {}));
    expect(lifecycle.running).toBe(1);
    lifecycle.close();
    expect(log).toEqual(['subscribe', 'unsubscribe', 'onClose (running 0)']);
  });

  it('closes at once, on the caller’s stack', () => {
    const { lifecycle, onClose } = lifecycleOf();
    lifecycle.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes once however often it is called', async () => {
    const { lifecycle, log, onClose } = lifecycleOf();
    lifecycle.close();
    lifecycle.close();
    await lifecycle.settled();
    lifecycle.close();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(log.filter((entry) => entry === 'unsubscribe')).toHaveLength(1);
  });

  it('starts a job at once, on the caller’s stack', () => {
    const { lifecycle } = lifecycleOf();
    const job = vi.fn(() => Promise.resolve(1));
    const result = lifecycle.run(job);
    expect(job).toHaveBeenCalledTimes(1);
    expect(result).toBeInstanceOf(Promise);
  });

  it('hands the job’s own promise back', async () => {
    const { lifecycle } = lifecycleOf();
    await expect(lifecycle.run(() => Promise.resolve('done'))).resolves.toBe('done');
  });

  it('counts a job until it settles', async () => {
    const { lifecycle } = lifecycleOf();
    const one = deferred();
    const two = deferred();
    void lifecycle.run(() => one.promise);
    void lifecycle.run(() => two.promise);
    expect(lifecycle.running).toBe(2);
    one.resolve();
    await turn();
    expect(lifecycle.running).toBe(1);
    two.resolve();
    await turn();
    expect(lifecycle.running).toBe(0);
  });

  it('rejects at the caller, with nothing unhandled, and stops counting the job', async () => {
    const { lifecycle } = lifecycleOf();
    const failure = new Error('job failed');
    const caught = lifecycle.run(() => Promise.reject(failure));
    await expect(caught).rejects.toBe(failure);
    await turn();
    expect(lifecycle.running).toBe(0);
  });

  it('lets the caller’s catch handle a rejection', async () => {
    const { lifecycle } = lifecycleOf();
    const handled = vi.fn();
    void lifecycle.run(() => Promise.reject(new Error('x'))).catch(handled);
    await turn();
    expect(handled).toHaveBeenCalledTimes(1);
  });

  it('starts no job after close and answers undefined', async () => {
    const { lifecycle } = lifecycleOf();
    lifecycle.close();
    const job = vi.fn(() => Promise.resolve(1));
    await expect(lifecycle.run(job)).resolves.toBeUndefined();
    expect(job).not.toHaveBeenCalled();
    expect(lifecycle.running).toBe(0);
  });

  it('does not cut a job that runs when it closes', async () => {
    const { lifecycle } = lifecycleOf();
    const body = deferred<string>();
    const result = lifecycle.run(() => body.promise);
    lifecycle.close();
    body.resolve('finished');
    await expect(result).resolves.toBe('finished');
  });

  it('settles at once before it was closed', async () => {
    const { lifecycle } = lifecycleOf();
    await expect(lifecycle.settled()).resolves.toBeUndefined();
  });

  it('settles after close even with a job that never settles', async () => {
    const { lifecycle, onClose } = lifecycleOf();
    void lifecycle.run(() => new Promise<void>(() => {}));
    lifecycle.close();
    await lifecycle.settled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
