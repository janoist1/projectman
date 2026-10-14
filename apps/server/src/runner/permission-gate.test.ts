import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionBroker, PermissionDecision, PermissionRequestInfo } from '../contracts';
import type { HookPayload } from './hook-payload';
import { PermissionGate, type PermissionGateOptions } from './permission-gate';
import { silentLogger } from './test-helpers';

const TIMEOUT_MS = 60_000;

const bash = (command: string): HookPayload => ({
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command },
});

/**
 * A broker whose decisions the test gives by hand. Like the inbox, it stops waiting (with a
 * denial) once the request is aborted, even when it arrives aborted.
 */
function manualBroker() {
  const requests: Array<{
    info: PermissionRequestInfo;
    signal: AbortSignal;
    resolve(decision: PermissionDecision): void;
    reject(err: Error): void;
  }> = [];
  const broker: PermissionBroker = {
    decide: (info, signal) =>
      new Promise((resolve, reject) => {
        requests.push({ info, signal, resolve, reject });
        const onAbort = () => resolve({ behavior: 'deny', message: 'expired' });
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }),
  };
  return { broker, requests };
}

function setup(overrides: Partial<PermissionGateOptions> = {}) {
  const { broker, requests } = manualBroker();
  const events: string[] = [];
  const gate = new PermissionGate({
    sessionId: 'ses_1',
    broker,
    timeoutMs: TIMEOUT_MS,
    logger: silentLogger(),
    remembersSessionAllows: false,
    answer: (decision) => ({ answer: decision }),
    deny: (message) => ({ deny: message }),
    onWaiting: (activity) => events.push(`waiting ${activity}`),
    onSettled: (pending) => events.push(`settled ${pending}`),
    ...overrides,
  });
  return { gate, requests, events };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('PermissionGate', () => {
  it.each(['decision', 'timeout', 'withdrawn', 'close'] as const)(
    'cleans up all timers after %s',
    async (end) => {
      const { gate, requests, events } = setup();
      const withdrawn = new AbortController();
      const answer = gate.request(bash('a'), 'a', withdrawn.signal);
      // The inline scheduler starts the broker in the request's call stack.
      expect(requests).toHaveLength(1);
      expect(events).toEqual(['waiting a']);
      if (end === 'decision') requests[0]!.resolve({ behavior: 'allow' });
      if (end === 'timeout') await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      if (end === 'withdrawn') withdrawn.abort();
      if (end === 'close') {
        gate.close();
        expect(requests[0]!.signal.aborted).toBe(true);
      }
      await answer;
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(gate.pending).toBe(0);
    },
  );

  it.each(['timeout', 'withdrawn', 'close'] as const)(
    'settles after %s when the broker ignores abort',
    async (end) => {
      let signal!: AbortSignal;
      const { gate } = setup({
        broker: {
          decide: (_info, brokerSignal) => {
            signal = brokerSignal;
            return new Promise(() => {});
          },
        },
      });
      const withdrawn = new AbortController();
      const answer = gate.request(bash('a'), 'a', withdrawn.signal);
      if (end === 'timeout') await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      if (end === 'withdrawn') withdrawn.abort();
      if (end === 'close') gate.close();
      if (end === 'timeout')
        await expect(answer).resolves.toEqual({ deny: expect.stringContaining('No human answered') });
      else await expect(answer).resolves.toBeNull();
      expect(signal.aborted).toBe(true);
      expect(gate.pending).toBe(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('ignores a late decision after close without reporting allow or deny', async () => {
    const onAllowed = vi.fn();
    const onDenied = vi.fn();
    const answerHook = vi.fn();
    const { gate, requests, events } = setup({ onDenied, answer: answerHook });
    const answer = gate.request(bash('a'), 'a', new AbortController().signal, { onAllowed });
    gate.close();
    requests[0]!.resolve({ behavior: 'allow', rememberForSession: true });
    await expect(answer).resolves.toBeNull();
    expect(onAllowed).not.toHaveBeenCalled();
    expect(onDenied).not.toHaveBeenCalled();
    expect(answerHook).not.toHaveBeenCalled();
    expect(events).toEqual(['waiting a', 'settled 0']);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('answers with the decision of the broker', async () => {
    const { gate, requests, events } = setup();
    const answer = gate.request(bash('git push'), 'Bash: git push', new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(requests[0]!.info).toMatchObject({
      sessionId: 'ses_1',
      toolName: 'Bash',
      toolInput: { command: 'git push' },
    });
    expect(gate.pending).toBe(1);
    requests[0]!.resolve({ behavior: 'allow' });
    await expect(answer).resolves.toEqual({ answer: { behavior: 'allow' } });
    expect(events).toEqual(['waiting Bash: git push', 'settled 0']);
  });

  it('denies a request nobody answered within the permission timeout', async () => {
    const { gate, requests, events } = setup();
    const answer = gate.request(bash('git push'), 'Bash: git push', new AbortController().signal);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(requests[0]!.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(answer).resolves.toEqual({ deny: expect.stringContaining('No human answered') });
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(events).toEqual(['waiting Bash: git push', 'settled 0']);
  });

  it('gives no answer once the CLI stopped waiting or the session exited', async () => {
    const { gate, requests } = setup();
    const withdrawn = new AbortController();
    const first = gate.request(bash('a'), 'a', withdrawn.signal);
    const second = gate.request(bash('b'), 'b', new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    withdrawn.abort();
    await expect(first).resolves.toBeNull();
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(gate.pending).toBe(1);
    gate.close();
    await expect(second).resolves.toBeNull();
    expect(requests[1]!.signal.aborted).toBe(true);
    // An already withdrawn request never reaches a human.
    const late = gate.request(bash('c'), 'c', AbortSignal.abort());
    await expect(late).resolves.toBeNull();
  });

  it('denies when the broker fails', async () => {
    const { gate, requests } = setup();
    const answer = gate.request(bash('a'), 'a', new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    requests[0]!.reject(new Error('inbox unavailable'));
    await expect(answer).resolves.toEqual({ deny: expect.stringContaining('could not be processed') });
  });

  it('remembers "allow for this session" when the CLI cannot', async () => {
    const { gate, requests } = setup({ remembersSessionAllows: true });
    const first = gate.request(bash('npm test'), 'npm test', new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    requests[0]!.resolve({ behavior: 'allow', rememberForSession: true });
    await first;
    // The same command is allowed without asking; another one is asked.
    await expect(gate.request(bash('npm test'), 'npm test', new AbortController().signal)).resolves.toEqual({
      answer: { behavior: 'allow' },
    });
    expect(requests).toHaveLength(1);
    void gate.request(bash('npm run lint'), 'npm run lint', new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(2);
  });

  it('leaves remembering to the CLI when it can', async () => {
    const { gate, requests } = setup({ remembersSessionAllows: false });
    const first = gate.request(bash('npm test'), 'npm test', new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    requests[0]!.resolve({ behavior: 'allow', rememberForSession: true });
    await first;
    void gate.request(bash('npm test'), 'npm test', new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(2);
  });
});
