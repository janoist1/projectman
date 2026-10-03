import { appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunnerEvent, StartSessionSpec } from '../contracts';
import type { HookPayload } from './hook-payload';
import { createClaudeAdapter } from './providers/claude';
import { AgentSession, type PtyProcess } from './session';
import { silentLogger, tempDirs } from './test-helpers';

/**
 * A forced pause (PM-218) of a Claude Code session is confirmed by the interruption the transcript
 * records, read from a real file: no screen, no Stop hook.
 */

const spec: StartSessionSpec = {
  sessionId: 'ses_pause',
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

function start() {
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
      spawnPty: () => pty,
    },
  });
  sessions.push(session);
  session.spawn('claude', [], {});
  const hook = (payload: Omit<HookPayload, 'hook_event_name'> & { hook_event_name: string }) =>
    session.handleHook(payload, new AbortController().signal);
  return { session, hook, writes, events };
}

describe('a forced pause of Claude Code (PM-218)', () => {
  it('is confirmed by the interruption in the transcript, with one Esc and no screen to look at', async () => {
    const home = await dirs.make();
    const transcript = path.join(home, 'conversation.jsonl');
    await writeFile(transcript, '');
    const { session, hook, writes, events } = start();
    await hook({ hook_event_name: 'SessionStart', source: 'startup', transcript_path: transcript });
    await hook({ hook_event_name: 'UserPromptSubmit', transcript_path: transcript, prompt: 'go' });
    await hook({
      hook_event_name: 'PreToolUse',
      transcript_path: transcript,
      tool_name: 'Bash',
      tool_use_id: 't1',
      tool_input: { command: 'sleep 60' },
    });

    const paused = session.forcePause();
    expect(writes.filter((w) => w === '\x1b')).toHaveLength(1);

    await appendFile(
      transcript,
      `${JSON.stringify({
        type: 'user',
        uuid: 'u-interrupt',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
      })}\n`,
    );
    await expect(paused).resolves.toEqual({ point: 'interrupted', tool: 'Bash' });
    expect(writes.filter((w) => w === '\x1b')).toHaveLength(1);
    expect(session.state.state).toBe('idle');
    expect(events.filter((e) => e.type === 'session_paused')).toHaveLength(1);
  });
});
