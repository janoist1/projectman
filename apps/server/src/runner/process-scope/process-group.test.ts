import { describe, expect, it, vi } from 'vitest';
import type { ProcessRecord } from '../../contracts';
import { PROCESS_SCOPE_GUARANTEE } from '../../contracts';
import { silentLogger } from '../test-helpers';
import { createProcessScopeDriver } from './process-group';

function harness(initialNow = 10_000) {
  let now = initialNow;
  let records: ProcessRecord[] | null = [];
  const marks = new Map<number, Record<string, string>>();
  const signal = vi.fn((pid: number, sig: string) => {
    if (sig === 'SIGKILL')
      records = records?.filter((p) => (pid < 0 ? p.pgid !== -pid : p.pid !== pid)) ?? null;
  });
  const envValues = vi.fn(
    async (pids: number[]) => new Map([...marks].filter(([pid]) => pids.includes(pid))),
  );
  const driver = createProcessScopeDriver({
    config: { kind: 'process_group' },
    uid: 501,
    instanceTag: 'own',
    logger: silentLogger(),
    signal,
    clock: {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    },
    processes: {
      processes: async () => records,
      envValues,
    },
  });
  const add = (pid: number, scopeId: string, over: Partial<ProcessRecord> = {}) => {
    records!.push({
      pid,
      ppid: 1,
      pgid: pid,
      uid: 501,
      startedAt: now,
      rssBytes: 0,
      cpuSeconds: 0,
      cpuPercent: 0,
      args: '',
      ...over,
    });
    marks.set(pid, {
      PROJECTMAN_SCOPE_ID: scopeId,
      PROJECTMAN_INSTANCE: 'own',
      PROJECTMAN_SESSION_ID: 'ses_old',
    });
  };
  return {
    envValues,
    driver,
    signal,
    add,
    marks,
    list: () => records,
    setList: (list: ProcessRecord[] | null) => {
      records = list;
    },
  };
}

describe('engine process groups', () => {
  it.each(['throw', 'unreadable descendant'] as const)(
    'signals the verified leader with TERM and KILL when inspection fails due to %s',
    async (failure) => {
      const h = harness();
      const scope = await h.driver.open('ses_a');
      h.add(20, scope.scopeId);
      scope.attached(20);
      await Promise.resolve();
      if (failure === 'throw') h.envValues.mockRejectedValue(new Error('environment unavailable'));
      else {
        h.add(21, 'scp_1111111111111111', { ppid: 20 });
        h.marks.delete(21);
      }
      expect(await scope.close('stop', { force: false })).toMatchObject({
        outcome: 'unverified',
        killed: true,
      });
      expect(h.signal).toHaveBeenCalledWith(20, 'SIGTERM');
      expect(h.signal).toHaveBeenCalledWith(20, 'SIGKILL');
      expect(h.signal).not.toHaveBeenCalledWith(-20, expect.anything());
      expect(h.signal).not.toHaveBeenCalledWith(21, expect.anything());
      expect(h.list()?.some((p) => p.pid === 20)).toBe(false);
    },
  );
  it('signals a known detached child when later environment probes fail', async () => {
    const h = harness();
    const scope = await h.driver.open('ses_a');
    h.add(21, scope.scopeId);
    let calls = 0;
    h.envValues.mockImplementation(async (pids) => {
      if (++calls > 1) throw new Error('environment unavailable');
      return new Map([...h.marks].filter(([pid]) => pids.includes(pid)));
    });
    expect(await scope.close('stop', { force: false })).toMatchObject({
      outcome: 'failed',
      survivors: 1,
      killed: true,
    });
    expect(h.signal).toHaveBeenCalledWith(21, 'SIGTERM');
    expect(h.signal).toHaveBeenCalledWith(21, 'SIGKILL');
  });
  it('does not signal a reused known leader or an unrelated unreadable process', async () => {
    const h = harness();
    const scope = await h.driver.open('ses_a');
    h.add(20, scope.scopeId);
    scope.attached(20);
    await Promise.resolve();
    h.setList([]);
    h.add(20, scope.scopeId, { startedAt: 11_000 });
    h.add(21, 'scp_1111111111111111');
    h.marks.delete(21);
    expect(await scope.close('stop', { force: false })).toMatchObject({ outcome: 'clean' });
    expect(h.signal).not.toHaveBeenCalled();
  });
  it.each([NaN, Infinity, -Infinity])(
    'keeps unknown unreadable scopes unverified with invalid age %s',
    async (sinceAgeMs) => {
      const h = harness();
      const scopeId = 'scp_0000000000000001';
      h.add(20, scopeId, { startedAt: 1000 });
      h.add(21, scopeId, { startedAt: 1000, ppid: 20 });
      h.marks.delete(21);
      expect(await h.driver.closeScopes([{ sessionId: 'ses_old', scopeId, sinceAgeMs }])).toMatchObject([
        { cleanup: { outcome: 'unverified' } },
      ]);
    },
  );
  it.each(['throw', 'transient'] as const)(
    'never reports a detached live child clean when environment reads %s',
    async (failure) => {
      const h = harness();
      const scope = await h.driver.open('ses_a');
      h.add(21, scope.scopeId);
      h.signal.mockImplementation(() => {});
      if (failure === 'throw') h.envValues.mockRejectedValue(new Error('environment unavailable'));
      else {
        let calls = 0;
        h.envValues.mockImplementation(async (pids) => {
          if (++calls === 5) throw new Error('temporary environment failure');
          return new Map([...h.marks].filter(([pid]) => pids.includes(pid)));
        });
      }
      expect(await scope.close('exit', { force: false })).toMatchObject({
        outcome: failure === 'transient' ? 'failed' : 'unverified',
        survivors: failure === 'transient' ? 1 : 0,
      });
      expect(h.list()?.map((p) => p.pid)).toEqual([21]);
    },
  );
  it('reports verified KILL-resistant survivors despite a transient environment failure', async () => {
    const h = harness();
    const scope = await h.driver.open('ses_a');
    h.add(21, scope.scopeId);
    h.signal.mockImplementation(() => {});
    let calls = 0;
    h.envValues.mockImplementation(async (pids) => {
      if (++calls === 3) throw new Error('temporary environment failure');
      return new Map([...h.marks].filter(([pid]) => pids.includes(pid)));
    });
    expect(await scope.close('stop', { force: false })).toMatchObject({
      outcome: 'failed',
      survivors: 1,
      killed: true,
      durationMs: 7000,
    });
    expect(h.list()?.map((p) => p.pid)).toEqual([21]);
    h.envValues.mockImplementation(
      async (pids) => new Map([...h.marks].filter(([pid]) => pids.includes(pid))),
    );
    h.signal.mockImplementation((pid, sig) => {
      if (sig === 'SIGKILL') h.setList(h.list()!.filter((p) => p.pid !== pid));
    });
    expect(await h.driver.closeScopes([{ sessionId: 'ses_a', scopeId: scope.scopeId }])).toMatchObject([
      { cleanup: { outcome: 'clean' } },
    ]);
  });
  it('continues tracking a previously verified detached identity when its environment becomes unreadable', async () => {
    const h = harness();
    const scope = await h.driver.open('ses_a');
    h.add(21, scope.scopeId);
    h.signal.mockImplementation(() => {});
    let calls = 0;
    h.envValues.mockImplementation(async (pids) =>
      ++calls === 1 ? new Map([...h.marks].filter(([pid]) => pids.includes(pid))) : new Map(),
    );
    expect(await scope.close('exit', { force: false })).toMatchObject({ outcome: 'failed', survivors: 1 });
    expect(h.signal).toHaveBeenCalledWith(21, 'SIGKILL');
  });
  it('never sends a later unverified KILL when TERM found an empty process group', async () => {
    const h = harness();
    const scope = await h.driver.open('ses_a');
    h.setList(null);
    scope.attached(20);
    h.signal.mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    expect(await scope.close('stop', { force: false })).toMatchObject({
      outcome: 'unverified',
      durationMs: 0,
      killed: false,
    });
    expect(h.signal.mock.calls).toEqual([[-20, 'SIGTERM']]);
  });
  it('reports best effort and an unpredictable generation per start', async () => {
    const h = harness();
    const a = await h.driver.open('ses_a');
    const b = await h.driver.open('ses_a');
    expect(a.scopeId).toMatch(/^scp_[0-9a-f]{16}$/);
    expect(a.scopeId).not.toBe(b.scopeId);
    expect(a.launch({ file: 'cli', args: [], env: {} }).env.PROJECTMAN_SCOPE_ID).toBe(a.scopeId);
    expect(PROCESS_SCOPE_GUARANTEE.process_group).toBe('best_effort');
  });
  it('returns clean after TERM and shares the first close promise', async () => {
    const h = harness();
    const scope = await h.driver.open('ses_a');
    h.add(20, scope.scopeId);
    scope.attached(20);
    h.signal.mockImplementation(() => h.setList([]));
    const first = scope.close('stop', { force: false });
    expect(scope.close('exit', { force: true })).toBe(first);
    expect(await first).toMatchObject({ outcome: 'clean', killed: false, reason: 'stop' });
  });
  it('kills a TERM-resistant detached child at five seconds', async () => {
    const h = harness();
    const scope = await h.driver.open('ses_a');
    h.add(20, scope.scopeId);
    h.add(21, scope.scopeId, { pgid: 21 });
    scope.attached(20);
    const cleanup = await scope.close('exit', { force: false });
    expect(cleanup).toMatchObject({ outcome: 'clean', killed: true, durationMs: 5000 });
    expect(h.signal).toHaveBeenCalledWith(21, 'SIGKILL');
  });
  it('reports survivors at seven seconds and retries failed scopes', async () => {
    const h = harness();
    const scope = await h.driver.open('ses_a');
    h.add(20, scope.scopeId);
    h.signal.mockImplementation(() => {});
    expect(await scope.close('shutdown', { force: false })).toMatchObject({
      outcome: 'failed',
      survivors: 1,
      durationMs: 7000,
    });
    h.setList([]);
    h.add(21, 'scp_1111111111111111');
    h.marks.delete(21);
    expect(await h.driver.closeScopes([{ sessionId: 'ses_a', scopeId: scope.scopeId }])).toEqual([
      expect.objectContaining({
        sessionId: 'ses_a',
        cleanup: expect.objectContaining({ outcome: 'clean', reason: 'recovery' }),
      }),
    ]);
  });
  it('retains the known process group across unverified retries until cleanup is clean', async () => {
    const h = harness();
    const scope = await h.driver.open('ses_a');
    h.add(20, scope.scopeId);
    scope.attached(20);
    h.envValues.mockRejectedValue(new Error('environment unavailable'));
    expect(await scope.close('exit', { force: false })).toMatchObject({ outcome: 'unverified' });
    h.envValues.mockImplementation(
      async (pids) => new Map([...h.marks].filter(([pid]) => pids.includes(pid))),
    );
    h.setList([]);
    h.add(21, scope.scopeId, { pgid: 20 });
    h.marks.delete(21);
    const request = [{ sessionId: 'ses_a', scopeId: scope.scopeId }];
    expect(await h.driver.closeScopes(request)).toMatchObject([{ cleanup: { outcome: 'unverified' } }]);
    expect(await h.driver.closeScopes(request)).toMatchObject([{ cleanup: { outcome: 'unverified' } }]);
    expect(h.signal).not.toHaveBeenCalledWith(21, expect.anything());
    h.setList([]);
    expect(await h.driver.closeScopes(request)).toMatchObject([{ cleanup: { outcome: 'clean' } }]);
  });
  it('force skips TERM and the grace interval', async () => {
    const h = harness();
    const scope = await h.driver.open('ses_a');
    h.add(20, scope.scopeId);
    expect(await scope.close('kill', { force: true })).toMatchObject({
      outcome: 'clean',
      killed: true,
      durationMs: 0,
    });
    expect(h.signal.mock.calls.every(([, sig]) => sig === 'SIGKILL')).toBe(true);
  });
  it('bounds a forced close with survivors to the two-second kill wait', async () => {
    const h = harness();
    const scope = await h.driver.open('ses_a');
    h.add(20, scope.scopeId);
    h.signal.mockImplementation(() => {});
    expect(await scope.close('kill', { force: true })).toMatchObject({
      outcome: 'failed',
      durationMs: 2000,
      survivors: 1,
    });
  });
  it('bounds an unavailable process probe and never resumes signalling on its late result', async () => {
    vi.useFakeTimers();
    try {
      let resolve!: (records: ProcessRecord[]) => void;
      const pending = new Promise<ProcessRecord[]>((done) => {
        resolve = done;
      });
      const signal = vi.fn();
      const driver = createProcessScopeDriver({
        config: { kind: 'process_group' },
        uid: 501,
        logger: silentLogger(),
        signal,
        processes: { processes: () => pending, envValues: async () => new Map() },
      });
      const scope = await driver.open('ses_a');
      const closed = scope.close('exit', { force: false });
      await vi.advanceTimersByTimeAsync(7000);
      expect(await closed).toMatchObject({ outcome: 'unverified', durationMs: 7000 });
      resolve([]);
      await Promise.resolve();
      expect(signal).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it('never signals another uid, scope, old generation or reused leader pid', async () => {
    const h = harness();
    const scope = await h.driver.open('ses_a');
    h.add(20, scope.scopeId);
    scope.attached(20);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    h.setList([]);
    h.add(20, scope.scopeId, { startedAt: 11_000 });
    h.add(21, 'scp_0000000000000000', { pgid: 20 });
    h.add(22, scope.scopeId, { uid: 502 });
    h.add(23, scope.scopeId, { startedAt: 1000 });
    expect(await scope.close('stop', { force: false })).toMatchObject({ outcome: 'clean' });
    expect(h.signal).not.toHaveBeenCalled();
  });
  it('does not signal an empty or partly foreign group', async () => {
    const h = harness();
    const scope = await h.driver.open('ses_a');
    h.add(20, scope.scopeId);
    h.add(21, 'scp_0000000000000000', { pgid: 20 });
    scope.attached(20);
    await scope.close('kill', { force: true });
    expect(h.signal).not.toHaveBeenCalledWith(-20, expect.anything());
    expect(h.list()?.map((p) => p.pid)).toEqual([21]);
  });
  it('closing one session leaves the other session untouched', async () => {
    const h = harness();
    const a = await h.driver.open('ses_a');
    const b = await h.driver.open('ses_b');
    h.add(20, a.scopeId);
    h.add(21, b.scopeId);
    await a.close('kill', { force: true });
    expect(h.list()?.map((p) => p.pid)).toEqual([21]);
    expect(await h.driver.recover()).toEqual([]);
  });
  it('recovers older marked scopes of this instance only', async () => {
    const h = harness();
    h.add(20, 'scp_0000000000000001', { startedAt: 1000 });
    h.add(21, 'scp_0000000000000002');
    h.marks.get(21)!.PROJECTMAN_INSTANCE = 'nested';
    const result = await h.driver.recover();
    expect(result).toHaveLength(1);
    expect(result[0]?.cleanup).toMatchObject({ outcome: 'clean', reason: 'recovery' });
    expect(h.list()?.map((p) => p.pid)).toEqual([21]);
  });
  it('reports unverified when the list is unavailable', async () => {
    const h = harness();
    const scope = await h.driver.open('ses_a');
    h.setList(null);
    expect(await scope.close('stop', { force: false })).toMatchObject({
      outcome: 'unverified',
      survivors: 0,
    });
  });
  it('keeps tracking children in a verified group even after they clear their marker', async () => {
    const h = harness();
    const scope = await h.driver.open('ses_a');
    h.add(20, scope.scopeId);
    h.add(21, scope.scopeId, { pgid: 20 });
    h.marks.delete(21);
    scope.attached(20);
    expect(await scope.close('kill', { force: true })).toMatchObject({ outcome: 'clean' });
    expect(h.list()).toEqual([]);
  });
  it('never signals a leader whose scope marker now names another generation', async () => {
    const h = harness();
    const scope = await h.driver.open('ses_a');
    h.add(20, scope.scopeId);
    scope.attached(20);
    h.marks.get(20)!.PROJECTMAN_SCOPE_ID = 'scp_0000000000000000';
    await scope.close('kill', { force: true });
    expect(h.signal).not.toHaveBeenCalled();
  });
  it('retries an unknown persisted scope after engine restart and verifies absence', async () => {
    const h = harness();
    const scopeId = 'scp_0000000000000001';
    h.add(20, scopeId, { startedAt: 1000 });
    expect(await h.driver.closeScopes([{ sessionId: 'ses_old', scopeId }])).toMatchObject([
      { cleanup: { outcome: 'clean' } },
    ]);
    expect(await h.driver.closeScopes([{ sessionId: 'ses_old', scopeId }])).toMatchObject([
      { cleanup: { outcome: 'clean', killed: false } },
    ]);
    h.setList(null);
    expect(await h.driver.closeScopes([{ sessionId: 'ses_old', scopeId }])).toMatchObject([
      { cleanup: { outcome: 'unverified' } },
    ]);
  });
  it.each(['orphan', 'missing parent', 'foreign parent'] as const)(
    'releases an absent scope after restart despite a recent unreadable process with %s',
    async (relation) => {
      const h = harness(100_000);
      const scopeId = 'scp_0000000000000001';
      h.add(20, scopeId, { ppid: relation === 'orphan' ? 1 : 21 });
      h.marks.delete(20);
      if (relation === 'foreign parent') h.add(21, 'scp_1111111111111111');
      expect(
        await h.driver.closeScopes([{ sessionId: 'ses_old', scopeId, sinceAgeMs: 10_000 }]),
      ).toMatchObject([{ cleanup: { outcome: 'clean', killed: false } }]);
      expect(h.signal).not.toHaveBeenCalled();
    },
  );
  it.each(['group', 'parent', 'unmarked ancestor', 'cycle', 'depth limit'] as const)(
    'keeps recovery unverified for an unreadable process related through %s',
    async (relation) => {
      const h = harness(100_000);
      const scopeId = 'scp_0000000000000001';
      h.add(20, scopeId);
      h.add(21, scopeId, {
        pgid: relation === 'group' ? 20 : 21,
        ppid: relation === 'group' ? 1 : relation === 'parent' ? 20 : 22,
      });
      h.marks.delete(21);
      if (relation === 'unmarked ancestor' || relation === 'cycle') {
        h.add(22, scopeId, { ppid: relation === 'cycle' ? 21 : 20 });
        h.marks.set(22, {});
      }
      if (relation === 'depth limit') {
        for (let pid = 22; pid < 279; pid++) {
          h.add(pid, scopeId, { ppid: pid + 1 });
          h.marks.set(pid, {});
        }
      }
      expect(
        await h.driver.closeScopes([{ sessionId: 'ses_old', scopeId, sinceAgeMs: 10_000 }]),
      ).toMatchObject([{ cleanup: { outcome: 'unverified' } }]);
      expect(h.signal).not.toHaveBeenCalled();
    },
  );
  it.each(['foreign generation', 'older process'] as const)(
    'stops ancestry attribution at a %s before reaching a scope member',
    async (anchor) => {
      const h = harness(100_000);
      const scopeId = 'scp_0000000000000001';
      h.add(20, scopeId);
      h.add(21, scopeId, { ppid: 22 });
      h.marks.delete(21);
      h.add(22, 'scp_1111111111111111', { ppid: 20, startedAt: anchor === 'older process' ? 1000 : 100_000 });
      if (anchor === 'older process') h.marks.delete(22);
      expect(
        await h.driver.closeScopes([{ sessionId: 'ses_old', scopeId, sinceAgeMs: 10_000 }]),
      ).toMatchObject([{ cleanup: { outcome: 'clean' } }]);
      expect(h.signal).not.toHaveBeenCalledWith(21, expect.anything());
      expect(h.signal).not.toHaveBeenCalledWith(22, expect.anything());
    },
  );
  it('ignores older unreadable processes when verifying an unknown scope after restart', async () => {
    const h = harness(100_000);
    const scopeId = 'scp_0000000000000001';
    h.add(20, scopeId, { startedAt: 1000 });
    h.marks.delete(20);
    expect(await h.driver.closeScopes([{ sessionId: 'ses_old', scopeId, sinceAgeMs: 10_000 }])).toMatchObject(
      [{ cleanup: { outcome: 'clean' } }],
    );
    expect(h.signal).not.toHaveBeenCalled();
  });
  it('keeps unreadable recovery candidates unverified when an older server sends no age', async () => {
    const h = harness(100_000);
    const scopeId = 'scp_0000000000000001';
    h.add(20, scopeId, { startedAt: 1000 });
    h.add(21, scopeId, { ppid: 20, startedAt: 1000 });
    h.marks.delete(21);
    expect(await h.driver.closeScopes([{ sessionId: 'ses_old', scopeId }])).toMatchObject([
      { cleanup: { outcome: 'unverified' } },
    ]);
    expect(h.signal).not.toHaveBeenCalled();
  });
  it.each([100_000, 1_000_000_000])('uses the age bound on engine clock %s', async (now) => {
    const h = harness(now);
    const scopeId = 'scp_0000000000000001';
    h.add(20, scopeId, { startedAt: now - 10_000 - 60_000 - 1 });
    h.marks.delete(20);
    expect(await h.driver.closeScopes([{ sessionId: 'ses_old', scopeId, sinceAgeMs: 10_000 }])).toMatchObject(
      [{ cleanup: { outcome: 'clean' } }],
    );
    h.setList([]);
    h.add(20, scopeId);
    h.add(21, scopeId, { ppid: 20 });
    h.marks.delete(21);
    expect(await h.driver.closeScopes([{ sessionId: 'ses_old', scopeId, sinceAgeMs: 10_000 }])).toMatchObject(
      [{ cleanup: { outcome: 'unverified' } }],
    );
  });
  it('rechecks each individual pid before signalling without rereading every candidate environment', async () => {
    const h = harness();
    const scope = await h.driver.open('ses_a');
    h.add(20, scope.scopeId);
    h.add(21, scope.scopeId);
    h.signal.mockImplementation((pid) => {
      if (pid === 20)
        h.setList(
          h
            .list()!
            .filter((p) => p.pid === 21)
            .map((p) => ({ ...p, startedAt: 11_000 })),
        );
    });
    expect(await scope.close('stop', { force: false })).toMatchObject({ outcome: 'clean' });
    expect(h.signal).toHaveBeenCalledWith(20, 'SIGTERM');
    expect(h.signal).not.toHaveBeenCalledWith(21, expect.anything());
    expect(h.list()?.[0]?.startedAt).toBe(11_000);
  });
  it('still closes a marked older generation even when the requested lower bound is newer', async () => {
    const h = harness(100_000);
    const scopeId = 'scp_0000000000000001';
    h.add(20, scopeId, { startedAt: 1000 });
    expect(await h.driver.closeScopes([{ sessionId: 'ses_old', scopeId, sinceAgeMs: 10_000 }])).toMatchObject(
      [{ cleanup: { outcome: 'clean', killed: true } }],
    );
    expect(h.signal).toHaveBeenCalledWith(20, 'SIGKILL');
  });
});
