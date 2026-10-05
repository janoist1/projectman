import { appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunnerEvent, StartSessionSpec } from '../contracts';
import type { HookPayload } from './hook-payload';
import { createClaudeAdapter } from './providers/claude';
import { createGeminiAdapter } from './providers/gemini';
import { geminiSpec } from './providers/gemini/test-helpers';
import { AgentSession, type PtyProcess } from './session';
import { silentLogger, tempDirs } from './test-helpers';

/**
 * A turn the transcript ended (`end_turn`) is over (PM-343): a late tool hook does not reopen it, a
 * session whose Stop hook never came is closed, and a forced pause takes it as stopped.
 */

const spec: StartSessionSpec = {
  sessionId: 'ses_turn_end',
  claudeSessionId: '0b8a3c2e-1f5d-4c4e-9a7b-2d6e8f1a3b5c',
  resume: false,
  cwd: '/work',
  displayName: 'Anna · fe-1',
  appendSystemPrompt: '',
  mcpUrl: 'http://127.0.0.1:4700/mcp/tok',
  allowedTools: [],
};

const GRACE_MS = 150;

const dirs = tempDirs();
const sessions: AgentSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.stop(true).catch(() => undefined);
    session.dispose();
  }
  await dirs.cleanup();
});

async function start(graceMs = GRACE_MS, gemini = false) {
  const home = await dirs.make();
  const transcript = path.join(home, 'conversation.jsonl');
  await writeFile(transcript, '');
  const events: RunnerEvent[] = [];
  const writes: string[] = [];
  let exit: ((event: { exitCode: number }) => void) | null = null;
  const pty: PtyProcess = {
    pid: 4242,
    write: (data) => writes.push(data),
    resize: () => undefined,
    kill: () => exit?.({ exitCode: 0 }),
    onData: () => undefined,
    onExit: (listener) => {
      exit = listener;
    },
  };
  const claude = createClaudeAdapter({ bin: 'claude', logger: silentLogger() });
  const adapter = gemini ? createGeminiAdapter({ bin: 'unused', logger: silentLogger() }) : claude;
  const session = new AgentSession({
    spec: gemini ? geminiSpec('/work', { initialMessage: null }) : spec,
    hookToken: 'tok',
    adapter: { ...adapter, timing: { ...adapter.timing, turnEndGraceMs: graceMs } },
    deps: {
      logger: silentLogger(),
      broker: {
        decide: () => (gemini ? Promise.resolve({ behavior: 'allow' }) : new Promise(() => undefined)),
      },
      permissionTimeoutMs: 60_000,
      emit: (event) => events.push(event),
      onExited: () => undefined,
      spawnPty: () => pty,
    },
  });
  sessions.push(session);
  session.spawn('claude', [], {});
  const hook = (payload: Omit<HookPayload, 'hook_event_name'> & { hook_event_name: string }) =>
    session.handleHook({ transcript_path: transcript, ...payload }, new AbortController().signal);
  const assistant = (uuid: string, stopReason: string | null, content: unknown[], at: Date = new Date()) =>
    appendFile(
      transcript,
      `${JSON.stringify(
        gemini
          ? {
              type: 'PLANNER_RESPONSE',
              step_index: 1,
              created_at: at.toISOString(),
              content: 'Done.',
              input_tokens: 1,
              output_tokens: 1,
            }
          : {
              type: 'assistant',
              uuid,
              timestamp: at.toISOString(),
              message: { id: `msg-${uuid}`, role: 'assistant', stop_reason: stopReason, content },
            },
      )}\n`,
    );
  const states = () =>
    events
      .filter((e): e is Extract<RunnerEvent, { type: 'state' }> => e.type === 'state')
      .map((e) => e.state);
  await hook({ hook_event_name: 'SessionStart', source: 'startup' });
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });
  return { session, hook, assistant, writes, events, states };
}

const waitFor = async (check: () => boolean, ms = 3_000) => {
  const until = Date.now() + ms;
  while (!check() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
  return check();
};

const ENDING = [{ type: 'text', text: 'Done.' }];
const lateTool = { hook_event_name: 'PreToolUse', tool_name: 'ToolSearch', tool_use_id: 'late' };

describe('a turn the transcript ended (PM-343)', () => {
  it('still decides late Gemini calls without reopening the ended turn', async () => {
    const { session, hook, assistant, states } = await start(GRACE_MS, true);
    await assistant('gm1', 'end_turn', ENDING);
    await hook({ hook_event_name: 'Stop' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const call = (command: string): HookPayload => ({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      gemini_tool: 'run_command',
      gemini_args: { CommandLine: command, Cwd: '/work' },
    });
    expect(await hook(call('npm test'))).toEqual({ decision: 'allow' });
    expect(await hook(call('echo ask'))).toEqual({ decision: 'allow' });
    expect(session.state.state).toBe('idle');
    expect(states().slice(-1)).toEqual(['idle']);
  });
  it('is closed when the Stop hook never comes', async () => {
    const { session, assistant } = await start();
    expect(session.state.state).toBe('working');
    await assistant('a1', 'end_turn', ENDING);
    expect(await waitFor(() => session.state.state === 'idle')).toBe(true);
  });

  it('is not reopened by a late tool hook after the Stop hook', async () => {
    const { session, hook, assistant, states } = await start();
    await assistant('a1', 'end_turn', ENDING);
    await hook({ hook_event_name: 'Stop' });
    expect(session.state.state).toBe('idle');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await hook(lateTool);
    await hook({ hook_event_name: 'PostToolUse', tool_name: 'ToolSearch', tool_use_id: 'late' });
    expect(session.state.state).toBe('idle');
    expect(states().at(-1)).toBe('idle');
  });

  it('is closed after a late tool hook reopened it before the transcript was read', async () => {
    const { session, hook, assistant } = await start();
    await hook({ hook_event_name: 'Stop' });
    await hook(lateTool);
    expect(session.state.state).toBe('working');
    await assistant('a1', 'end_turn', ENDING);
    expect(await waitFor(() => session.state.state === 'idle')).toBe(true);
  });

  it('goes on when the transcript continues after it, and with the next message', async () => {
    const { session, hook, assistant } = await start();
    await assistant('a1', 'end_turn', ENDING);
    await assistant('a2', 'tool_use', [{ type: 'tool_use', id: 't2', name: 'Bash', input: {} }]);
    await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 2));
    expect(session.state.state).toBe('working');
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't2' });
    expect(session.state.state).toBe('working');
    await hook({ hook_event_name: 'Stop' });
    await assistant('a3', 'end_turn', ENDING);
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'next' });
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't4' });
    expect(session.state.state).toBe('working');
  });

  it('begins a new turn without a prompt: its tool hook, which came first, is replayed', async () => {
    const { session, hook, assistant } = await start();
    await assistant('a1', 'end_turn', ENDING);
    await hook({ hook_event_name: 'Stop' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'bg2' });
    expect(session.state.state).toBe('idle');
    await hook(lateTool);
    await assistant('a2', 'tool_use', [{ type: 'tool_use', id: 'bg2', name: 'Bash', input: {} }]);
    expect(await waitFor(() => session.state.state === 'working')).toBe(true);
    // The ghost call has no transcript entry: only the Bash call is a running tool.
    await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 2));
    expect(session.state.state).toBe('working');
    // A pause waits for the running Bash call; it does not settle as idle at once.
    const settled = await Promise.race([
      session.pause().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200)),
    ]);
    expect(settled).toBe(false);
  });

  it('begins a new turn without a prompt: a call that finished before the transcript was read', async () => {
    const { session, hook, assistant } = await start();
    await assistant('a1', 'end_turn', ENDING);
    await hook({ hook_event_name: 'Stop' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'bg2' });
    await hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'bg2' });
    await assistant('a2', 'tool_use', [{ type: 'tool_use', id: 'bg2', name: 'Bash', input: {} }]);
    expect(await waitFor(() => session.state.state === 'working')).toBe(true);
  });

  it('is not a turn end of the running turn when the entry is older than its prompt', async () => {
    const { session, hook, assistant, events } = await start();
    await hook({ hook_event_name: 'Stop' });
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'next' });
    await assistant('a1', 'end_turn', ENDING, new Date(Date.now() - 60_000));
    expect(await waitFor(() => events.some((e) => e.type === 'chat'))).toBe(true);
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't1' });
    await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 2));
    expect(session.state.state).toBe('working');
  });

  it('is taken as stopped by a forced pause: no Esc, the pause settles', async () => {
    const { session, hook, assistant, writes, events } = await start(60_000);
    await hook(lateTool);
    await assistant('a1', 'end_turn', ENDING);
    expect(await waitFor(() => events.some((e) => e.type === 'chat'))).toBe(true);
    expect(session.state.state).toBe('working');
    await expect(session.pause({ forceAfterMs: 0 })).resolves.toEqual({ point: 'turn_end', tool: null });
    expect(writes.filter((w) => w === '\x1b')).toHaveLength(0);
    expect(session.state.state).toBe('idle');
  });

  it('is taken as stopped by a forced pause whose Esc nothing confirms', async () => {
    const { session, hook, assistant, writes, events } = await start(60_000);
    await hook(lateTool);
    const paused = session.pause({ forceAfterMs: 0 });
    expect(writes.filter((w) => w === '\x1b')).toHaveLength(1);
    await assistant('a1', 'end_turn', ENDING);
    expect(await waitFor(() => events.some((e) => e.type === 'chat'))).toBe(true);
    await expect(paused).resolves.toMatchObject({ point: 'interrupted' });
    expect(session.state.state).toBe('idle');
  });
});
