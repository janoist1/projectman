import { describe, expect, it, vi } from 'vitest';
import { createEngineRpc, createRpcState, EngineRpcError } from './rpc';
import { decodeFrame, encodeFrame, ENGINE_MAX_FRAME_BYTES, EngineFrame } from './protocol';
import type { EngineFrame as Frame } from './protocol';
import { methods } from './methods';

describe('engine RPC', () => {
  it('coalesces concurrent retries and preserves results over reconnection for five minutes', async () => {
    const state = createRpcState();
    let at = 0;
    const sent: Frame[] = [];
    const make = () =>
      createEngineRpc({ side: 'cloud', state, now: () => at, send: (data) => sent.push(decodeFrame(data)) });
    const rpc = make();
    let finish!: (value: null) => void;
    const handler = vi.fn(
      () =>
        new Promise<null>((resolve) => {
          finish = resolve;
        }),
    );
    rpc.handle('permission.cancel', handler);
    const frame = { t: 'req', id: 'same', method: 'permission.cancel', params: { reqId: 'x' } } as const;
    const first = rpc.receive(frame);
    const retry = rpc.receive(frame);
    expect(handler).toHaveBeenCalledTimes(1);
    finish(null);
    await Promise.all([first, retry]);
    expect(sent[0]).toEqual(sent[1]);
    rpc.close();
    const next = make();
    const secondHandler = vi.fn(() => null);
    next.handle('permission.cancel', secondHandler);
    await next.receive(frame);
    expect(secondHandler).not.toHaveBeenCalled();
    at = 300_001;
    await next.receive(frame);
    expect(secondHandler).toHaveBeenCalledTimes(1);
    next.close();
  });

  it('never caches secret responses and preserves explicit secret refusals', async () => {
    const state = createRpcState();
    const sent: Frame[] = [];
    const rpc = createEngineRpc({ side: 'cloud', state, send: (data) => sent.push(decodeFrame(data)) });
    const handler = vi.fn(() => {
      throw new EngineRpcError('secret_not_allowed', 'Session is not starting');
    });
    rpc.handle('secret.nanogpt_key', handler);
    const frame = {
      t: 'req',
      id: 'secret',
      method: 'secret.nanogpt_key',
      params: { sessionId: 'ses_test' },
    } as const;
    await rpc.receive(frame);
    await rpc.receive(frame);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(state.results.size).toBe(0);
    expect(sent[0]).toMatchObject({
      ok: false,
      error: { code: 'secret_not_allowed', message: 'Session is not starting' },
    });
    rpc.handle('secret.nanogpt_key', () => ({ key: 'fictional-key' }));
    await rpc.receive(frame);
    await rpc.receive(frame);
    expect(state.results.size).toBe(0);
    expect(sent[2]).toMatchObject({ ok: true, result: { key: 'fictional-key' } });
    rpc.close();
  });

  it('acknowledges in order after handlers and skips duplicates', async () => {
    const sent: Frame[] = [];
    const state = createRpcState();
    const rpc = createEngineRpc({ side: 'cloud', state, send: (data) => sent.push(decodeFrame(data)) });
    let finish!: () => void;
    const handler = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    rpc.onEvent(handler);
    const frame = {
      t: 'evt',
      seq: 1,
      event: { kind: 'pending_input', sessionId: 'ses_test', pending: true },
    } as const;
    const received = rpc.receive(frame);
    await Promise.resolve();
    expect(sent).toEqual([]);
    finish();
    await received;
    await rpc.receive(frame);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([
      { t: 'ack', seq: 1 },
      { t: 'ack', seq: 1 },
    ]);
    await expect(rpc.receive({ ...frame, seq: 3 })).rejects.toMatchObject({ code: 'invalid_params' });
    rpc.close();
  });

  it('does not acknowledge failed handlers or closing connections', async () => {
    const state = createRpcState();
    const send = vi.fn();
    const rpc = createEngineRpc({ side: 'cloud', state, send });
    rpc.onEvent(() => {
      throw new Error('failure');
    });
    await expect(
      rpc.receive({ t: 'evt', seq: 1, event: { kind: 'screenshot_started', runId: 'run' } }),
    ).rejects.toThrow();
    expect(state.ackedSeq).toBe(0);
    expect(send).not.toHaveBeenCalled();
    rpc.close();
  });

  it('routes responses by id, validates results and rejects pending calls on close', async () => {
    const frames: Frame[] = [];
    const rpc = createEngineRpc({ side: 'cloud', send: (data) => frames.push(decodeFrame(data)) });
    const first = rpc.call('host.free_disk', {});
    const second = rpc.call('host.is_directory', { path: '/fictional' });
    const ids = frames.map((frame) => (frame.t === 'req' ? frame.id : ''));
    await rpc.receive({ t: 'res', id: ids[1]!, ok: true, result: true });
    await rpc.receive({ t: 'res', id: ids[0]!, ok: true, result: 123 });
    expect(await first).toBe(123);
    expect(await second).toBe(true);
    const pending = rpc.call('host.free_disk', {});
    const rejection = expect(pending).rejects.toMatchObject({ code: 'link_down' });
    rpc.close();
    await rejection;
  });

  it('times out and aborts calls without retaining pending listeners', async () => {
    vi.useFakeTimers();
    try {
      const rpc = createEngineRpc({ side: 'cloud', send: () => {} });
      const timed = expect(rpc.call('host.free_disk', {}, { timeoutMs: 10 })).rejects.toMatchObject({
        code: 'timeout',
      });
      await vi.advanceTimersByTimeAsync(10);
      await timed;
      const controller = new AbortController();
      const aborted = expect(
        rpc.call('host.free_disk', {}, { signal: controller.signal }),
      ).rejects.toMatchObject({ code: 'timeout' });
      controller.abort();
      await aborted;
      rpc.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('transports module codes and details and replaces oversized responses with a stable error', async () => {
    const frames: Frame[] = [];
    const engine = createEngineRpc({ side: 'engine', send: (data) => frames.push(decodeFrame(data)) });
    const details = { provider: 'codex', issues: [{ file: 'config.toml', keys: ['hooks'] }] };
    engine.handle('session.assert_workspace_config', () => {
      throw Object.assign(new Error('Unsafe project configuration'), {
        code: 'workspace_codex_config',
        details,
      });
    });
    await engine.receive({
      t: 'req',
      id: 'module',
      method: 'session.assert_workspace_config',
      params: { provider: 'codex', cwd: '/fictional' },
    });
    expect(frames[0]).toMatchObject({
      ok: false,
      error: { code: 'module_error', module: { code: 'workspace_codex_config', details } },
    });
    const cloudFrames: Frame[] = [];
    const cloud = createEngineRpc({ side: 'cloud', send: (data) => cloudFrames.push(decodeFrame(data)) });
    const call = cloud.call('session.assert_workspace_config', { provider: 'codex', cwd: '/fictional' });
    const req = cloudFrames[0]!;
    const res = frames[0]!;
    const refused = expect(call).rejects.toMatchObject({
      code: 'workspace_codex_config',
      linkCode: 'module_error',
      details,
    });
    if (req.t === 'req' && res.t === 'res') await cloud.receive({ ...res, id: req.id });
    await refused;
    engine.handle('terminal.attach', () => ({
      data: 'x'.repeat(ENGINE_MAX_FRAME_BYTES),
      cols: 80,
      rows: 24,
    }));
    await engine.receive({
      t: 'req',
      id: 'large',
      method: 'terminal.attach',
      params: { sessionId: 'ses_test' },
    });
    expect(frames[1]).toMatchObject({ ok: false, error: { code: 'result_too_large' } });
    engine.close();
    cloud.close();
  });

  it('shares in-flight event handling with a replacement link', async () => {
    const state = createRpcState();
    const old = createEngineRpc({ side: 'cloud', state, send: () => {} });
    let finish!: () => void;
    old.onEvent(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const frame = { t: 'evt', seq: 1, event: { kind: 'screenshot_started', runId: 'run' } } as const;
    const first = old.receive(frame);
    await Promise.resolve();
    old.close();
    const send = vi.fn();
    const replacement = createEngineRpc({ side: 'cloud', state, send });
    const handler = vi.fn();
    replacement.onEvent(handler);
    const retry = replacement.receive(frame);
    finish();
    await Promise.all([first, retry]);
    expect(handler).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(encodeFrame({ t: 'ack', seq: 1 }));
    replacement.close();
  });

  it('refuses unknown methods, wrong direction, unsafe machine inputs and oversized frames', async () => {
    const frames: Frame[] = [];
    const rpc = createEngineRpc({ side: 'cloud', send: (data) => frames.push(decodeFrame(data)) });
    await rpc.receive({ t: 'req', id: 'a', method: 'host.free_disk', params: {} });
    expect(frames[0]).toMatchObject({ ok: false, error: { code: 'unknown_method' } });
    expect(methods['machine.env_values'].params.safeParse({ pids: [12], names: ['SECRET'] }).success).toBe(
      false,
    );
    expect(methods['machine.signal'].params.safeParse({ pid: 1, signal: 'SIGKILL' }).success).toBe(false);
    expect(
      methods['transcript.summary'].result.safeParse({ source: 'compact', text: 'x'.repeat(8001), at: null })
        .success,
    ).toBe(false);
    expect(() =>
      encodeFrame({ t: 'term', sessionId: 's', data: 'x'.repeat(ENGINE_MAX_FRAME_BYTES) }),
    ).toThrow('too large');
    expect(EngineFrame.safeParse({ t: 'term', sessionId: 's', data: '', seq: 1 }).success).toBe(false);
    rpc.close();
  });
});
