import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputQueue, type InputQueueHost } from './input-queue';
import { silentLogger } from './test-helpers';
import { ENTER_KEY, PASTE_END, PASTE_START } from './typing';

const timing = {
  stepDelayMs: 10,
  enterDelayMs: 100,
  enterRetryMs: 1_000,
  maxEnterRetries: 2,
  submitTimeoutMs: 5_000,
};

function setup(overrides: Partial<InputQueueHost> = {}) {
  const writes: string[] = [];
  const state = { idle: true, check: 0 as number | null };
  const warn = vi.fn();
  const host: InputQueueHost = {
    sessionId: 'ses_1',
    timing,
    logger: { ...silentLogger(), warn } as unknown as InputQueueHost['logger'],
    isIdle: () => state.idle,
    checkBeforeTyping: () => state.check,
    write: (data) => writes.push(data),
    ...overrides,
  };
  const queue = new InputQueue(host);
  /** The pastes typed so far, e.g. ["hello"], and the number of Enter presses. */
  const typed = () => ({
    pastes: writes.filter((w) => w.startsWith(PASTE_START)).map((w) => w.slice(6, -PASTE_END.length)),
    enters: writes.filter((w) => w === ENTER_KEY).length,
  });
  return { queue, state, typed, warn };
}

/** Time to type a one-piece message and press Enter. */
const TYPE_MS = timing.stepDelayMs + timing.enterDelayMs;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('InputQueue', () => {
  it('holds messages while the session is busy and types them in order once idle', async () => {
    const { queue, state, typed } = setup();
    state.idle = false;
    const first = queue.enqueue('first');
    const second = queue.enqueue('second');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(typed()).toEqual({ pastes: [], enters: 0 });
    expect(queue.length).toBe(2);

    state.idle = true;
    queue.pump();
    await vi.advanceTimersByTimeAsync(TYPE_MS);
    await expect(first).resolves.toBeUndefined();
    expect(typed()).toEqual({ pastes: ['first'], enters: 1 });
    expect(queue.isAwaitingSubmit).toBe(true);

    // The second message waits until the CLI reports the first prompt.
    queue.pump();
    await vi.advanceTimersByTimeAsync(TYPE_MS);
    expect(typed().pastes).toEqual(['first']);
    queue.submitted();
    queue.pump();
    await vi.advanceTimersByTimeAsync(TYPE_MS);
    await expect(second).resolves.toBeUndefined();
    expect(typed()).toEqual({ pastes: ['first', 'second'], enters: 2 });
  });

  it('waits out a scheduled settle delay before typing', async () => {
    const { queue, typed } = setup();
    queue.schedule(400);
    void queue.enqueue('hello');
    await vi.advanceTimersByTimeAsync(399);
    expect(typed().pastes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1 + TYPE_MS);
    expect(typed()).toEqual({ pastes: ['hello'], enters: 1 });
  });

  it('asks the session right before typing: hold, or check again later', async () => {
    const { queue, state, typed } = setup();
    state.check = null; // e.g. a dialog covers the prompt
    void queue.enqueue('hello');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(typed().pastes).toEqual([]);

    state.check = 100; // e.g. bracketed paste is not on yet
    queue.pump();
    await vi.advanceTimersByTimeAsync(50);
    state.check = 0;
    await vi.advanceTimersByTimeAsync(50 + TYPE_MS);
    expect(typed().pastes).toEqual(['hello']);
  });

  it('presses Enter again while the prompt is not reported, at most maxEnterRetries times', async () => {
    const { queue, typed } = setup();
    void queue.enqueue('hello');
    await vi.advanceTimersByTimeAsync(TYPE_MS);
    expect(typed().enters).toBe(1);
    await vi.advanceTimersByTimeAsync(timing.enterRetryMs);
    expect(typed().enters).toBe(2);
    await vi.advanceTimersByTimeAsync(timing.enterRetryMs * 3);
    expect(typed().enters).toBe(1 + timing.maxEnterRetries);
  });

  it('does not press Enter again once the prompt is reported, while busy, or for a slash command', async () => {
    const reported = setup();
    void reported.queue.enqueue('hello');
    await vi.advanceTimersByTimeAsync(TYPE_MS);
    reported.queue.submitted();
    await vi.advanceTimersByTimeAsync(timing.enterRetryMs * 3);
    expect(reported.typed().enters).toBe(1);

    const busy = setup();
    void busy.queue.enqueue('hello');
    await vi.advanceTimersByTimeAsync(TYPE_MS);
    busy.state.idle = false;
    await vi.advanceTimersByTimeAsync(timing.enterRetryMs * 3);
    expect(busy.typed().enters).toBe(1);

    const command = setup();
    void command.queue.enqueue('/compact');
    await vi.advanceTimersByTimeAsync(TYPE_MS);
    await vi.advanceTimersByTimeAsync(timing.enterRetryMs * 3);
    expect(command.typed().enters).toBe(1);
  });

  it('stops waiting for an unreported prompt after the submit timeout and types the next message', async () => {
    const { queue, typed, warn } = setup();
    void queue.enqueue('/model');
    void queue.enqueue('next');
    await vi.advanceTimersByTimeAsync(TYPE_MS);
    expect(typed().pastes).toEqual(['/model']);
    await vi.advanceTimersByTimeAsync(timing.submitTimeoutMs - timing.enterRetryMs);
    expect(typed().pastes).toEqual(['/model']);
    await vi.advanceTimersByTimeAsync(timing.enterRetryMs + TYPE_MS);
    expect(typed().pastes).toEqual(['/model', 'next']);
    expect(warn).toHaveBeenCalledWith(
      { sessionId: 'ses_1', enterRetries: 0, waitMs: timing.submitTimeoutMs, command: true, idle: true },
      'typed message was not reported as submitted',
    );
  });

  it('logs submission timeout diagnostics after swallowed Enter retries without logging the message', async () => {
    const describeStall = vi.fn(() => ({ promptSeen: false, resumed: true, blockingScreen: null }));
    const { queue, typed, warn } = setup({ describeStall });
    const text = 'A private request that never submits';
    const sent = queue.enqueue(text);
    await vi.advanceTimersByTimeAsync(TYPE_MS);
    await expect(sent).resolves.toBeUndefined();
    expect(describeStall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(timing.submitTimeoutMs);
    expect(typed()).toEqual({ pastes: [text], enters: 1 + timing.maxEnterRetries });
    expect(describeStall).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      {
        sessionId: 'ses_1',
        enterRetries: timing.maxEnterRetries,
        waitMs: timing.submitTimeoutMs,
        command: false,
        idle: true,
        promptSeen: false,
        resumed: true,
        blockingScreen: null,
      },
      'typed message was not reported as submitted',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(text);
    expect(queue.hasPending).toBe(false);
  });

  it('types nothing before a prompt given on the command line is reported, or times out', async () => {
    const { queue, typed } = setup();
    queue.awaitCommandLinePrompt(30_000);
    void queue.enqueue('later');
    await vi.advanceTimersByTimeAsync(29_000);
    expect(typed()).toEqual({ pastes: [], enters: 0 });
    await vi.advanceTimersByTimeAsync(1_000 + TYPE_MS);
    expect(typed()).toEqual({ pastes: ['later'], enters: 1 });
  });

  it('rejects queued and half-typed messages when closed, and new ones afterwards', async () => {
    const { queue, state, typed } = setup();
    const long = expect(queue.enqueue('a\nb')).rejects.toThrow(
      'Session ses_1 exited before the message was typed',
    );
    state.idle = false;
    const queued = expect(queue.enqueue('queued')).rejects.toThrow(
      'Session ses_1 exited before the message was typed',
    );
    await vi.advanceTimersByTimeAsync(timing.stepDelayMs / 2);
    queue.close();
    await vi.advanceTimersByTimeAsync(1_000);
    await long;
    await queued;
    await expect(queue.enqueue('late')).rejects.toThrow('Session ses_1 is not running');
    expect(typed()).toEqual({ pastes: ['a'], enters: 0 });
  });

  describe('hold (PM-218)', () => {
    it('types nothing new while held, and counts what waits as pending', async () => {
      const { queue, typed } = setup();
      queue.hold();
      void queue.enqueue('waiting');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(typed()).toEqual({ pastes: [], enters: 0 });
      expect(queue.hasPending).toBe(true);
      expect(queue.length).toBe(1);

      queue.unhold();
      await vi.advanceTimersByTimeAsync(TYPE_MS);
      expect(typed()).toEqual({ pastes: ['waiting'], enters: 1 });
    });

    it('lets a message that is being typed finish, with its Enter and the Enter repeats', async () => {
      const onChange = vi.fn();
      const { queue, typed, state } = setup({ onChange });
      const typing = queue.enqueue('in flight');
      void queue.enqueue('later');
      await vi.advanceTimersByTimeAsync(timing.stepDelayMs / 2);
      expect(queue.isTyping).toBe(true);
      queue.hold();
      await vi.advanceTimersByTimeAsync(TYPE_MS);
      await typing;
      expect(queue.isTyping).toBe(false);
      expect(typed()).toEqual({ pastes: ['in flight'], enters: 1 });
      expect(onChange).toHaveBeenCalledTimes(1);

      // The CLI stays idle: Enter is pressed again, and nothing else is typed.
      state.idle = true;
      await vi.advanceTimersByTimeAsync(timing.enterRetryMs);
      expect(typed().enters).toBe(2);
      expect(typed().pastes).toEqual(['in flight']);
    });

    it('queues the first message ahead of the waiting ones on unhold', async () => {
      const { queue, typed } = setup();
      queue.hold();
      void queue.enqueue('waiting');
      queue.unhold('Carry on.');
      await vi.advanceTimersByTimeAsync(TYPE_MS);
      expect(typed().pastes).toEqual(['Carry on.']);
      queue.submitted();
      queue.pump();
      await vi.advanceTimersByTimeAsync(TYPE_MS);
      expect(typed().pastes).toEqual(['Carry on.', 'waiting']);
    });

    it('ignores a blank first message, and reports the end of a submission nobody confirmed', async () => {
      const onChange = vi.fn();
      const { queue, typed } = setup({ onChange });
      queue.hold();
      queue.unhold('  ');
      expect(queue.length).toBe(0);
      queue.unhold();
      void queue.enqueue('one');
      await vi.advanceTimersByTimeAsync(TYPE_MS);
      expect(typed().pastes).toEqual(['one']);
      onChange.mockClear();
      await vi.advanceTimersByTimeAsync(timing.submitTimeoutMs);
      expect(queue.isAwaitingSubmit).toBe(false);
      expect(onChange).toHaveBeenCalled();
    });
  });

  it('resolves a message that is empty once sanitised without typing anything', async () => {
    const { queue, typed } = setup();
    await expect(queue.enqueue(' \u001b ')).resolves.toBeUndefined();
    expect(typed()).toEqual({ pastes: [], enters: 0 });
    expect(queue.isAwaitingSubmit).toBe(false);
  });
});
