import { readFileSync } from 'node:fs';
import type { SessionState } from '@projectman/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DependencyGate,
  EngineGuard,
  PermissionBroker,
  PermissionDecision,
  RunnerEvent,
  StartSessionSpec,
} from '../contracts';
import type { HookPayload } from './hook-payload';
import { PAUSED_AFTER_TOOL, PAUSED_BEFORE_TOOL } from './pause';
import { CLAUDE_TIMING, createClaudeAdapter } from './providers/claude';
import { CODEX_TIMING, createCodexAdapter } from './providers/codex';
import { createGeminiAdapter } from './providers/gemini';
import { geminiSpec } from './providers/gemini/test-helpers';
import type { ProviderAdapter } from './providers/types';
import { AgentSession, type PtyProcess, type PtySpawnOptions } from './session';
import { silentLogger } from './test-helpers';
import type { ProcessScopeDriver, OpenScope } from './process-scope';
import type { SessionCleanup } from '../contracts';
import { ENTER_KEY, PASTE_END, PASTE_START } from './typing';
import { buildSessionPolicy } from '../../test/helpers/session-policy';
import { testConfig } from '../../test/helpers/test-template';

/**
 * Fast unit tests of the session with a fake pseudo-terminal and fake timers. The PTY
 * integration tests (runner.integration.test.ts, codex.integration.test.ts) drive the fake
 * CLIs through the same paths end to end.
 */

class FakePty implements PtyProcess {
  readonly pid = process.pid;
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
describe('session process scope lifecycle', () => {
  function scoped(outcome: SessionCleanup['outcome'] = 'clean') {
    const events: RunnerEvent[] = [];
    const cleanup: SessionCleanup = {
      scopeId: 'scp_0123456789abcdef',
      kind: 'process_group',
      outcome,
      reason: 'exit',
      killed: false,
      survivors: 0,
      durationMs: 0,
    };
    let finish!: (cleanup: SessionCleanup) => void;
    const closed = new Promise<SessionCleanup>((resolve) => {
      finish = resolve;
    });
    const close = vi.fn(() => closed);
    const scope: OpenScope = {
      scopeId: cleanup.scopeId,
      openedAt: 0,
      launch: (cmd) => ({ ...cmd, env: { ...cmd.env, PROJECTMAN_SCOPE_ID: cleanup.scopeId } }),
      attached: vi.fn(),
      close,
    };
    const driver: ProcessScopeDriver = {
      kind: 'process_group',
      open: vi.fn(async () => scope),
      recover: async () => [],
      closeScopes: async () => [],
    };
    const proc = new FakePty();
    const spawnPty = vi.fn(() => proc);
    const session = new AgentSession({
      spec,
      hookToken: 'scope',
      adapter: createClaudeAdapter({ bin: 'unused', logger: silentLogger() }),
      deps: {
        processScopes: driver,
        logger: silentLogger(),
        broker: { decide: async () => ({ behavior: 'deny' }) },
        permissionTimeoutMs: 1000,
        emit: (event) => events.push(event),
        onExited: () => {},
        spawnPty,
      },
    });
    sessions.push(session);
    return { session, proc, close, finish: () => finish(cleanup), events, spawnPty, scope };
  }
  it('waits for cleanup before stop emits exit and carries the result', async () => {
    const s = scoped();
    await s.session.spawn('fake', [], {});
    const stopped = s.session.stop();
    s.proc.exit();
    expect(s.close).toHaveBeenCalledWith('stop', { force: false });
    expect(s.events.some((e) => e.type === 'exit')).toBe(false);
    s.finish();
    await stopped;
    expect(s.events.at(-1)).toMatchObject({ type: 'exit', cleanup: { outcome: 'clean' } });
    expect(s.scope.attached).toHaveBeenCalledWith(s.proc.pid);
    expect(s.spawnPty.mock.calls[0]).toBeDefined();
  });
  it('closes a natural CLI exit', async () => {
    const s = scoped();
    await s.session.spawn('fake', [], {});
    s.proc.exit();
    expect(s.close).toHaveBeenCalledWith('exit', { force: false });
    s.finish();
    await s.session.exited;
  });
  it('kills its own PTY before synthesizing exit after unverified cleanup', async () => {
    const s = scoped('unverified');
    await s.session.spawn('fake', [], {});
    const stopped = s.session.stop();
    expect(s.proc.signals).toEqual([]);
    s.finish();
    await stopped;
    expect(s.proc.signals).toEqual(['SIGKILL']);
    expect(s.events.at(-1)).toMatchObject({ type: 'exit', cleanup: { outcome: 'unverified' } });
  });
  it.each([
    [true, 'kill'],
    [false, 'shutdown'],
  ] as const)('closes force=%s with reason %s', async (force, reason) => {
    const s = scoped();
    await s.session.spawn('fake', [], {});
    const stopped = s.session.stop(force, reason);
    expect(s.close).toHaveBeenCalledWith(reason, { force });
    s.finish();
    await stopped;
  });
  it('closes startup failures before rejecting spawn', async () => {
    const s = scoped();
    s.spawnPty.mockImplementation(() => {
      throw new Error('spawn failed');
    });
    const started = s.session.spawn('fake', [], {});
    await Promise.resolve();
    expect(s.close).toHaveBeenCalledWith('start_failed', { force: true });
    s.finish();
    await expect(started).rejects.toThrow('spawn failed');
  });
  it('keeps an idle turn open', async () => {
    const s = scoped();
    await s.session.spawn('fake', [], {});
    await s.session.handleHook({ hook_event_name: 'SessionStart' }, new AbortController().signal);
    await s.session.handleHook({ hook_event_name: 'Stop' }, new AbortController().signal);
    expect(s.close).not.toHaveBeenCalled();
  });
  it('keeps the scope open while a pause holds the session', async () => {
    const s = scoped();
    await s.session.spawn('fake', [], {});
    await s.session.handleHook({ hook_event_name: 'SessionStart' }, new AbortController().signal);
    await expect(s.session.pause()).resolves.toMatchObject({ point: 'idle' });
    expect(s.close).not.toHaveBeenCalled();
    expect(s.session.release()).toBe(true);
    expect(s.close).not.toHaveBeenCalled();
  });
});
describe('Gemini pre-tool gate', () => {
  const adapter = () => createGeminiAdapter({ bin: 'unused', logger: silentLogger() });
  async function beginTurn(session: ReturnType<typeof start>) {
    const answer = session.hook({ hook_event_name: 'PreInvocation' });
    // The fake PTY printed its bracketed-paste mode. Let xterm parse that queued write
    // and take the pre-prompt snapshot before awaiting the hook's answer.
    await vi.advanceTimersByTimeAsync(0);
    return answer;
  }
  const payload = (command: string): HookPayload => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command, cwd: '/work' },
    gemini_tool: 'run_command',
    gemini_args: { CommandLine: command, Cwd: '/work' },
    tool_use_id: 'tool1',
  });
  it('allows role commands and denies forbidden operations without the broker', async () => {
    const decide = vi.fn();
    const gs = geminiSpec();
    gs.policy!.deniedOperations = ['git_push'];
    const s = start({ adapter: adapter(), spec: gs, broker: { decide } });
    await beginTurn(s);
    expect(await s.hook(payload('npm test'))).toEqual({ decision: 'allow' });
    expect(s.session.state.activity).toContain('npm test');
    expect(await s.hook(payload('git push'))).toMatchObject({ decision: 'deny', reason: expect.any(String) });
    expect(decide).not.toHaveBeenCalled();
  });
  it('keeps the provider conversation root available to native tool decisions', async () => {
    const gemini = adapter();
    const decideToolCall = vi.fn(gemini.decideToolCall!);
    const root = '/provider/conversations';
    const s = start({
      adapter: { ...gemini, decideToolCall },
      spec: geminiSpec(),
      transcriptRoot: root,
    });
    const tool = payload('npm test');
    expect(await s.hook(tool)).toEqual({ decision: 'allow' });
    expect(decideToolCall).toHaveBeenCalledWith(expect.any(Object), tool, root);
  });
  it('asks, returns approval, and remembers session allowances', async () => {
    let resolve!: (decision: PermissionDecision) => void;
    const decide = vi.fn(
      () =>
        new Promise<PermissionDecision>((r) => {
          resolve = r;
        }),
    );
    const s = start({ adapter: adapter(), spec: geminiSpec(), broker: { decide } });
    await beginTurn(s);
    const request = s.hook(payload('echo unknown'));
    expect(s.session.state.state).toBe('waiting_permission');
    resolve({ behavior: 'allow', rememberForSession: true });
    expect(await request).toEqual({ decision: 'allow' });
    expect(s.session.state.state).toBe('working');
    expect(await s.hook(payload('echo unknown'))).toEqual({ decision: 'allow' });
    expect(decide).toHaveBeenCalledTimes(1);
  });
  it('denies timeout, withdrawn requests and missing policy', async () => {
    const s = start({ adapter: adapter(), spec: geminiSpec() });
    await beginTurn(s);
    const request = s.hook(payload('echo unknown'));
    await vi.advanceTimersByTimeAsync(PERMISSION_TIMEOUT_MS);
    expect(await request).toMatchObject({ decision: 'deny' });
    const controller = new AbortController();
    const withdrawn = s.session.handleHook(payload('echo another'), controller.signal);
    controller.abort();
    expect(await withdrawn).toMatchObject({ decision: 'deny' });
    const noPolicy = start({ adapter: adapter() });
    expect(await noPolicy.hook(payload('npm test'))).toMatchObject({ decision: 'deny' });
  });
  it('injects each invocation without submitting another prompt inside a turn', async () => {
    const s = start({ adapter: adapter(), spec: geminiSpec() });
    expect(await beginTurn(s)).toMatchObject({
      injectSteps: [{ ephemeralMessage: 'Member instructions' }],
    });
    await s.hook(payload('npm test'));
    const activity = s.session.state.activity;
    await s.hook({ hook_event_name: 'PreInvocation' });
    expect(s.session.state.activity).toBe(activity);
    const paused = s.session.pause();
    expect(await s.hook(payload('npm test'))).toMatchObject({ decision: 'deny' });
    await s.hook({ hook_event_name: 'Stop' });
    await paused;
  });
});
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
    refreshDependencies?: (cwd: string) => Promise<void | DependencyGate>;
    logger?: ReturnType<typeof silentLogger>;
    transcriptRoot?: string;
    engineGuard?: EngineGuard;
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
      logger: opts.logger ?? silentLogger(),
      transcriptRoot: opts.transcriptRoot,
      ...(opts.engineGuard ? { engineGuard: opts.engineGuard } : {}),
      refreshDependencies: opts.refreshDependencies,
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

describe('worktree dependency preparation', () => {
  const providers = ['claude', 'codex', 'gemini'] as const;
  for (const provider of providers) {
    it.each([false, true])(`awaits preparation for ${provider} (subagent: %s)`, async (subagent) => {
      const logger = silentLogger();
      const adapter =
        provider === 'claude'
          ? createClaudeAdapter({ bin: 'unused', logger })
          : provider === 'codex'
            ? createCodexAdapter({ bin: 'unused', logger, codexHome: '/unused-codex-home' })
            : createGeminiAdapter({ bin: 'unused', logger });
      let release!: () => void;
      const refreshDependencies = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const s = start({ adapter, spec: provider === 'gemini' ? geminiSpec() : {}, refreshDependencies });
      const hook: HookPayload = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'npm test', cwd: '/work' },
        gemini_tool: 'run_command',
        gemini_args: { CommandLine: 'npm test', Cwd: '/work' },
        ...(subagent ? { agent_id: 'child' } : {}),
      };
      let answered = false;
      const answer = s.hook(hook).then((result) => {
        answered = true;
        return result;
      });
      expect(refreshDependencies).toHaveBeenCalledWith('/work');
      await Promise.resolve();
      expect(answered).toBe(false);
      release();
      expect(await answer).toEqual(provider === 'gemini' ? { decision: 'allow' } : null);
    });
  }

  it('keeps the tool decision when preparation fails', async () => {
    const adapter = createGeminiAdapter({ bin: 'unused', logger: silentLogger() });
    const s = start({
      adapter,
      spec: geminiSpec(),
      refreshDependencies: async () => {
        throw new Error('copy failed');
      },
    });
    const hook: HookPayload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test', cwd: '/work' },
      gemini_tool: 'run_command',
      gemini_args: { CommandLine: 'npm test', Cwd: '/work' },
    };
    expect(await s.hook(hook)).toEqual({ decision: 'allow' });
  });
});

describe('dependency gate (PM-743)', () => {
  const claudeBash: HookPayload = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_use_id: 't1',
    tool_input: { command: 'npm test' },
  };
  const geminiBash: HookPayload = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'npm test', cwd: '/work' },
    gemini_tool: 'run_command',
    gemini_args: { CommandLine: 'npm test', Cwd: '/work' },
  };
  const refuse = { refuse: 'wait for the dependencies' };

  it('answers a command tool with the adapter refusal and changes nothing', async () => {
    const decide = vi.fn();
    const refreshDependencies = vi.fn(async () => refuse);
    const s = await ready({ broker: { decide }, refreshDependencies });
    const before = s.session.state;
    expect(await s.hook(claudeBash)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'wait for the dependencies',
      },
    });
    expect(refreshDependencies).toHaveBeenCalledWith('/work');
    expect(s.session.state).toEqual(before);
    expect(decide).not.toHaveBeenCalled();
  });

  it('refuses a Gemini command and a subagent command the same way', async () => {
    const gemini = start({
      adapter: createGeminiAdapter({ bin: 'unused', logger: silentLogger() }),
      spec: geminiSpec(),
      refreshDependencies: async () => refuse,
    });
    expect(await gemini.hook(geminiBash)).toEqual({ decision: 'deny', reason: refuse.refuse });
    const claude = await ready({ refreshDependencies: async () => refuse });
    expect(await claude.hook({ ...claudeBash, agent_id: 'child' })).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: refuse.refuse },
    });
  });

  it('lets the command run, and logs, when the CLI cannot refuse (Codex)', async () => {
    const warn = vi.fn();
    const logger = { ...silentLogger(), warn } as ReturnType<typeof silentLogger>;
    const adapter = createCodexAdapter({ bin: 'unused', logger, codexHome: '/unused-codex-home' });
    expect(adapter.refuseToolOutput).toBeUndefined();
    const s = start({ adapter, logger, refreshDependencies: async () => refuse });
    expect(await s.hook(claudeBash)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ tool: 'Bash' }), expect.any(String));
  });

  it('does not call the gate for file, search, team or input tools', async () => {
    const refreshDependencies = vi.fn(async () => refuse);
    const s = await ready({ refreshDependencies });
    for (const tool_name of [
      'Read',
      'Write',
      'Grep',
      'WebFetch',
      'mcp__team__send_message',
      'AskUserQuestion',
    ])
      await s.hook({ ...claudeBash, tool_name, tool_use_id: tool_name });
    expect(refreshDependencies).not.toHaveBeenCalled();
  });

  it('does not wait for the gate while a pause is stopping the session', async () => {
    const refreshDependencies = vi.fn(async () => refuse);
    const s = await ready({ refreshDependencies });
    await s.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });
    void s.session.pause();
    expect(await s.hook(claudeBash)).toEqual({ continue: false, stopReason: PAUSED_BEFORE_TOOL });
    expect(refreshDependencies).not.toHaveBeenCalled();
  });
});

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
describe('a reader’s read boundary (PM-425)', () => {
  const readerSpec = (): Partial<StartSessionSpec> => {
    const policy = buildSessionPolicy({
      config: testConfig(),
      role: 'code_review',
      task: { repo: 'web' },
      permissionMode: 'acceptEdits',
      placement: { kind: 'read_only', path: '/work' },
    });
    const readBoundary = {
      deniedRoots: ['/fictional/home'],
      allowedPaths: [{ path: '/work', kind: 'directory' as const }],
    };
    return { policy: { ...policy, filesystem: { ...policy.filesystem, readBoundary } } };
  };
  const readOf = (file_path: string) => ({
    tool_name: 'Read',
    tool_input: { file_path },
    tool_use_id: 'toolu_read',
  });
  const readerSession = async () => {
    const decide = vi.fn(async (): Promise<PermissionDecision> => ({ behavior: 'allow' }));
    return { decide, ...(await ready({ spec: readerSpec(), broker: { decide } })) };
  };

  it('refuses a file tool call below the closed home before the tool runs, without asking', async () => {
    const { decide, hook } = await readerSession();
    await expect(
      hook({ hook_event_name: 'PreToolUse', ...readOf('/fictional/home/Dev/other/a.ts') }),
    ).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: expect.any(String),
      },
    });
    await expect(
      hook({ hook_event_name: 'PermissionRequest', ...readOf('/fictional/home/Dev/other/a.ts') }),
    ).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: expect.any(String) },
      },
    });
    expect(decide).not.toHaveBeenCalled();
  });

  it('answers a read in its own project or outside the closed home without asking', async () => {
    const { decide, hook } = await readerSession();
    for (const file of ['/work/src/a.ts', '/etc/hosts']) {
      await expect(hook({ hook_event_name: 'PermissionRequest', ...readOf(file) })).resolves.toEqual({
        hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
      });
    }
    expect(decide).not.toHaveBeenCalled();
  });

  it('leaves a tool call that is not a file tool to the normal permission flow', async () => {
    const { decide, hook } = await readerSession();
    await hook({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    expect(decide).toHaveBeenCalledTimes(1);
  });
});

describe('the engine guard (PM-1176)', () => {
  const guardSpec = (): Partial<StartSessionSpec> => {
    const policy = geminiSpec().policy!;
    policy.filesystem.deniedPaths = ['/engine-secrets'];
    return { policy, member: 'dev-8', allowedTools: ['Edit(/outside/**)'] };
  };
  const preTool = (tool_name: string, tool_input: unknown) => ({
    hook_event_name: 'PreToolUse',
    tool_name,
    tool_input,
    tool_use_id: 'toolu_guard',
  });
  const refusedPreTool = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: expect.any(String),
    },
  };
  /** A started session; the broker would approve anything, remembered for the session and with a changed input. */
  async function guarded(decision: PermissionDecision = { behavior: 'allow', rememberForSession: true }) {
    const decide = vi.fn(async () => decision);
    const refused = vi.fn();
    const engineGuard = { refused: vi.fn() };
    const s = await ready({ spec: guardSpec(), broker: { decide, refused }, engineGuard });
    return { ...s, decide, refused, engineGuard };
  }

  it.each([
    ['Write', { file_path: '/outside/a.ts' }],
    ['Edit', { file_path: '/home/x/.zshrc', old_string: 'a', new_string: 'b' }],
    ['MultiEdit', { file_path: '/outside/a.ts', edits: [] }],
    ['NotebookEdit', { notebook_path: '/outside/n.ipynb' }],
  ])(
    'turns a %s outside the write zone away at PreToolUse, whatever was allowed before',
    async (tool, input) => {
      const { hook, decide, refused, engineGuard } = await guarded();
      expect(await hook(preTool(tool, input))).toEqual(refusedPreTool);
      expect(decide).not.toHaveBeenCalled();
      expect(engineGuard.refused).toHaveBeenCalledOnce();
      expect(engineGuard.refused).toHaveBeenCalledWith({
        sessionId: 'ses_1',
        member: 'dev-8',
        code: 'outside_writable_roots',
      });
      expect(refused).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: tool, by: 'engine_guard', reason: 'outside_writable_roots' }),
      );
    },
  );

  it('turns a read below a denied path away at PreToolUse', async () => {
    const { hook, decide, engineGuard } = await guarded();
    expect(await hook(preTool('Read', { file_path: '/engine-secrets/key' }))).toEqual(refusedPreTool);
    expect(engineGuard.refused).toHaveBeenCalledWith(expect.objectContaining({ code: 'denied_path' }));
    expect(decide).not.toHaveBeenCalled();
  });

  it('holds at the permission request too, when no PreToolUse came before it', async () => {
    const { hook, decide, engineGuard } = await guarded();
    expect(
      await hook({
        ...preTool('Write', { file_path: '/outside/a.ts' }),
        hook_event_name: 'PermissionRequest',
      }),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: expect.any(String) },
      },
    });
    expect(decide).not.toHaveBeenCalled();
    expect(engineGuard.refused).toHaveBeenCalledOnce();
  });

  it('turns an approval that changes the tool input into a denial', async () => {
    const { hook, decide, engineGuard, refused } = await guarded({
      behavior: 'allow',
      updatedInput: { file_path: '/outside/a.ts' },
    });
    const inside = { file_path: '/work/a.ts' };
    expect(await hook({ ...preTool('Write', inside), hook_event_name: 'PermissionRequest' })).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: expect.any(String) },
      },
    });
    expect(decide).toHaveBeenCalledOnce();
    expect(engineGuard.refused).toHaveBeenCalledWith(expect.objectContaining({ code: 'updated_input' }));
    expect(refused).toHaveBeenCalledWith(
      expect.objectContaining({ by: 'engine_guard', reason: 'updated_input' }),
    );
  });

  it('lets a write inside the roots go on, and an approval without a changed input stand', async () => {
    const { hook, decide, engineGuard } = await guarded({ behavior: 'allow' });
    expect(await hook(preTool('Write', { file_path: '/work/a.ts' }))).toBeNull();
    expect(
      await hook({ ...preTool('Write', { file_path: '/work/a.ts' }), hook_event_name: 'PermissionRequest' }),
    ).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    expect(decide).toHaveBeenCalledOnce();
    expect(engineGuard.refused).not.toHaveBeenCalled();
  });

  it('does not run without an engine guard (single mode)', async () => {
    const decide = vi.fn(async (): Promise<PermissionDecision> => ({ behavior: 'allow' }));
    const { hook } = await ready({ spec: guardSpec(), broker: { decide } });
    expect(await hook(preTool('Write', { file_path: '/outside/a.ts' }))).toBeNull();
  });

  it('denies a Gemini edit outside the roots, or without a path, instead of asking', async () => {
    const decide = vi.fn();
    const refused = vi.fn();
    const engineGuard = { refused: vi.fn() };
    const s = start({
      adapter: createGeminiAdapter({ bin: 'unused', logger: silentLogger() }),
      spec: geminiSpec(),
      broker: { decide, refused },
      engineGuard,
    });
    const edit = (gemini_args: Record<string, unknown>) => ({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: {},
      gemini_tool: 'write_to_file',
      gemini_args,
    });
    expect(await s.hook(edit({ TargetFile: '/outside/a.ts' }))).toMatchObject({ decision: 'deny' });
    expect(await s.hook(edit({}))).toMatchObject({ decision: 'deny' });
    expect(decide).not.toHaveBeenCalled();
    expect(engineGuard.refused).toHaveBeenCalledTimes(2);
    expect(refused).toHaveBeenCalledWith(expect.objectContaining({ by: 'engine_guard' }));
  });

  describe('a request to run outside the sandbox (PM-1187)', () => {
    const permission = (tool_name: string) => ({
      hook_event_name: 'PermissionRequest',
      tool_name,
      tool_input: { command: 'git fetch' },
      tool_use_id: 'call_1',
    });
    const codexSession = (engineGuard?: EngineGuard) => {
      const decide = vi.fn(async (): Promise<PermissionDecision> => ({ behavior: 'allow' }));
      const refused = vi.fn();
      const s = start({
        adapter: createCodexAdapter({
          bin: 'unused',
          logger: silentLogger(),
          codexHome: '/unused-codex-home',
        }),
        spec: { provider: 'codex', member: 'dev-8' },
        broker: { decide, refused },
        ...(engineGuard ? { engineGuard } : {}),
      });
      return { ...s, decide, refused };
    };

    it('denies a Codex Bash request without asking the cloud, and reports the engine guard', async () => {
      const engineGuard = { refused: vi.fn() };
      const { hook, decide, refused } = codexSession(engineGuard);
      expect(await hook(permission('Bash'))).toMatchObject({
        hookSpecificOutput: { decision: { behavior: 'deny', message: expect.any(String) } },
      });
      expect(decide).not.toHaveBeenCalled();
      expect(engineGuard.refused).toHaveBeenCalledWith({
        sessionId: 'ses_1',
        member: 'dev-8',
        code: 'escalation_refused',
      });
      expect(refused).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: 'Bash', by: 'engine_guard', reason: 'escalation_refused' }),
      );
    });

    it('leaves an MCP tool to the cloud', async () => {
      const engineGuard = { refused: vi.fn() };
      const { hook, decide } = codexSession(engineGuard);
      void hook(permission('mcp__team__send_message'));
      await vi.waitFor(() => expect(decide).toHaveBeenCalledOnce());
      expect(engineGuard.refused).not.toHaveBeenCalled();
    });

    it('does not run without an engine guard (single mode)', async () => {
      const { hook, decide } = codexSession();
      void hook(permission('Bash'));
      await vi.waitFor(() => expect(decide).toHaveBeenCalledOnce());
    });

    it('leaves a provider without sandbox escalation alone', async () => {
      const engineGuard = { refused: vi.fn() };
      const decide = vi.fn(async (): Promise<PermissionDecision> => ({ behavior: 'allow' }));
      const { hook } = start({ spec: guardSpec(), broker: { decide }, engineGuard });
      void hook(permission('Bash'));
      await vi.waitFor(() => expect(decide).toHaveBeenCalledOnce());
      expect(engineGuard.refused).not.toHaveBeenCalled();
    });
  });
});

describe('process liveness', () => {
  it('drops pause deadlines and the stop fallback when the process exits', async () => {
    const s = await ready();
    await s.hook({ hook_event_name: 'UserPromptSubmit' });
    const paused = s.session.pause({ forceAfterMs: 100 });
    const stopped = s.session.stop();
    expect(s.pty.signals).toEqual(['SIGTERM']);
    s.pty.exit();
    await stopped;
    expect(await paused).toEqual({ point: 'exited', tool: null });
    const pausingCount = s.events.filter((e) => e.type === 'session_pausing').length;
    await vi.advanceTimersByTimeAsync(Math.max(100, CLAUDE_TIMING.stopTimeoutMs) + 30_001);
    expect(s.pty.signals).toEqual(['SIGTERM']);
    expect(s.events.filter((e) => e.type === 'session_pausing')).toHaveLength(pausingCount);
    s.session.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes a working session when its process disappears without an exit event', async () => {
    const s = await ready();
    await s.hook({ hook_event_name: 'UserPromptSubmit' });
    expect(s.session.state.state).toBe('working');
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await s.session.exited;
    expect(s.session.isRunning).toBe(false);
    expect(s.session.state.state).toBe('failed');
    expect(s.events.filter((e) => e.type === 'exit')).toHaveLength(1);
    s.pty.exit();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.events.filter((e) => e.type === 'exit')).toHaveLength(1);
  });

  it('keeps the last output of a CLI that fails before it is ready in the failed state (PM-1207)', async () => {
    const s = start({
      adapter: createCodexAdapter({ bin: 'codex', codexHome: '/nonexistent', logger: silentLogger() }),
    });
    s.pty.print('Error: invalid configuration\r\n  mcp_servers.team: token=abcdefghijklmnop rejected\r\n');
    s.pty.exit(1);
    await s.session.exited;
    const failed = s.events.filter((e) => e.type === 'state').at(-1);
    expect(failed).toMatchObject({ state: 'failed' });
    const activity = (failed as Extract<RunnerEvent, { type: 'state' }>).activity ?? '';
    expect(activity).toContain('invalid configuration');
    expect(activity).toContain('exit code 1');
    expect(activity).not.toContain('abcdefghijklmnop');
  });

  it('adds no output to the exit of a session that was ready', async () => {
    const s = await ready();
    s.pty.print('some output\r\n');
    s.pty.exit(1);
    await s.session.exited;
    const failed = s.events.filter((e) => e.type === 'state').at(-1) as Extract<
      RunnerEvent,
      { type: 'state' }
    >;
    expect(failed.activity).toBeNull();
  });

  it('keeps a live or inaccessible process running and stops probing after exit', async () => {
    const s = await ready();
    const probe = vi.spyOn(process, 'kill').mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(probe).toHaveBeenCalledWith(process.pid, 0);
    expect(s.session.isRunning).toBe(true);
    probe.mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.session.isRunning).toBe(true);
    s.pty.exit();
    await s.session.exited;
    probe.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(probe).not.toHaveBeenCalled();
  });
});
afterEach(() => {
  vi.restoreAllMocks();
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
    expect(session.info()).toMatchObject({ pid: process.pid, state: 'starting' });
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

  it('reports the first input only once the CLI took it (PM-189, PM-571)', async () => {
    const { events, hook } = start({ spec: { initialMessage: 'Build the login page' } });
    const sent = () => events.filter((e) => e.type === 'first_input_sent');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent()).toEqual([]);
    await hook({ hook_event_name: 'SessionStart', source: 'startup' });
    await vi.advanceTimersByTimeAsync(CLAUDE_TIMING.readySettleMs - 1);
    expect(sent()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1 + TYPE_MS);
    // Typed, but the CLI has not reported the prompt yet.
    expect(sent()).toEqual([]);
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Build the login page' });
    expect(sent()).toEqual([{ type: 'first_input_sent', sessionId: 'ses_1' }]);
  });

  it('reports a typed first input the CLI never took as failed, not as sent (PM-571)', async () => {
    const { events, hook } = start({ spec: { initialMessage: 'Build the login page' } });
    await hook({ hook_event_name: 'SessionStart', source: 'startup' });
    await vi.advanceTimersByTimeAsync(
      CLAUDE_TIMING.readySettleMs + TYPE_MS + CLAUDE_TIMING.submitTimeoutMs + CLAUDE_TIMING.enterRetryMs,
    );
    expect(events.filter((e) => e.type === 'first_input_sent')).toEqual([]);
    expect(events.filter((e) => e.type === 'first_input_failed')).toEqual([
      { type: 'first_input_failed', sessionId: 'ses_1' },
    ]);
  });

  it('does not report a first input as failed when the process ends first (PM-571)', async () => {
    const { events, hook, pty } = start({ spec: { initialMessage: 'Build the login page' } });
    await hook({ hook_event_name: 'SessionStart', source: 'startup' });
    await vi.advanceTimersByTimeAsync(CLAUDE_TIMING.readySettleMs + TYPE_MS);
    pty.exit(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events.map((e) => e.type)).not.toContain('first_input_failed');
    expect(events.map((e) => e.type)).not.toContain('first_input_sent');
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

  it('describes a resumed session stalled after a completed turn with bounded screen and hook metadata', async () => {
    const logger = silentLogger();
    const warn = vi.spyOn(logger, 'warn');
    const { session, pty, hook } = await ready({ spec: { resume: true }, logger });
    await hook({ hook_event_name: 'UserPromptSubmit' });
    await hook({ hook_event_name: 'Stop' });
    const lastHookAt = new Date().toISOString();
    await vi.advanceTimersByTimeAsync(CLAUDE_TIMING.stopSettleMs);
    const text = 'A private request';
    const sent = session.enqueue(text);
    await vi.advanceTimersByTimeAsync(TYPE_MS);
    await expect(sent).resolves.toBeUndefined();
    // This fake terminal swallows Enter and emits no submission hook.
    pty.print('x'.repeat(600) + '\r\nDo you trust the files in this folder?');
    const { enterRetryMs, submitTimeoutMs, maxEnterRetries } = CLAUDE_TIMING;
    const waitMs = Math.ceil(submitTimeoutMs / enterRetryMs) * enterRetryMs;
    await vi.advanceTimersByTimeAsync(waitMs);
    const screen = session.screen.screenText(15);
    expect(warn).toHaveBeenCalledWith(
      {
        sessionId: 'ses_1',
        enterRetries: maxEnterRetries,
        waitMs,
        command: false,
        idle: true,
        promptSeen: true,
        resumed: true,
        lastHookName: 'Stop',
        lastHookAt,
        blockingScreen: expect.any(String),
        screen: screen.slice(-500),
      },
      expect.any(String),
    );
    expect(screen.length).toBeGreaterThan(500);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(text);
    expect(session.state.state).toBe('idle');
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
        decision: { behavior: 'deny', message: expect.any(String) },
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
          permissionDecisionReason: expect.any(String),
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
          decision: { behavior: 'deny', message: expect.any(String) },
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
    const queued = expect(session.enqueue('later')).rejects.toThrow();
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
    await expect(session.enqueue('too late')).rejects.toThrow();
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
    expect(session.state).toEqual({ state: 'working', activity: expect.any(String) });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pty.typed().pastes).toHaveLength(1);

    await hook({ hook_event_name: 'PostCompact', trigger: 'manual' });
    expect(session.state).toEqual({ state: 'idle', activity: null });
    await vi.advanceTimersByTimeAsync(CLAUDE_TIMING.stopSettleMs + TYPE_MS);
    await expect(later).resolves.toBeUndefined();
    expect(pty.typed().pastes[1]).toBe('a message that must wait');
    expect(compactions(events)).toEqual(['started (asked for)', 'finished (asked for)']);
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

  it('types a queued general-chat message when the 0.159.1 composer appears before any hook', async () => {
    const { session, pty, hook, states } = start({
      adapter: codex(),
      spec: { provider: 'codex', initialMessage: null, cols: 120, rows: 30 },
    });
    const queued = session.enqueue('Hello from general chat');
    await vi.advanceTimersByTimeAsync(CODEX_TIMING.startupCheckMs);
    expect(pty.typed()).toEqual({ pastes: [], enters: 0 });
    const screen = readFileSync(
      new URL('../../test/fixtures/codex-0.159.1-composer.txt', import.meta.url),
      'utf8',
    );
    pty.print(screen.replace(/\n/g, '\r\n'));
    await vi.advanceTimersByTimeAsync(
      CODEX_TIMING.startupCheckMs + CODEX_TIMING.readySettleMs + TYPE_CODEX_MS,
    );
    await expect(queued).resolves.toBeUndefined();
    expect(pty.typed()).toEqual({ pastes: ['Hello from general chat'], enters: 1 });
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Hello from general chat' });
    await hook({ hook_event_name: 'Stop' });
    await vi.advanceTimersByTimeAsync(CODEX_TIMING.startupTimeoutMs);
    expect(states()).toEqual<SessionState[]>(['starting', 'idle', 'working', 'idle']);
  });

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
      activity: expect.any(String),
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

describe('pausing (PM-218)', () => {
  const ESC = '\x1b';
  const BASH = { tool_name: 'Bash', tool_input: { command: 'sleep 60' } };
  /** Claude Code's prompt box on the screen. */
  const CLAUDE_PROMPT = ['\x1b[2J\x1b[H', '─'.repeat(40), '❯ ', '─'.repeat(40)].join('\r\n');
  const codex = () => createCodexAdapter({ bin: 'codex', codexHome: '/nonexistent', logger: silentLogger() });

  type Started = ReturnType<typeof start>;
  const log = (events: RunnerEvent[]) =>
    events.flatMap((e) =>
      e.type === 'session_pausing'
        ? [`pausing(${e.waitingFor})`]
        : e.type === 'session_paused'
          ? [`paused(${e.point},${e.tool})`]
          : [],
    );
  const escapes = (pty: FakePty) => pty.writes.filter((w) => w === ESC).length;
  const submit = (s: Started) => s.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });
  const pre = (s: Started, id: string, name = 'Bash') =>
    s.hook({ hook_event_name: 'PreToolUse', ...BASH, tool_name: name, tool_use_id: id });
  const post = (s: Started, id: string, name = 'Bash') =>
    s.hook({ hook_event_name: 'PostToolUse', ...BASH, tool_name: name, tool_use_id: id });
  /** Whether a pending pause promise has settled (without waiting for it). */
  const settled = async (promise: Promise<unknown>) => {
    let done = false;
    void promise.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    return done;
  };
  async function readyCodex() {
    const started = start({ adapter: codex(), spec: { provider: 'codex' } });
    await started.hook({ hook_event_name: 'SessionStart', source: 'startup' });
    await vi.advanceTimersByTimeAsync(CODEX_TIMING.readySettleMs);
    return started;
  }

  it('stops an idle session at once, and types nothing until the release, the nudge first', async () => {
    const s = await ready();
    await expect(s.session.pause()).resolves.toEqual({ point: 'idle', tool: null });
    expect(log(s.events)).toEqual(['pausing(null)', 'paused(idle,null)']);

    void s.session.enqueue('first');
    void s.session.enqueue('second');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.pty.typed().pastes).toEqual([]);
    expect(s.session.hasPendingInput).toBe(true);

    expect(s.session.release({ nudge: 'Carry on.' })).toBe(true);
    await vi.advanceTimersByTimeAsync(TYPE_MS);
    expect(s.pty.typed().pastes).toEqual(['Carry on.']);
    await submit(s);
    await s.hook({ hook_event_name: 'Stop' });
    await vi.advanceTimersByTimeAsync(CLAUDE_TIMING.stopSettleMs + TYPE_MS);
    expect(s.pty.typed().pastes).toEqual(['Carry on.', 'first']);
    expect(s.session.release()).toBe(false);
  });

  it('halts the tool call that comes next: it does not run, and the session stops before it', async () => {
    const s = await ready();
    await submit(s);
    await pre(s, 't0', 'Read');
    await s.hook({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 't0' });
    const before = s.session.state;
    const paused = s.session.pause();
    expect(log(s.events)).toEqual(['pausing(null)']);

    await expect(pre(s, 't1')).resolves.toEqual({ continue: false, stopReason: PAUSED_BEFORE_TOOL });
    expect(s.session.state).toEqual(before); // the call neither ran nor changed the activity
    expect(await settled(paused)).toBe(false); // the turn is not over until the Stop hook
    await s.hook({ hook_event_name: 'Stop' });
    await expect(paused).resolves.toEqual({ point: 'before_tool', tool: 'Bash' });
    expect(log(s.events)).toEqual(['pausing(null)', 'paused(before_tool,Bash)']);
  });

  it('lets the running tool finish, halts after it, and stops where the first answer was', async () => {
    const s = await ready();
    await submit(s);
    await pre(s, 't1');
    await pre(s, 't2', 'Grep');
    const paused = s.session.pause();
    expect(log(s.events)).toEqual(['pausing(Grep)']);

    await expect(post(s, 't1')).resolves.toEqual({ continue: false, stopReason: PAUSED_AFTER_TOOL });
    await expect(post(s, 't2', 'Grep')).resolves.toEqual({ continue: false, stopReason: PAUSED_AFTER_TOOL });
    await s.hook({ hook_event_name: 'Stop' });
    await expect(paused).resolves.toEqual({ point: 'after_tool', tool: 'Bash' });
  });

  it('halts a failed tool the same way', async () => {
    const s = await ready();
    await submit(s);
    await pre(s, 't1');
    const paused = s.session.pause();
    await expect(
      s.hook({ hook_event_name: 'PostToolUseFailure', ...BASH, tool_use_id: 't1' }),
    ).resolves.toEqual({
      continue: false,
      stopReason: PAUSED_AFTER_TOOL,
    });
    await s.hook({ hook_event_name: 'Stop' });
    await expect(paused).resolves.toEqual({ point: 'after_tool', tool: 'Bash' });
  });

  it('answers a subagent hook as before: it neither halts nor counts', async () => {
    const s = await ready();
    await submit(s);
    await pre(s, 't1');
    const paused = s.session.pause();
    await expect(
      s.hook({ hook_event_name: 'PostToolUse', ...BASH, tool_use_id: 'sub-1', agent_id: 'agent-1' }),
    ).resolves.toBeNull();
    await expect(
      s.hook({ hook_event_name: 'PreToolUse', ...BASH, tool_use_id: 'sub-2', agent_id: 'agent-1' }),
    ).resolves.toBeNull();
    expect(await settled(paused)).toBe(false);
    await expect(post(s, 't1')).resolves.toEqual({ continue: false, stopReason: PAUSED_AFTER_TOOL });
  });

  it('reports a turn that ends by itself as turn_end', async () => {
    const s = await ready();
    await submit(s);
    const paused = s.session.pause();
    await s.hook({ hook_event_name: 'Stop' });
    await expect(paused).resolves.toEqual({ point: 'turn_end', tool: null });
  });

  it('turns a question tool away rather than forwarding it while the session is being stopped', async () => {
    const forwardQuestion = vi.fn(async () => true);
    const s = await ready({
      broker: { decide: () => new Promise(() => undefined), forwardQuestion },
      spec: { member: 'fe-1' },
    });
    await submit(s);
    void s.session.pause();
    await expect(pre(s, 'q1', 'AskUserQuestion')).resolves.toEqual({
      continue: false,
      stopReason: PAUSED_BEFORE_TOOL,
    });
    expect(forwardQuestion).not.toHaveBeenCalled();
  });

  it('gives the same answer to a repeated call, and the last result to a later one', async () => {
    const s = await ready();
    await submit(s);
    await pre(s, 't1');
    const first = s.session.pause();
    const second = s.session.pause({ forceAfterMs: 10 });
    await post(s, 't1');
    await s.hook({ hook_event_name: 'Stop' });
    await expect(first).resolves.toEqual({ point: 'after_tool', tool: 'Bash' });
    await expect(second).resolves.toEqual({ point: 'after_tool', tool: 'Bash' });
    await expect(s.session.pause()).resolves.toEqual({ point: 'after_tool', tool: 'Bash' });
    expect(log(s.events)).toEqual(['pausing(Bash)', 'paused(after_tool,Bash)']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(escapes(s.pty)).toBe(0); // the deadline of the second call is not one
  });

  it('takes a pause back before the session stopped: null, no halting answers, and no nudge', async () => {
    const s = await ready();
    await submit(s);
    await pre(s, 't1');
    const paused = s.session.pause();
    expect(s.session.release({ nudge: 'Carry on.' })).toBe(true);
    await expect(paused).resolves.toBeNull();
    await expect(post(s, 't1')).resolves.toBeNull();
    await s.hook({ hook_event_name: 'Stop' });
    await vi.advanceTimersByTimeAsync(CLAUDE_TIMING.stopSettleMs + TYPE_MS);
    expect(s.pty.typed().pastes).toEqual([]);
  });

  it('keeps the nudge of a pause released after the turn was told to end', async () => {
    const s = await ready();
    await submit(s);
    await pre(s, 't1');
    const paused = s.session.pause();
    await post(s, 't1');
    expect(s.session.release({ nudge: 'Carry on.' })).toBe(true);
    await expect(paused).resolves.toBeNull();
    await s.hook({ hook_event_name: 'Stop' });
    await vi.advanceTimersByTimeAsync(CLAUDE_TIMING.stopSettleMs + TYPE_MS);
    expect(s.pty.typed().pastes).toEqual(['Carry on.']);
  });

  it('closes a turn whose Stop hook never came when the prompt is up', async () => {
    const s = await ready();
    await submit(s);
    await pre(s, 't1');
    const paused = s.session.pause();
    await post(s, 't1');
    s.pty.print(CLAUDE_PROMPT);
    await vi.advanceTimersByTimeAsync(CLAUDE_TIMING.haltStopMs);
    await expect(paused).resolves.toEqual({ point: 'after_tool', tool: 'Bash' });
    expect(s.session.state.state).toBe('idle');
  });

  it('keeps waiting for the Stop hook while the prompt is not up', async () => {
    const s = await ready();
    await submit(s);
    await pre(s, 't1');
    const paused = s.session.pause();
    await post(s, 't1');
    await vi.advanceTimersByTimeAsync(CLAUDE_TIMING.haltStopMs * 3);
    expect(await settled(paused)).toBe(false);
    await s.hook({ hook_event_name: 'Stop' });
    await expect(paused).resolves.toEqual({ point: 'after_tool', tool: 'Bash' });
  });

  it('forces the stop with one Esc; with the prompt up it counts as interrupted', async () => {
    const s = await ready();
    await submit(s);
    await pre(s, 't1');
    const paused = s.session.forcePause();
    expect(escapes(s.pty)).toBe(1);
    s.pty.print(CLAUDE_PROMPT);
    await vi.advanceTimersByTimeAsync(CLAUDE_TIMING.interruptConfirmMs);
    await expect(paused).resolves.toEqual({ point: 'interrupted', tool: 'Bash' });
    expect(escapes(s.pty)).toBe(1);
  });

  it('sends no second Esc when the first is not confirmed, and waits for a stop', async () => {
    const s = await ready();
    await submit(s);
    const paused = s.session.forcePause();
    await vi.advanceTimersByTimeAsync(CLAUDE_TIMING.interruptConfirmMs * 4);
    expect(escapes(s.pty)).toBe(1);
    expect(await settled(paused)).toBe(false);
    await s.hook({ hook_event_name: 'Stop' });
    await expect(paused).resolves.toEqual({ point: 'interrupted', tool: null });
  });

  it('forces the stop when the deadline of the first call passes, and not before', async () => {
    const s = await ready();
    await submit(s);
    const paused = s.session.pause({ forceAfterMs: 1_000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(escapes(s.pty)).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(escapes(s.pty)).toBe(1);
    await s.hook({ hook_event_name: 'Stop' });
    await expect(paused).resolves.toEqual({ point: 'interrupted', tool: null });
  });

  it('forces at once with a deadline of 0, and forcePause starts a pause of its own', async () => {
    const a = await ready();
    await submit(a);
    void a.session.pause({ forceAfterMs: 0 });
    expect(escapes(a.pty)).toBe(1);

    const b = await ready();
    await submit(b);
    void b.session.forcePause();
    expect(log(b.events)).toEqual(['pausing(null)']);
    expect(escapes(b.pty)).toBe(1);
  });

  it('does not touch a session that has stopped already when it is forced', async () => {
    const s = await ready();
    await expect(s.session.forcePause()).resolves.toEqual({ point: 'idle', tool: null });
    expect(escapes(s.pty)).toBe(0);
  });

  it('waits for the compaction asked for, then stops idle', async () => {
    const s = await ready();
    void s.session.compact('Keep the card.');
    await vi.advanceTimersByTimeAsync(TYPE_MS);
    const paused = s.session.pause();
    expect(await settled(paused)).toBe(false);
    await s.hook({ hook_event_name: 'PreCompact', trigger: 'manual' });
    expect(await settled(paused)).toBe(false);
    await s.hook({ hook_event_name: 'PostCompact', trigger: 'manual' });
    await expect(paused).resolves.toEqual({ point: 'idle', tool: null });
  });

  it('does not give up a forced compaction to a timeout: one Esc cancels it and the session stops', async () => {
    const s = await ready();
    void s.session.compact('Keep the card.');
    await vi.advanceTimersByTimeAsync(TYPE_MS);
    await s.hook({ hook_event_name: 'PreCompact', trigger: 'manual' });
    const paused = s.session.forcePause();
    expect(escapes(s.pty)).toBe(1);
    await expect(paused).resolves.toEqual({ point: 'interrupted', tool: null });
    expect(s.session.state.state).toBe('idle');
    expect(escapes(s.pty)).toBe(1);
  });

  it('keeps the halted turn open while parallel tools run and the prompt is up (it is up while they work)', async () => {
    const s = await ready();
    await submit(s);
    await pre(s, 't1');
    await pre(s, 't2');
    const paused = s.session.pause();
    await expect(post(s, 't1')).resolves.toEqual({ continue: false, stopReason: PAUSED_AFTER_TOOL });
    s.pty.print(CLAUDE_PROMPT);
    await vi.advanceTimersByTimeAsync(CLAUDE_TIMING.haltStopMs * 3);
    expect(await settled(paused)).toBe(false);
    expect(s.session.state.state).toBe('working');

    await post(s, 't2');
    await s.hook({ hook_event_name: 'Stop' });
    await expect(paused).resolves.toEqual({ point: 'after_tool', tool: 'Bash' });
  });

  it('does not take the prompt for a stop while the screen shows the agent working', async () => {
    const s = await ready();
    await submit(s);
    await pre(s, 't1');
    const paused = s.session.forcePause();
    s.pty.print(`${CLAUDE_PROMPT}\r\n  esc to interrupt`);
    await vi.advanceTimersByTimeAsync(CLAUDE_TIMING.interruptConfirmMs * 3);
    expect(escapes(s.pty)).toBe(1);
    expect(await settled(paused)).toBe(false);
    await s.hook({ hook_event_name: 'Stop' });
    await expect(paused).resolves.toEqual({ point: 'interrupted', tool: 'Bash' });
  });

  it('does not count a call the auto mode refused as a running tool', async () => {
    const s = await ready();
    await submit(s);
    await pre(s, 't1');
    await s.hook({ hook_event_name: 'PermissionDenied', ...BASH, tool_use_id: 't1', denial_reason: 'no' });
    void s.session.pause();
    expect(log(s.events)).toEqual(['pausing(null)']);
  });

  it('holds the brief of a starting session back, and stops idle once it is ready', async () => {
    const s = start({ spec: { initialMessage: 'The brief' } });
    const paused = s.session.pause();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await settled(paused)).toBe(false);
    await s.hook({ hook_event_name: 'SessionStart', source: 'startup' });
    await vi.advanceTimersByTimeAsync(CLAUDE_TIMING.readySettleMs + TYPE_MS);
    await expect(paused).resolves.toEqual({ point: 'idle', tool: null });
    expect(s.pty.typed().pastes).toEqual([]);
    expect(s.events.filter((e) => e.type === 'first_input_sent')).toEqual([]);

    s.session.release();
    await vi.advanceTimersByTimeAsync(TYPE_MS);
    expect(s.pty.typed().pastes).toEqual(['The brief']);
    await s.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'The brief' });
    expect(s.events.filter((e) => e.type === 'first_input_sent')).toHaveLength(1);
  });

  it('stops at once on a dialog that comes up while it is being stopped', async () => {
    const s = start();
    const paused = s.session.pause();
    s.pty.print('Do you trust the files in this folder?\r\n');
    await vi.advanceTimersByTimeAsync(CLAUDE_TIMING.startupCheckMs);
    await expect(paused).resolves.toEqual({ point: 'waiting_input', tool: null });
  });

  it('stops while it waits for an approval, and stops again after the answer, at the next boundary', async () => {
    let answer!: (decision: PermissionDecision) => void;
    const s = await ready({
      broker: { decide: () => new Promise((resolve) => (answer = resolve)) },
    });
    await submit(s);
    await pre(s, 't1');
    const first = s.session.pause();
    const request = s.hook({ hook_event_name: 'PermissionRequest', ...BASH });
    await expect(first).resolves.toEqual({ point: 'waiting_permission', tool: 'Bash' });

    answer({ behavior: 'allow' });
    await request;
    expect(s.session.state.state).toBe('working');
    expect(log(s.events)).toEqual(['pausing(Bash)', 'paused(waiting_permission,Bash)', 'pausing(Bash)']);

    const second = s.session.pause();
    await expect(post(s, 't1')).resolves.toEqual({ continue: false, stopReason: PAUSED_AFTER_TOOL });
    await s.hook({ hook_event_name: 'Stop' });
    await expect(second).resolves.toEqual({ point: 'after_tool', tool: 'Bash' });
    expect(log(s.events).at(-1)).toBe('paused(after_tool,Bash)');
  });

  it('stops again when someone types into a stopped session, with no deadline but a working forcePause', async () => {
    const s = await ready();
    await s.session.pause();
    await submit(s);
    expect(log(s.events)).toEqual(['pausing(null)', 'paused(idle,null)', 'pausing(null)']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(escapes(s.pty)).toBe(0);
    const again = s.session.forcePause();
    expect(escapes(s.pty)).toBe(1);
    await s.hook({ hook_event_name: 'Stop' });
    await expect(again).resolves.toEqual({ point: 'interrupted', tool: null });
  });

  it('reports exited when the process ends under a pause, and for a session that is not running', async () => {
    const s = await ready();
    await submit(s);
    const paused = s.session.pause();
    s.pty.exit();
    await expect(paused).resolves.toEqual({ point: 'exited', tool: null });
    expect(log(s.events)).toEqual(['pausing(null)', 'paused(exited,null)']);

    const count = s.events.length;
    await expect(s.session.pause()).resolves.toEqual({ point: 'exited', tool: null });
    await expect(s.session.forcePause()).resolves.toEqual({ point: 'exited', tool: null });
    expect(s.events).toHaveLength(count);
  });

  describe('of Codex, which has no halting answer', () => {
    it('lets the running tool finish, then sends one Esc after the hook was answered; the Interrupt hook confirms', async () => {
      const s = await readyCodex();
      await submit(s);
      await pre(s, 't1');
      const paused = s.session.pause();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(escapes(s.pty)).toBe(0);

      await expect(post(s, 't1')).resolves.toBeNull();
      expect(escapes(s.pty)).toBe(0); // only after the response went out
      await vi.advanceTimersByTimeAsync(1);
      expect(escapes(s.pty)).toBe(1);
      await s.hook({ hook_event_name: 'Interrupt' });
      await expect(paused).resolves.toEqual({ point: 'after_tool', tool: 'Bash' });
      expect(escapes(s.pty)).toBe(1);
    });

    it('sends the Esc at once when no tool runs: the stop is before the next one', async () => {
      const s = await readyCodex();
      await submit(s);
      const paused = s.session.pause();
      await vi.advanceTimersByTimeAsync(1);
      expect(escapes(s.pty)).toBe(1);
      await s.hook({ hook_event_name: 'Interrupt' });
      await expect(paused).resolves.toEqual({ point: 'before_tool', tool: null });
    });

    it('reports interrupted, with the tool, when one starts between the Esc and its confirmation', async () => {
      const s = await readyCodex();
      await submit(s);
      const paused = s.session.pause();
      await vi.advanceTimersByTimeAsync(1);
      await pre(s, 't1');
      await s.hook({ hook_event_name: 'Interrupt' });
      await expect(paused).resolves.toEqual({ point: 'interrupted', tool: 'Bash' });
    });

    it('does not wait for a tool whose approval was denied: no PostToolUse comes for it', async () => {
      const s = start({
        adapter: codex(),
        spec: { provider: 'codex' },
        broker: { decide: () => Promise.resolve({ behavior: 'deny', message: 'No.' }) },
      });
      await s.hook({ hook_event_name: 'SessionStart', source: 'startup' });
      await vi.advanceTimersByTimeAsync(CODEX_TIMING.readySettleMs);
      await submit(s);
      await pre(s, 't1');
      const first = s.session.pause();
      await s.hook({ hook_event_name: 'PermissionRequest', ...BASH, tool_use_id: 't1' });
      await expect(first).resolves.toEqual({ point: 'waiting_permission', tool: 'Bash' });

      // The denial lets the agent carry on, and there is no tool left to wait for: the Esc goes out.
      await vi.advanceTimersByTimeAsync(1);
      expect(escapes(s.pty)).toBe(1);
      await s.hook({ hook_event_name: 'Interrupt' });
      expect(log(s.events).at(-1)).toBe('paused(before_tool,null)');
    });

    it('stops a forced pause on the Interrupt hook, with the one Esc of the forced way', async () => {
      const s = await readyCodex();
      await submit(s);
      await pre(s, 't1');
      const paused = s.session.forcePause();
      expect(escapes(s.pty)).toBe(1);
      await s.hook({ hook_event_name: 'Interrupt' });
      await expect(paused).resolves.toEqual({ point: 'interrupted', tool: 'Bash' });
      expect(escapes(s.pty)).toBe(1);
    });
  });
});
