import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunnerEvent, StartSessionSpec } from '../contracts';
import type { HookPayload } from './hook-payload';
import { createClaudeAdapter } from './providers/claude';
import { AgentSession, type PtyProcess } from './session';
import { silentLogger, tempDirs, waitFor } from './test-helpers';

/**
 * Token usage (PM-178) through the session with real transcript files: the main transcript as it
 * grows, and a subagent's own transcript when its SubagentStop hook names it.
 */

const fakePty = (): PtyProcess => ({
  pid: process.pid,
  write: () => undefined,
  resize: () => undefined,
  kill: () => undefined,
  onData: () => undefined,
  onExit: () => undefined,
});

const spec: StartSessionSpec = {
  sessionId: 'ses_usage',
  claudeSessionId: '0b8a3c2e-1f5d-4c4e-9a7b-2d6e8f1a3b5c',
  resume: false,
  cwd: '/work',
  displayName: 'Anna · fe-1',
  appendSystemPrompt: '',
  mcpUrl: 'http://127.0.0.1:4700/mcp/tok',
  allowedTools: [],
};

const dirs = tempDirs();
const sessions: AgentSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.stop(true).catch(() => undefined);
    session.dispose();
  }
  await dirs.cleanup();
});

function start(transcriptRoot?: string) {
  const events: RunnerEvent[] = [];
  let exit: ((event: { exitCode: number }) => void) | null = null;
  const session = new AgentSession({
    spec,
    hookToken: 'tok',
    adapter: createClaudeAdapter({ bin: 'claude', logger: silentLogger() }),
    deps: {
      logger: silentLogger(),
      broker: { decide: () => new Promise(() => undefined) },
      permissionTimeoutMs: 60_000,
      emit: (event) => events.push(event),
      onExited: () => undefined,
      ...(transcriptRoot ? { transcriptRoot } : {}),
      spawnPty: () => ({
        ...fakePty(),
        kill: () => exit?.({ exitCode: 0 }),
        onExit: (listener) => {
          exit = listener;
        },
      }),
    },
  });
  sessions.push(session);
  session.spawn('claude', [], {});
  const hook = (payload: Omit<HookPayload, 'hook_event_name'> & { hook_event_name: string }) =>
    session.handleHook(payload, new AbortController().signal);
  const usage = () =>
    events.flatMap((e) => (e.type === 'usage' ? e.entries.map((entry) => ({ ...entry })) : []));
  return { hook, usage, events };
}

const response = (id: string, model: string, output: number, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({
    type: 'assistant',
    uuid: `u-${id}-${output}`,
    timestamp: new Date().toISOString(),
    ...extra,
    message: {
      id,
      role: 'assistant',
      model,
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: 10,
        output_tokens: output,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 20,
      },
    },
  })}\n`;

describe('token usage of a session (PM-178)', () => {
  it('reports the usage of the transcript as it grows, and a subagent’s when it stops', async () => {
    const home = await dirs.make();
    const transcript = path.join(home, 'conversation.jsonl');
    await writeFile(transcript, response('msg_1', 'claude-opus-5-5', 1));
    const { hook, usage } = start();
    await hook({ hook_event_name: 'SessionStart', source: 'startup', transcript_path: transcript });
    await waitFor(() => usage().length === 1, { what: 'the first usage' });
    expect(usage()).toEqual([
      { model: 'claude-opus-5-5', scope: 'main', input: 10, output: 1, cacheRead: 100, cacheWrite: 20 },
    ]);

    // The response's final entry, with its real output count.
    await appendFile(transcript, response('msg_1', 'claude-opus-5-5', 6));
    await waitFor(() => usage().length === 2, { what: 'the output difference' });
    expect(usage()[1]).toEqual({
      model: 'claude-opus-5-5',
      scope: 'main',
      input: 0,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
    });

    const agentFile = path.join(home, 'conversation', 'subagents', 'agent-a1.jsonl');
    await mkdir(path.dirname(agentFile), { recursive: true });
    await writeFile(agentFile, response('msg_sub', 'claude-haiku-4-5', 3, { isSidechain: true }));
    await hook({
      hook_event_name: 'SubagentStop',
      transcript_path: transcript,
      agent_id: 'a1',
      agent_type: 'Explore',
      agent_transcript_path: agentFile,
    });
    await waitFor(() => usage().length === 3, { what: 'the subagent usage' });
    expect(usage()[2]).toEqual({
      model: 'claude-haiku-4-5',
      scope: 'subagent',
      input: 10,
      output: 3,
      cacheRead: 100,
      cacheWrite: 20,
    });
  });

  it("reads a worker's subagent transcript only inside the worker home", async () => {
    const home = await dirs.make('worker-home-');
    const elsewhere = await dirs.make('elsewhere-');
    const transcript = path.join(home, 'conversation.jsonl');
    await writeFile(transcript, '');
    const outside = path.join(elsewhere, 'agent-x.jsonl');
    await writeFile(outside, response('msg_out', 'claude-haiku-4-5', 3));
    const inside = path.join(home, 'agent-y.jsonl');
    await writeFile(inside, response('msg_in', 'claude-haiku-4-5', 4));
    const { hook, usage, events } = start(home);
    await hook({ hook_event_name: 'SessionStart', source: 'startup', transcript_path: transcript });
    // The transcript in a worker home is followed once its real directory is checked.
    await waitFor(() => events.some((e) => e.type === 'transcript_path'), {
      timeoutMs: 2_000,
      what: 'the transcript followed',
    });

    await hook({ hook_event_name: 'SubagentStop', agent_id: 'x', agent_transcript_path: outside });
    await hook({ hook_event_name: 'SubagentStop', agent_id: 'y', agent_transcript_path: inside });
    await waitFor(() => usage().length === 1, { what: 'the usage inside the home' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(usage()).toEqual([
      { model: 'claude-haiku-4-5', scope: 'subagent', input: 10, output: 4, cacheRead: 100, cacheWrite: 20 },
    ]);
  });
});
