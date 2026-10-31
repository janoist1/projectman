import { describe, expect, it, vi } from 'vitest';
import { createEngineRpc, createRpcState, EngineRpcError } from './rpc';
import { decodeFrame, encodeFrame, ENGINE_MAX_FRAME_BYTES, EngineFrame } from './protocol';
import type { EngineFrame as Frame } from './protocol';
import { methods } from './methods';
import { testConfig } from '../../test/helpers/test-template';

describe('engine RPC', () => {
  it.each([
    { name: 'foreign project', taskKeys: ['BR-1'] },
    { name: 'malformed key', taskKeys: ['--all'] },
    { name: 'oversized batch', taskKeys: Array.from({ length: 101 }, (_, n) => `AR-${n + 1}`) },
  ])('refuses snapshot removal with $name before dispatch', ({ taskKeys }) => {
    const project = testConfig();
    expect(
      methods['workspace.removeTaskSnapshots'].params.safeParse([
        { project, repoName: project.project.repos[0]!.name, taskKeys },
      ]).success,
    ).toBe(false);
  });
  it('does not keep a result after sending it', async () => {
    const state = createRpcState();
    const sent: Frame[] = [];
    const rpc = createEngineRpc({ side: 'cloud', state, send: (data) => sent.push(decodeFrame(data)) });
    const handler = vi.fn(() => null);
    rpc.handle('permission.cancel', handler);
    const frame = { t: 'req', id: 'same', method: 'permission.cancel', params: { reqId: 'x' } } as const;
    await rpc.receive(frame);
    await rpc.receive(frame);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(2);
    expect(state).not.toHaveProperty('results');
    rpc.close();
  });

  it('preserves explicit secret refusals', async () => {
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
    expect(sent[0]).toMatchObject({
      ok: false,
      error: { code: 'secret_not_allowed', message: 'Session is not starting' },
    });
    rpc.handle('secret.nanogpt_key', () => ({ key: 'fictional-key' }));
    await rpc.receive(frame);
    await rpc.receive(frame);
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

  it('accepts only strict ended or unknown full_test.attach responses (PM-790)', () => {
    const { params, result } = methods['full_test.attach'];
    const fullResult = { outcome: 'passed', exitCode: 0, durationMs: 1, failedFiles: [], outputTail: '' };
    expect(params.safeParse({ runId: 'run' }).success).toBe(true);
    expect(params.safeParse({ runId: 'run', extra: true }).success).toBe(false);
    expect(result.safeParse({ state: 'unknown' }).success).toBe(true);
    expect(result.safeParse({ state: 'ended', result: fullResult }).success).toBe(true);
    for (const invalid of [
      { state: 'running' },
      { state: 'ended' },
      { state: 'ended', result: fullResult, extra: true },
      { state: 'ended', result: { ...fullResult, extra: true } },
      { state: 'unknown', extra: true },
      { state: 'unknown', result: fullResult },
    ])
      expect(result.safeParse(invalid).success).toBe(false);
  });

  it('takes requireHeavyLock in the strict full_test.run spec as an optional boolean only (PM-658)', () => {
    const spec = {
      runId: 'f1',
      cwd: '/fictional/work',
      command: 'npm test',
      maxWorkers: 1,
      timeoutMs: 1000,
      sandbox: { denyRead: [], allowRead: [] },
    };
    const params = methods['full_test.run'].params;
    expect(params.safeParse({ spec }).success).toBe(true);
    expect(params.safeParse({ spec: { ...spec, requireHeavyLock: true } }).success).toBe(true);
    expect(params.safeParse({ spec: { ...spec, requireHeavyLock: false } }).success).toBe(true);
    expect(params.safeParse({ spec: { ...spec, requireHeavyLock: 'yes' } }).success).toBe(false);
    expect(params.safeParse({ spec: { ...spec, other: 1 } }).success).toBe(false);
  });

  it('takes npmCi in the strict full_test.run spec as an optional repository and merge id only (PM-681)', () => {
    const spec = {
      runId: 'f1',
      cwd: '/fictional/work',
      command: 'npm test',
      maxWorkers: 1,
      timeoutMs: 1000,
      sandbox: { denyRead: [], allowRead: [] },
    };
    const npmCi = { ref: { projectKey: 'PM', repo: 'projectman' }, mergeId: 'mrg_1' };
    const params = methods['full_test.run'].params;
    expect(params.safeParse({ spec }).success).toBe(true);
    expect(params.safeParse({ spec: { ...spec, npmCi } }).success).toBe(true);
    expect(params.safeParse({ spec: { ...spec, npmCi: { ...npmCi, extra: 1 } } }).success).toBe(false);
    expect(params.safeParse({ spec: { ...spec, npmCi: { mergeId: 'mrg_1' } } }).success).toBe(false);
    expect(params.safeParse({ spec: { ...spec, npmCi: { ref: npmCi.ref } } }).success).toBe(false);
    expect(params.safeParse({ spec: { ...spec, npmCi: true } }).success).toBe(false);
  });

  it('takes allowDependencyInstall and dependencyInstallRequired as optional booleans of merge.checkout_for_check (PM-681)', () => {
    const call = {
      ref: { projectKey: 'PM', repo: 'projectman' },
      mergeId: 'mrg_1',
      mergeCommit: 'a'.repeat(40),
      depsFrom: null,
    };
    const { params, result } = methods['merge.checkout_for_check'];
    expect(params.safeParse(call).success).toBe(true);
    expect(params.safeParse({ ...call, allowDependencyInstall: true }).success).toBe(true);
    expect(params.safeParse({ ...call, allowDependencyInstall: false }).success).toBe(true);
    expect(params.safeParse({ ...call, allowDependencyInstall: 'yes' }).success).toBe(false);
    expect(params.safeParse({ ...call, other: 1 }).success).toBe(false);
    const answer = { path: '/fictional/check', gitDir: '/fictional/git' };
    expect(result.safeParse(answer).success).toBe(true);
    expect(result.safeParse({ ...answer, dependencyInstallRequired: true }).success).toBe(true);
    expect(result.safeParse({ ...answer, dependencyInstallRequired: 'no' }).success).toBe(false);
    expect(result.safeParse({ ...answer, other: 1 }).success).toBe(false);
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

  describe('workspace.findTaskBranch over the wire', () => {
    const key = {
      project: testConfig({ workspacePath: '/cloud/path' }),
      repoName: testConfig().project.repos[0]!.name,
      member: 'dev',
    };
    /** A cloud and an engine side joined by real JSON frames; the engine's handler records its arguments. */
    function link() {
      const toEngine: string[] = [];
      const toCloud: string[] = [];
      const cloud = createEngineRpc({ side: 'cloud', send: (data) => toEngine.push(data) });
      const engine = createEngineRpc({ side: 'engine', send: (data) => toCloud.push(data) });
      const received: unknown[][] = [];
      engine.handle('workspace.findTaskBranch', (params) => {
        received.push([...params]);
        return { branch: 'PM-1-work', source: null };
      });
      const pump = async () => {
        for (const data of toEngine.splice(0)) await engine.receive(decodeFrame(data));
        for (const data of toCloud.splice(0)) await cloud.receive(decodeFrame(data));
      };
      return { cloud, engine, received, pump, toEngine };
    }

    it.each([
      ['an omitted preferred branch', undefined],
      ['a preferred branch', 'PM-1-wanted'],
    ])('delivers %s to the handler as undefined or the string', async (_name, preferred) => {
      const { cloud, engine, received, pump, toEngine } = link();
      const call = cloud.call('workspace.findTaskBranch', [key, 'PM-1', preferred] as never);
      // The JSON on the wire turns the trailing undefined into null.
      expect(JSON.parse(toEngine[0]!).params[2]).toBe(preferred ?? null);
      await pump();
      await expect(call).resolves.toEqual({ branch: 'PM-1-work', source: null });
      expect(received).toEqual([[key, 'PM-1', preferred]]);
      expect(received[0]).toHaveLength(3);
      cloud.close();
      engine.close();
    });

    it('accepts a missing third element and refuses numbers, objects and extra parameters', () => {
      const params = methods['workspace.findTaskBranch'].params;
      expect(params.parse([key, 'PM-1'])[2]).toBeUndefined();
      expect(params.parse([key, 'PM-1', null])[2]).toBeUndefined();
      expect(params.parse([key, 'PM-1', undefined])[2]).toBeUndefined();
      expect(params.parse([key, 'PM-1', 'wanted'])[2]).toBe('wanted');
      for (const bad of [1, {}, [], true]) expect(params.safeParse([key, 'PM-1', bad]).success).toBe(false);
      expect(params.safeParse([key, 'PM-1', null, 'extra']).success).toBe(false);
    });

    it('names the method and the failing fields, never the values, on both sides', async () => {
      const frames: Frame[] = [];
      const engine = createEngineRpc({ side: 'engine', send: (data) => frames.push(decodeFrame(data)) });
      engine.handle('workspace.findTaskBranch', () => null);
      await engine.receive({
        t: 'req',
        id: 'bad',
        method: 'workspace.findTaskBranch',
        params: [key, 'PM-1', 'ok', 'sk-secret-extra'],
      });
      await engine.receive({
        t: 'req',
        id: 'bad2',
        method: 'workspace.findTaskBranch',
        params: [{ ...key, member: 7 }, 'PM-1', { token: 'sk-secret-value' }],
      });
      const messages = frames.map((frame) => (frame.t === 'res' && !frame.ok ? frame.error : null));
      expect(messages[0]).toMatchObject({ code: 'invalid_params' });
      expect(messages[1]!.message).toContain('workspace.findTaskBranch');
      expect(messages[1]!.message).toContain('0.member');
      expect(messages[1]!.message).toContain('2');
      expect(JSON.stringify(messages)).not.toContain('sk-secret');
      const cloud = createEngineRpc({ side: 'cloud', send: () => {} });
      await expect(cloud.call('workspace.findTaskBranch', [key, 'PM-1', 5] as never)).rejects.toMatchObject({
        code: 'invalid_params',
        message: expect.stringMatching(/workspace\.findTaskBranch \(2\)/),
      });
      engine.close();
      cloud.close();
    });
  });

  it('limits dependency preparation to a workspace key and a strict ready or skipped result', () => {
    const { params, result } = methods['workspace.prepareDependencies'];
    const key = { project: testConfig(), repoName: testConfig().project.repos[0]!.name, member: 'dev' };
    expect(params.safeParse([key]).success).toBe(true);
    for (const value of [
      [key, { waitMs: 1 }],
      [{ ...key, cwd: '/other' }],
      [{ ...key, command: 'npm install' }],
    ])
      expect(params.safeParse(value).success).toBe(false);
    expect(result.safeParse({ status: 'ready', key: 'a'.repeat(64), changed: true }).success).toBe(true);
    expect(result.safeParse({ status: 'skipped', reason: 'not_configured' }).success).toBe(true);
    expect(
      result.safeParse({ status: 'skipped', reason: 'unavailable', dependencies: 'stale' }).success,
    ).toBe(true);
    expect(
      result.safeParse({ status: 'skipped', reason: 'not_configured', dependencies: 'gone' }).success,
    ).toBe(false);
    expect(result.safeParse({ status: 'ready', key: '', changed: true }).success).toBe(false);
    expect(
      result.safeParse({ status: 'ready', key: 'a'.repeat(64), changed: true, output: 'extra' }).success,
    ).toBe(false);
  });

  describe('workspace.publishTaskBranch over the wire (PM-739)', () => {
    const key = {
      project: testConfig({ workspacePath: '/cloud/path' }),
      repoName: testConfig().project.repos[0]!.name,
      member: 'dev',
    };
    const commit = 'a'.repeat(40);

    it('carries four parameters out and exactly the path and the ref back', async () => {
      const toEngine: string[] = [];
      const toCloud: string[] = [];
      const cloud = createEngineRpc({ side: 'cloud', send: (data) => toEngine.push(data) });
      const engine = createEngineRpc({ side: 'engine', send: (data) => toCloud.push(data) });
      const received: unknown[][] = [];
      engine.handle('workspace.publishTaskBranch', (params) => {
        received.push([...params]);
        return { path: '/engine/repo', ref: `refs/projectman/workspaces/dev/PM-1/${commit}` };
      });
      const call = cloud.call('workspace.publishTaskBranch', [key, 'PM-1', 'PM-1-work', commit]);
      for (const data of toEngine.splice(0)) await engine.receive(decodeFrame(data));
      for (const data of toCloud.splice(0)) await cloud.receive(decodeFrame(data));
      await expect(call).resolves.toEqual({
        path: '/engine/repo',
        ref: `refs/projectman/workspaces/dev/PM-1/${commit}`,
      });
      expect(received).toEqual([[key, 'PM-1', 'PM-1-work', commit]]);
      cloud.close();
      engine.close();
    });

    it('refuses a missing or extra parameter and a result with more than the path and the ref', () => {
      const { params, result } = methods['workspace.publishTaskBranch'];
      expect(params.safeParse([key, 'PM-1', 'PM-1-work', commit]).success).toBe(true);
      expect(params.safeParse([key, 'PM-1', 'PM-1-work']).success).toBe(false);
      expect(params.safeParse([key, 'PM-1', 'PM-1-work', commit, 'extra']).success).toBe(false);
      expect(params.safeParse([key, 'PM-1', 'PM-1-work', 5]).success).toBe(false);
      expect(result.safeParse({ path: '/p', ref: 'refs/x' }).success).toBe(true);
      expect(result.safeParse({ path: '/p', ref: 'refs/x', token: 'sk-secret' }).success).toBe(false);
    });
  });

  it('keeps an unrecognised exception out of the response and the log, naming only method and class', async () => {
    const frames: Frame[] = [];
    const failures: unknown[] = [];
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const engine = createEngineRpc({
      side: 'cloud',
      send: (data) => frames.push(decodeFrame(data)),
      onFailed: (failure) => failures.push(failure),
    });
    engine.handle('permission.cancel', () => {
      throw new TypeError('connect failed with token sk-secret-token at /Users/x/.projectman/secret');
    });
    await engine.receive({ t: 'req', id: 'boom', method: 'permission.cancel', params: { reqId: 'x' } });
    expect(frames[0]).toMatchObject({
      ok: false,
      error: { code: 'internal', message: 'Engine request failed' },
    });
    expect(failures).toEqual([{ method: 'permission.cancel', category: 'TypeError' }]);
    expect(JSON.stringify([frames, failures])).not.toContain('sk-secret');
    expect(logged).not.toHaveBeenCalled();
    engine.handle('permission.cancel', () => {
      throw Object.assign(new Error('x'), { name: 'sk-secret name with spaces' });
    });
    await engine.receive({ t: 'req', id: 'boom2', method: 'permission.cancel', params: { reqId: 'y' } });
    expect(failures[1]).toEqual({ method: 'permission.cancel', category: 'Error' });
    logged.mockRestore();
    engine.close();
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
