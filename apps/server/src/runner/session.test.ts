import type { SessionState } from '@projectman/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionBroker, RunnerEvent, StartSessionSpec } from '../contracts';
import type { HookPayload } from './hook-payload';
import { CLAUDE_TIMING, createClaudeAdapter } from './providers/claude';
import { CODEX_TIMING, createCodexAdapter } from './providers/codex';
import type { ProviderAdapter } from './providers/types';
import { AgentSession, type PtyProcess, type PtySpawnOptions } from './session';
import { silentLogger } from './test-helpers';
import { ENTER_KEY, PASTE_END, PASTE_START } from './typing';

/**
 * Fast unit tests of the session with a fake pseudo-terminal and fake timers. The PTY
 * integration tests (runner.integration.test.ts, codex.integration.test.ts) drive the fake
 * CLIs through the same paths end to end.
 */

class FakePty implements PtyProcess {
  readonly pid = 4242;
  readonly writes: string[] = [];
  readonly signals: string[] = [];
  private readonly dataListeners: Array<(data: string) => void> = [];
  private readonly exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = [];

  write(data: string): void {
    this.writes.push(data);
  }
  resize(): void {}
  kill(signal?: string): void {
    this.signals.push(signal ?? 'SIGHUP');
  }
  onData(listener: (data: string) => void): void {
    this.dataListeners.push(listener);
  }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void {
    this.exitListeners.push(listener);
  }
  print(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }
  exit(exitCode = 0): void {
    for (const listener of this.exitListeners) listener({ exitCode });
  }
  /** The pastes typed so far and the number of Enter presses. */
  typed(): { pastes: string[]; enters: number } {
    return {
      pastes: this.writes.filter((w) => w.startsWith(PASTE_START)).map((w) => w.slice(6, -PASTE_END.length)),
      enters: this.writes.filter((w) => w === ENTER_KEY).length,
    };
  }
}

const PERMISSION_TIMEOUT_MS = 60_000;
/** Time to type a one-piece message and press Enter. */
const TYPE_MS = CLAUDE_TIMING.stepDelayMs + CLAUDE_TIMING.enterDelayMs;

const spec: StartSessionSpec = {
  sessionId: 'ses_1',
  claudeSessionId: '0b8a3c2e-1f5d-4c4e-9a7b-2d6e8f1a3b5c',
  resume: false,
  cwd: '/work',
  displayName: 'Anna · fe-1',
  appendSystemPrompt: '',
  mcpUrl: 'http://127.0.0.1:4700/mcp/tok',
  allowedTools: [],
};

const sessions: AgentSession[] = [];

function start(
  opts: {
    broker?: PermissionBroker;
    adapter?: ProviderAdapter;
    spec?: Partial<StartSessionSpec>;
    /** The launch put the initial message on the command line (Codex). */
    initialMessageSent?: boolean;
  } = {},
) {
  const pty = new FakePty();
  const spawned: Array<{ file: string; args: string[]; options: PtySpawnOptions }> = [];
  const events: RunnerEvent[] = [];
  const session = new AgentSession({
    spec: { ...spec, ...opts.spec },
    hookToken: 'tok',
    adapter: opts.adapter ?? createClaudeAdapter({ bin: 'claude', logger: silentLogger() }),
    initialMessageSent: opts.initialMessageSent,
    deps: {
      logger: silentLogger(),
      broker: opts.broker ?? { decide: () => new Promise(() => undefined) },
      permissionTimeoutMs: PERMISSION_TIMEOUT_MS,
      emit: (event) => events.push(event),
      onExited: () => undefined,
      spawnPty: (file, args, options) => {
        spawned.push({ file, args, options });
        return pty;
      },
    },
  });
  sessions.push(session);
  session.spawn('claude', ['--session-id', spec.claudeSessionId], { TERM: 'xterm-256color' });
  pty.print('\x1b[?2004h'); // the TUI enables bracketed paste
  const hook = (payload: Omit<HookPayload, 'hook_event_name'> & { hook_event_name: string }) =>
    session.handleHook(payload, new AbortController().signal);
  const states = () =>
    events
      .filter((e): e is Extract<RunnerEvent, { type: 'state' }> => e.type === 'state')
      .map((e) => e.state);
  return { session, pty, spawned, events, hook, states };
}

/** A started session that became ready (first SessionStart) and settled. */
async function ready(opts: Parameters<typeof start>[0] = {}) {
  const started = start(opts);
  await started.hook({ hook_event_name: 'SessionStart', source: 'startup' });
  await vi.advanceTimersByTimeAsync(CLAUDE_TIMING.readySettleMs);
  return started;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  for (const session of sessions.splice(0)) session.dispose();
});

describe('AgentSession', () => {
  it('spawns the CLI in a pseudo-terminal of the session size and directory', () => {
    const { spawned, session, states } = start({ spec: { cols: 100, rows: 30 } });
    expect(spawned).toEqual([
      {
        file: 'claude',
        args: ['--session-id', spec.claudeSessionId],
        options: {
          name: 'xterm-256color',
          cols: 100,
          rows: 30,
          cwd: '/work',
          env: { TERM: 'xterm-256color' },
        },
      },
    ]);
    expect(session.info()).toMatchObject({ pid: 4242, state: 'starting' });
    expect(states()).toEqual<SessionState[]>(['starting']);
  });

  it('types the brief once ready, and queues messages while the CLI is busy', async () => {
    const { session, pty, hook } = start({ spec: { initialMessage: 'Build the login page' } });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pty.typed().pastes).toEqual([]); // not ready yet

    await hook({ hook_event_name: 'SessionStart', source: 'startup' });
    await vi.advanceTimersByTimeAsync(CLAUDE_TIMING.readySettleMs - 1);
    expect(pty.typed().pastes).toEqual([]); // the prompt box is still mounting
    await vi.advanceTimersByTimeAsync(1 + TYPE_MS);
    expect(pty.typed()).toEqual({ pastes: ['Build the login page'], enters: 1 });

    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Build the login page' });
    expect(session.state.state).toBe('working');
    const typed = session.enqueue('And add a test');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pty.typed().pastes).toEqual(['Build the login page']);

    await hook({ hook_event_name: 'Stop' });
    expect(session.state.state).toBe('idle');
    await vi.advanceTimersByTimeAsync(CLAUDE_TIMING.stopSettleMs + TYPE_MS);
    await expect(typed).resolves.toBeUndefined();
    expect(pty.typed()).toEqual({ pastes: ['Build the login page', 'And add a test'], enters: 2 });
  });

  it('reports the first input only once it is typed (PM-189)', async () => {
    const { events, hook } = start({ spec: { initialMessage: 'Build the login page' } });
    const sent = () => events.filter((e) => e.type === 'first_input_sent');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent()).toEqual([]);
    await hook({ hook_event_name: 'SessionStart', source: 'startup' });
    await vi.advanceTimersByTimeAsync(CLAUDE_TIMING.readySettleMs - 1);
    expect(sent()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1 + TYPE_MS);
    expect(sent()).toEqual([{ type: 'first_input_sent', sessionId: 'ses_1' }]);
  });

  it('never reports the first input of a process that ends before the prompt is up (PM-189)', async () => {
    const { events, pty } = start({ spec: { initialMessage: 'Build the login page' } });
    await vi.advanceTimersByTimeAsync(5_000);
    pty.exit(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events.map((e) => e.type)).toContain('exit');
    expect(events.map((e) => e.type)).not.toContain('first_input_sent');
  });

  it('presses Enter again when the CLI does not report the prompt', async () => {
    const { session, pty, hook } = await ready();
    void session.enqueue('hello');
    await vi.advanceTimersByTimeAsync(TYPE_MS);
    expect(pty.typed().enters).toBe(1);
    await vi.advanceTimersByTimeAsync(CLAUDE_TIMING.enterRetryMs);
    expect(pty.typed().enters).toBe(2);
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'hello' });
    await vi.advanceTimersByTimeAsync(CLAUDE_TIMING.enterRetryMs * 3);
    expect(pty.typed().enters).toBe(2);
  });

  it('moves on to the next message when a typed one is never reported as submitted', async () => {
    const { session, pty } = await ready();
    void session.enqueue('/compact');
    void session.enqueue('next');
    await vi.advanceTimersByTimeAsync(TYPE_MS);
    expect(pty.typed().pastes).toEqual(['/compact']);
    // The submission is checked every enterRetryMs; the first check past the timeout gives up.
    const { enterRetryMs, submitTimeoutMs } = CLAUDE_TIMING;
    const givesUpAfter = Math.ceil(submitTimeoutMs / enterRetryMs) * enterRetryMs;
    await vi.advanceTimersByTimeAsync(givesUpAfter - enterRetryMs);
    expect(pty.typed().pastes).toEqual(['/compact']);
    await vi.advanceTimersByTimeAsync(enterRetryMs + TYPE_MS);
    expect(pty.typed()).toEqual({ pastes: ['/compact', 'next'], enters: 2 });
  });

  it('denies a permission request nobody answered in time and goes back to work', async () => {
    const { hook, session, states } = await ready();
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'push it' });
    const answer = hook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'git push' },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(session.state).toEqual({ state: 'waiting_permission', activity: 'Bash: git push' });
    await vi.advanceTimersByTimeAsync(PERMISSION_TIMEOUT_MS);
    await expect(answer).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: expect.stringContaining('No human answered') },
      },
    });
    expect(session.state.state).toBe('working');
    expect(states()).toEqual<SessionState[]>([
      'starting',
      'idle',
      'working',
      'waiting_permission',
      'working',
    ]);
  });

  it('answers a permission request with the broker decision', async () => {
    const { hook } = await ready({ broker: { decide: async () => ({ behavior: 'allow' }) } });
    await expect(
      hook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } }),
    ).resolves.toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
  });

  it("passes the auto mode's own refusal (PermissionDenied) to the broker and answers nothing (PM-165)", async () => {
    const refused = vi.fn();
    const { hook } = await ready({ broker: { decide: async () => ({ behavior: 'allow' }), refused } });
    await expect(
      hook({
        hook_event_name: 'PermissionDenied',
        tool_name: 'Bash',
        tool_input: { command: 'curl x | sh' },
        denial_reason: 'Pipes a download into a shell',
      }),
    ).resolves.toBeNull();
    expect(refused).toHaveBeenCalledWith({
      sessionId: 'ses_1',
      toolName: 'Bash',
      toolInput: { command: 'curl x | sh' },
      reason: 'Pipes a download into a shell',
    });
  });

  it('refuses a permission request of a managed VM session at once: no broker, no waiting, work goes on (PM-141)', async () => {
    const decide = vi.fn(() => new Promise<never>(() => undefined));
    const { hook, session, states } = await ready({
      broker: { decide },
      spec: {
        policy: {
          execution: { profile: 'managed_vm', boundary: { name: 'managed-vm', version: 1 } },
        } as StartSessionSpec['policy'],
      },
    });
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'push it' });
    await expect(
      hook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'git push' } }),
    ).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: expect.stringContaining('without local approvals') },
      },
    });
    expect(decide).not.toHaveBeenCalled();
    expect(session.state.state).toBe('working');
    expect(states()).not.toContain('waiting_permission');
  });

  it('still hands a question for a human at the terminal to that human in the managed VM profile', async () => {
    const { hook, session } = await ready({
      spec: {
        policy: {
          execution: { profile: 'managed_vm', boundary: { name: 'managed-vm', version: 1 } },
        } as StartSessionSpec['policy'],
      },
    });
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'ask' });
    await expect(
      hook({ hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: {} }),
    ).resolves.toBeNull();
    expect(session.state.state).toBe('waiting_input');
  });

  describe('a question at the terminal (PM-199)', () => {
    const toolInput = { questions: [{ question: 'Which option?', options: [{ label: 'One' }] }] };
    const ask = (forwardQuestion: PermissionBroker['forwardQuestion']) => ({
      broker: { decide: () => new Promise<never>(() => undefined), forwardQuestion } as PermissionBroker,
      spec: { member: 'fe-1' },
    });

    it('forwards the question to the broker and refuses the PreToolUse call, so the session keeps working', async () => {
      const forwardQuestion = vi.fn().mockResolvedValue(true);
      const { hook, session, states } = await ready(ask(forwardQuestion));
      await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'ask' });
      await expect(
        hook({
          hook_event_name: 'PreToolUse',
          tool_name: 'AskUserQuestion',
          tool_input: toolInput,
          tool_use_id: 'toolu_1',
        }),
      ).resolves.toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: expect.stringContaining('team inbox'),
        },
      });
      expect(forwardQuestion).toHaveBeenCalledWith({
        sessionId: 'ses_1',
        toolName: 'AskUserQuestion',
        toolInput,
      });
      expect(session.state.state).toBe('working');
      expect(states()).not.toContain('waiting_input');
    });

    it('refuses a PermissionRequest for the same call without asking the broker twice', async () => {
      const forwardQuestion = vi.fn().mockResolvedValue(true);
      const { hook } = await ready(ask(forwardQuestion));
      await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'ask' });
      const call = { tool_name: 'AskUserQuestion', tool_input: toolInput, tool_use_id: 'toolu_1' };
      await hook({ hook_event_name: 'PreToolUse', ...call });
      await expect(hook({ hook_event_name: 'PermissionRequest', ...call })).resolves.toEqual({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'deny', message: expect.stringContaining('team inbox') },
        },
      });
      expect(forwardQuestion).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['the broker cannot take the question', vi.fn().mockResolvedValue(false)],
      ['the broker fails', vi.fn().mockRejectedValue(new Error('boom'))],
    ])('leaves the question to the terminal when %s', async (_name, forwardQuestion) => {
      const { hook, session } = await ready(ask(forwardQuestion));
      await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'ask' });
      await expect(
        hook({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: toolInput }),
      ).resolves.toBeNull();
      expect(session.state.state).toBe('waiting_input');
    });

    it('leaves the question to the terminal in a session without a member', async () => {
      const forwardQuestion = vi.fn().mockResolvedValue(true);
      const { hook, session } = await ready({ ...ask(forwardQuestion), spec: {} });
      await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'ask' });
      await hook({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: toolInput });
      expect(forwardQuestion).not.toHaveBeenCalled();
      expect(session.state.state).toBe('waiting_input');
    });

    it('does not forward Codex questions: its adapter has no refusal answer', () => {
      const adapter = createCodexAdapter({ bin: 'codex', codexHome: '/nonexistent', logger: silentLogger() });
      expect(adapter.refuseQuestionOutput).toBeUndefined();
    });
  });

  it('rejects queued messages and ends pending permission requests when the process exits', async () => {
    const { session, pty, hook } = await ready();
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'work' });
    const queued = expect(session.enqueue('later')).rejects.toThrow('exited before the message was typed');
    const permission = hook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} });
    await vi.advanceTimersByTimeAsync(0);
    const stopped = session.stop();
    expect(pty.signals).toEqual(['SIGTERM']);
    pty.exit(0);
    await vi.advanceTimersByTimeAsync(0);
    await stopped;
    await queued;
    await expect(permission).resolves.toBeNull();
    expect(session.state.state).toBe('exited');
    await expect(session.enqueue('too late')).rejects.toThrow('is not running');
  });
});

describe('compaction (PM-213)', () => {
  const INSTRUCTION = 'Keep the card,\nthe decisions and the open bugs.';
  const compactions = (events: RunnerEvent[]) =>
    events
      .filter((e): e is Extract<RunnerEvent, { type: 'compaction' }> => e.type === 'compaction')
      .map((e) => `${e.phase}${e.requested ? ' (asked for)' : ''}`);

  it('types the command with the instruction into an idle session, and holds messages back while it runs', async () => {
    const { session, pty, hook, events } = await ready();
    const typed = session.compact(INSTRUCTION);
    const later = session.enqueue('a message that must wait');
    await vi.advanceTimersByTimeAsync(TYPE_MS);
    await expect(typed).resolves.toBe(true);
    expect(pty.typed().pastes).toEqual(['/compact Keep the card, the decisions and the open bugs.']);

    await hook({ hook_event_name: 'PreCompact', trigger: 'manual' });
    expect(session.state).toEqual({ state: 'working', activity: 'Compacting the conversation' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pty.typed().pastes).toHaveLength(1);

    await hook({ hook_event_name: 'PostCompact', trigger: 'manual' });
    expect(session.state).toEqual({ state: 'idle', activity: null });
    await vi.advanceTimersByTimeAsync(CLAUDE_TIMING.stopSettleMs + TYPE_MS);
    await expect(later).resolves.toBeUndefined();
    expect(pty.typed().pastes[1]).toBe('a message that must wait');
    expect(compactions(events)).toEqual(['started (asked for)', 'finished (asked for)']);
  });

  it('types the messages that were queued before it first', async () => {
    const { session, pty, hook } = await ready();
    void session.enqueue('first');
    void session.compact(INSTRUCTION);
    await vi.advanceTimersByTimeAsync(TYPE_MS);
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'first' });
    await hook({ hook_event_name: 'Stop' });
    await vi.advanceTimersByTimeAsync(CLAUDE_TIMING.stopSettleMs + TYPE_MS);
    expect(pty.typed().pastes.map((p) => p.split(' ')[0])).toEqual(['first', '/compact']);
  });

  it('gives it up when the command never starts, and takes messages again', async () => {
    const { session, pty, events } = await ready();
    void session.compact(INSTRUCTION);
    await vi.advanceTimersByTimeAsync(TYPE_MS);
    const later = session.enqueue('after the swallowed command');
    await vi.advanceTimersByTimeAsync(CLAUDE_TIMING.compactStartTimeoutMs + CLAUDE_TIMING.enterRetryMs);
    expect(compactions(events)).toEqual(['abandoned (asked for)']);
    expect(session.state.state).toBe('idle');
    await vi.advanceTimersByTimeAsync(CLAUDE_TIMING.stopSettleMs + TYPE_MS);
    await expect(later).resolves.toBeUndefined();
    expect(pty.typed().pastes[1]).toBe('after the swallowed command');
  });

  it('holds the queue back behind a swallowed command, so a message cannot start a turn the give-up ends', async () => {
    const { session, pty, hook, events } = await ready();
    void session.compact(INSTRUCTION);
    await vi.advanceTimersByTimeAsync(TYPE_MS);
    const later = session.enqueue('queued behind the swallowed command');
    // Past the submit timeout (8 s) the queue would move on by itself: the compaction still holds it.
    await vi.advanceTimersByTimeAsync(CLAUDE_TIMING.submitTimeoutMs + CLAUDE_TIMING.enterRetryMs);
    expect(pty.typed().pastes).toHaveLength(1);
    // A prompt that got through by other means (a person typed it) makes the session work: the
    // give-up must leave it so.
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'typed by a person' });
    expect(session.state.state).toBe('working');
    await vi.advanceTimersByTimeAsync(CLAUDE_TIMING.compactStartTimeoutMs);
    expect(compactions(events)).toEqual(['abandoned (asked for)']);
    expect(session.state.state).toBe('working');
    // The queued message waits for the end of that turn, as any message does.
    expect(pty.typed().pastes).toHaveLength(1);
    await hook({ hook_event_name: 'Stop' });
    await vi.advanceTimersByTimeAsync(CLAUDE_TIMING.stopSettleMs + TYPE_MS);
    await expect(later).resolves.toBeUndefined();
    expect(pty.typed().pastes[1]).toBe('queued behind the swallowed command');
  });

  it("does not take the agent's own compaction for the one that is still queued", async () => {
    const { session, pty, hook, events } = await ready();
    void session.enqueue('first');
    void session.compact(INSTRUCTION);
    await vi.advanceTimersByTimeAsync(TYPE_MS);
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'first' });
    await hook({ hook_event_name: 'PreCompact', trigger: 'auto' });
    await hook({ hook_event_name: 'PostCompact', trigger: 'auto' });
    expect(compactions(events)).toEqual(['started', 'finished']);
    // The command is still to be typed, and is then followed like any other.
    await hook({ hook_event_name: 'Stop' });
    await vi.advanceTimersByTimeAsync(CLAUDE_TIMING.stopSettleMs + TYPE_MS);
    expect(pty.typed().pastes.map((p) => p.split(' ')[0])).toEqual(['first', '/compact']);
    await hook({ hook_event_name: 'PreCompact', trigger: 'manual' });
    await hook({ hook_event_name: 'PostCompact', trigger: 'manual' });
    expect(compactions(events)).toEqual([
      'started',
      'finished',
      'started (asked for)',
      'finished (asked for)',
    ]);
    expect(session.state.state).toBe('idle');
  });

  it('gives it up when it never ends, and the session is idle again', async () => {
    const { session, pty, hook, events } = await ready();
    void session.compact(INSTRUCTION);
    await vi.advanceTimersByTimeAsync(TYPE_MS);
    await hook({ hook_event_name: 'PreCompact', trigger: 'manual' });
    const later = session.enqueue('after the hung compaction');
    await vi.advanceTimersByTimeAsync(CLAUDE_TIMING.compactTimeoutMs - 1);
    expect(session.state.state).toBe('working');
    await vi.advanceTimersByTimeAsync(1);
    expect(session.state.state).toBe('idle');
    expect(compactions(events)).toEqual(['started (asked for)', 'abandoned (asked for)']);
    await vi.advanceTimersByTimeAsync(CLAUDE_TIMING.stopSettleMs + TYPE_MS);
    await expect(later).resolves.toBeUndefined();
    expect(pty.typed().pastes[1]).toBe('after the hung compaction');
  });

  it('asks for one compaction at a time', async () => {
    const { session } = await ready();
    const first = session.compact(INSTRUCTION);
    await expect(session.compact(INSTRUCTION)).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(TYPE_MS);
    await expect(first).resolves.toBe(true);
  });

  it('compacts a resumed conversation before the message that woke it', async () => {
    const { pty, hook, session } = start({
      spec: { resume: true, compactFirst: INSTRUCTION, initialMessage: 'You have a new message' },
    });
    await hook({ hook_event_name: 'SessionStart', source: 'resume' });
    await vi.advanceTimersByTimeAsync(CLAUDE_TIMING.readySettleMs + TYPE_MS);
    expect(pty.typed().pastes).toEqual(['/compact Keep the card, the decisions and the open bugs.']);
    await vi.advanceTimersByTimeAsync(CLAUDE_TIMING.submitTimeoutMs - 1_000);
    await hook({ hook_event_name: 'PreCompact', trigger: 'manual' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pty.typed().pastes).toHaveLength(1);
    await hook({ hook_event_name: 'PostCompact', trigger: 'manual' });
    await vi.advanceTimersByTimeAsync(CLAUDE_TIMING.stopSettleMs + TYPE_MS);
    expect(pty.typed().pastes[1]).toBe('You have a new message');
    expect(session.state.state).toBe('idle');
  });

  it("does not end the turn the agent's own (auto) compaction runs into", async () => {
    const { session, hook, events } = await ready();
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'long work' });
    await hook({ hook_event_name: 'PreCompact', trigger: 'auto' });
    expect(session.state.state).toBe('working');
    await hook({ hook_event_name: 'PostCompact', trigger: 'auto' });
    expect(session.state).toEqual({ state: 'working', activity: null });
    expect(compactions(events)).toEqual(['started', 'finished']);
  });

  it('is not asked of Codex, whose command was not checked', async () => {
    const adapter = createCodexAdapter({ bin: 'codex', codexHome: '/nonexistent', logger: silentLogger() });
    const { session, pty } = start({ adapter });
    await expect(session.compact(INSTRUCTION)).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pty.typed().pastes).toEqual([]);
  });
});

describe('AgentSession of Codex', () => {
  const codex = () => createCodexAdapter({ bin: 'codex', codexHome: '/nonexistent', logger: silentLogger() });
  /** Time to type a one-piece message and press Enter in Codex. */
  const TYPE_CODEX_MS = CODEX_TIMING.stepDelayMs + CODEX_TIMING.enterDelayMs;

  /** A resumed session whose first message is on the command line, on a screen without a composer. */
  function resumedWithPrompt() {
    const started = start({
      adapter: codex(),
      initialMessageSent: true,
      spec: { provider: 'codex', resume: true, initialMessage: 'Your session was restarted.' },
    });
    // History only: Codex has not drawn the composer, or the screen is not one the checks know.
    started.pty.print('\x1b[?2004h› an earlier question\r\n• an earlier answer\r\n');
    return started;
  }

  it('reports its first input as sent when it is started with it on the command line', () => {
    const { events } = resumedWithPrompt();
    expect(events.filter((e) => e.type === 'first_input_sent')).toEqual([
      { type: 'first_input_sent', sessionId: 'ses_1' },
    ]);
  });

  it.each(['startup', 'resume', 'clear'])(
    'becomes ready from its first SessionStart (source %s) and then types what was queued',
    async (source) => {
      const { session, pty, hook, states } = resumedWithPrompt();
      const queued = session.enqueue('A message queued for the restart');
      await vi.advanceTimersByTimeAsync(CODEX_TIMING.startupCheckMs * 4);
      expect(session.state.state).toBe('starting');
      expect(pty.typed().pastes).toEqual([]);

      // The first turn, which the command-line prompt starts, is what says the session runs.
      await hook({ hook_event_name: 'SessionStart', source });
      expect(session.state.state).toBe('idle');
      await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Your session was restarted.' });
      expect(session.state.state).toBe('working');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(pty.typed().pastes).toEqual([]); // typed only once the turn is over

      await hook({ hook_event_name: 'Stop' });
      await vi.advanceTimersByTimeAsync(CODEX_TIMING.stopSettleMs + TYPE_CODEX_MS);
      await expect(queued).resolves.toBeUndefined();
      expect(pty.typed()).toEqual({ pastes: ['A message queued for the restart'], enters: 1 });
      expect(states()).toEqual<SessionState[]>(['starting', 'idle', 'working', 'idle']);
    },
  );

  it('stops flagging a session that has not become ready once its first SessionStart arrives', async () => {
    const { session, hook } = resumedWithPrompt();
    await vi.advanceTimersByTimeAsync(CODEX_TIMING.startupTimeoutMs + CODEX_TIMING.startupCheckMs);
    expect(session.state).toEqual({
      state: 'waiting_input',
      activity: 'Codex has not become ready; check the terminal',
    });
    await hook({ hook_event_name: 'SessionStart', source: 'resume' });
    expect(session.state).toEqual({ state: 'idle', activity: null });
    await vi.advanceTimersByTimeAsync(CODEX_TIMING.startupCheckMs * 4);
    expect(session.state.state).toBe('idle');
  });

  it('is ready for typing as soon as SessionStart arrives, whatever the screen shows', async () => {
    const { session, pty, hook } = start({ adapter: codex(), spec: { provider: 'codex' } });
    pty.print('\x1b[?2004h› an earlier question\r\n• an earlier answer\r\n'); // no composer to recognise
    const queued = session.enqueue('Queued before the session reported anything');
    await vi.advanceTimersByTimeAsync(CODEX_TIMING.startupCheckMs * 4);
    expect(pty.typed().pastes).toEqual([]);

    await hook({ hook_event_name: 'SessionStart', source: 'startup' });
    await vi.advanceTimersByTimeAsync(CODEX_TIMING.readySettleMs + TYPE_CODEX_MS);
    await expect(queued).resolves.toBeUndefined();
    expect(pty.typed().pastes).toEqual(['Queued before the session reported anything']);
  });

  it('becomes ready when the composer shows under a history, without waiting for a hook', async () => {
    const { session, pty } = start({ adapter: codex(), spec: { provider: 'codex', resume: true } });
    const queued = session.enqueue('Hello after the restart');
    pty.print(
      [
        '› an earlier question',
        '• Sign in with ChatGPT is mentioned in the answer.',
        '',
        '› Ask Codex to do anything',
        '',
        '  ? for shortcuts                                              100% context left',
      ].join('\r\n'),
    );
    await vi.advanceTimersByTimeAsync(
      CODEX_TIMING.startupCheckMs + CODEX_TIMING.readySettleMs + TYPE_CODEX_MS,
    );
    await expect(queued).resolves.toBeUndefined();
    expect(pty.typed().pastes).toEqual(['Hello after the restart']);
  });
});
