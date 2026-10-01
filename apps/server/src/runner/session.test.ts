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
