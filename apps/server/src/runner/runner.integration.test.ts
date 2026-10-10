import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  formatInjectedTeamMessage,
  mergeTokenUsage,
  type ChatItem,
  type SessionState,
} from '@projectman/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  PermissionBroker,
  PermissionDecision,
  PermissionRequestInfo,
  QuestionForwardInfo,
  RunnerEvent,
  RunnerModule,
  StartSessionSpec,
} from '../contracts';
import { createRunnerModule } from './index';
import { FAKE_CLAUDE, freePort, silentLogger, tempDirs, waitFor } from './test-helpers';

/**
 * End to end: a real Fastify server with the hook routes, the runner, and the fake Claude
 * Code CLI (test/fixtures/fake-claude.mjs) in a real pseudo-terminal.
 */

type BrokerAnswer = PermissionDecision | 'wait';

const dirs = tempDirs();
const savedEnv = { ...process.env };

let app: FastifyInstance;
let runner: RunnerModule;
let events: RunnerEvent[];
let requests: Array<{ info: PermissionRequestInfo; signal: AbortSignal }>;
let answers: BrokerAnswer[];
/** Questions the agent asked at its terminal, and whether the broker takes them (PM-199). */
let forwarded: QuestionForwardInfo[];
let forwardResult: boolean;
let cwd: string;
let configFile: string;
let transcriptDir: string;
let argsFile: string;

const broker: PermissionBroker = {
  decide(info, signal) {
    requests.push({ info, signal });
    const answer = answers.shift() ?? { behavior: 'deny', message: 'no answer configured' };
    if (answer === 'wait') {
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    }
    return Promise.resolve(answer);
  },
  forwardQuestion(info) {
    forwarded.push(info);
    return Promise.resolve(forwardResult);
  },
};

async function setup(
  options: { permissionTimeoutMs?: number; trustWorkspaces?: boolean } = {},
): Promise<void> {
  const port = await freePort();
  app = Fastify({ logger: false });
  runner = createRunnerModule({
    claudeBin: FAKE_CLAUDE,
    publicBaseUrl: `http://127.0.0.1:${port}`,
    broker,
    permissionTimeoutMs: options.permissionTimeoutMs ?? 10_000,
    logger: silentLogger(),
    claudeConfigPath: configFile,
    trustWorkspaces: options.trustWorkspaces,
    instanceTag: 'tag-of-this-test',
  });
  runner.registerHookRoutes(app);
  await app.listen({ host: '127.0.0.1', port });
  runner.runner.onEvent((event) => events.push(event));
}

beforeEach(async () => {
  events = [];
  requests = [];
  answers = [];
  forwarded = [];
  forwardResult = false;
  cwd = await dirs.make('ws-');
  transcriptDir = await dirs.make('transcripts-');
  const home = await dirs.make('claude-home-');
  configFile = path.join(home, '.claude.json');
  await writeFile(configFile, JSON.stringify({ numStartups: 1, projects: {} }, null, 2));
  argsFile = path.join(home, 'args.json');
  process.env.FAKE_CLAUDE_TRANSCRIPT_DIR = transcriptDir;
  process.env.FAKE_CLAUDE_CONFIG_FILE = configFile;
  process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-must-not-leak';
  process.env.NANOGPT_API_KEY = 'inherited-nanogpt-must-not-leak';
  // A dead proxy: the SessionStart forwarder (curl honours http_proxy) only reaches the
  // server because the runner puts the loopback hosts into no_proxy.
  process.env.http_proxy = 'http://127.0.0.1:9';
  process.env.HTTP_PROXY = 'http://127.0.0.1:9';
});

afterEach(async () => {
  await runner?.runner.shutdown();
  await app?.close();
  await dirs.cleanup();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

function spec(extra: Partial<StartSessionSpec> = {}): StartSessionSpec {
  return {
    sessionId: `ses_${randomUUID().slice(0, 8)}`,
    claudeSessionId: randomUUID(),
    resume: false,
    cwd,
    displayName: 'Anna · fe-1',
    appendSystemPrompt: 'You are fe-1, a developer.',
    initialMessage: null,
    mcpUrl: 'http://127.0.0.1:1/mcp/token',
    allowedTools: ['mcp__team'],
    member: 'fe-1',
    cols: 100,
    rows: 30,
    ...extra,
  };
}

const statesOf = (id: string): SessionState[] =>
  events
    .filter((e): e is Extract<RunnerEvent, { type: 'state' }> => e.type === 'state' && e.sessionId === id)
    .map((e) => e.state)
    .filter((state, i, all) => i === 0 || all[i - 1] !== state);
const stateOf = (id: string): SessionState | undefined => statesOf(id).at(-1);
const chatOf = (id: string): ChatItem[] =>
  events.flatMap((e) => (e.type === 'chat' && e.sessionId === id ? e.items : []));
const waitState = (id: string, state: SessionState, timeoutMs = 10_000) =>
  waitFor(() => stateOf(id) === state, { timeoutMs, what: `state ${state} (now ${stateOf(id)})` });
const waitChat = (id: string, match: (item: ChatItem) => boolean, what: string, timeoutMs = 10_000) =>
  waitFor(() => chatOf(id).find(match), { timeoutMs, what });
const assistantSaid = (id: string, text: string) =>
  waitChat(id, (i) => i.kind === 'assistant_text' && i.text === text, `assistant: ${text}`);

// Hooks and transcript events do not imply the PTY output has reached xterm's async parser.
const waitSnapshot = (id: string, text: string) =>
  waitFor(
    () => {
      const snapshot = runner.runner.snapshot(id);
      return snapshot?.data.includes(text) ? snapshot : null;
    },
    { what: `terminal snapshot: ${text}` },
  );

describe('runner with the fake Claude Code CLI', { timeout: 30_000 }, () => {
  it('starts the session with the cheap subagent on its model (PM-179)', async () => {
    await setup();
    const reader = {
      name: 'reader-haiku',
      description: 'A reader on the cheaper Haiku model.',
      prompt: 'Return a short result, not raw output.',
      tools: ['Read', 'Grep', 'Glob', 'Bash'],
      model: 'haiku',
    };
    const started = await runner.runner.start(spec({ subagents: [reader] }));
    // The fake refuses malformed --agents at start, as Claude Code does: it got as far as ready.
    await waitState(started.sessionId, 'idle');
    const { argv } = JSON.parse(await readFile(argsFile, 'utf8')) as { argv: string[] };
    expect(JSON.parse(argv[argv.indexOf('--agents') + 1]!)).toEqual({
      'reader-haiku': {
        description: reader.description,
        prompt: reader.prompt,
        tools: ['Read', 'Grep', 'Glob', 'Bash'],
        model: 'haiku',
      },
    });
    await runner.runner.stop(started.sessionId, { force: true });
  });

  it('invalidates the hook capability when its process exits', async () => {
    await setup();
    const started = await runner.runner.start(spec());
    await waitFor(() => stateOf(started.sessionId) === 'idle', { what: 'fake session ready' });
    const { argv: args } = JSON.parse(await readFile(argsFile, 'utf8')) as { argv: string[] };
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]!);
    const hook = new URL(settings.hooks.Stop[0].hooks[0].url);
    await runner.runner.stop(started.sessionId, { force: true });
    await waitFor(() => !runner.runner.isRunning(started.sessionId), { what: 'fake session stopped' });
    const response = await app.inject({
      method: 'POST',
      url: hook.pathname,
      payload: { hook_event_name: 'PermissionRequest', tool_name: 'Bash' },
    });
    expect(response.statusCode).toBe(404);
    expect(requests).toHaveLength(0);
  });

  it('starts a session, types the kick-off brief when ready and follows the turn', async () => {
    await setup();
    const s = spec({ initialMessage: 'Hello from the brief' });
    const info = await runner.runner.start(s);
    expect(info).toMatchObject({ sessionId: s.sessionId, state: 'starting', cols: 100, rows: 30 });
    expect(info.pid).toBeGreaterThan(0);
    expect(runner.runner.isRunning(s.sessionId)).toBe(true);
    expect(runner.runner.list().map((i) => i.sessionId)).toEqual([s.sessionId]);

    await assistantSaid(s.sessionId, 'Echo: Hello from the brief');
    await waitState(s.sessionId, 'idle');
    expect(statesOf(s.sessionId)).toEqual(['starting', 'idle', 'working', 'idle']);
    expect(chatOf(s.sessionId).map((i) => i.kind)).toEqual(['user_text', 'assistant_text']);
    expect(chatOf(s.sessionId)[0]).toMatchObject({ origin: 'brief' });
    expect(chatOf(s.sessionId)[0]).toMatchObject({ kind: 'user_text', text: 'Hello from the brief' });

    const pathEvent = events.find((e) => e.type === 'transcript_path');
    expect(pathEvent).toEqual({
      type: 'transcript_path',
      sessionId: s.sessionId,
      path: path.join(transcriptDir, `${s.claudeSessionId}.jsonl`),
    });
    expect(
      await runner.transcripts.read(path.join(transcriptDir, `${s.claudeSessionId}.jsonl`), { self: 'fe-1' }),
    ).toEqual(chatOf(s.sessionId));

    const snapshot = await waitSnapshot(s.sessionId, 'Echo: Hello from the brief');
    expect(snapshot).toMatchObject({ cols: 100, rows: 30 });
    expect(snapshot!.data).toContain('Echo: Hello from the brief');
    expect(events.some((e) => e.type === 'terminal_data' && e.sessionId === s.sessionId)).toBe(true);

    // The workspace was trusted up front, so the fake showed no trust dialog.
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    expect(config.projects[cwd].hasTrustDialogAccepted).toBe(true);
    expect(config.numStartups).toBe(1);
  });

  it("reports each turn's token usage per model, and a subagent's on its own rows (PM-178)", async () => {
    await setup();
    const s = spec({ model: 'claude-opus-5-5' });
    await runner.runner.start(s);
    await waitState(s.sessionId, 'idle');
    const usage = () =>
      mergeTokenUsage(
        events.flatMap((e) => (e.type === 'usage' && e.sessionId === s.sessionId ? e.entries : [])),
      );

    await runner.runner.sendUserMessage(s.sessionId, 'Hello');
    await assistantSaid(s.sessionId, 'Echo: Hello');
    // The reply's two entries are one response: counted once, with its final output count.
    await waitFor(() => usage()[0]?.output === 5, { what: 'the first turn usage' });
    expect(usage()).toEqual([
      { model: 'claude-opus-5-5', scope: 'main', input: 10, output: 5, cacheRead: 100, cacheWrite: 20 },
    ]);

    await runner.runner.sendUserMessage(s.sessionId, 'Look around SUBAGENT');
    await assistantSaid(s.sessionId, 'Echo: Look around SUBAGENT');
    await waitFor(() => usage()[0]?.output === 10 && usage().length === 2, { what: 'the second turn usage' });
    expect(usage()).toEqual([
      { model: 'claude-opus-5-5', scope: 'main', input: 20, output: 10, cacheRead: 200, cacheWrite: 40 },
      { model: 'claude-fake-haiku', scope: 'subagent', input: 3, output: 2, cacheRead: 30, cacheWrite: 0 },
    ]);
  });

  it('launches claude with the documented flags and a subscription-only environment', async () => {
    await setup();
    const s = spec({ model: 'opus', permissionMode: 'acceptEdits' });
    await runner.runner.start(s);
    await waitState(s.sessionId, 'idle');
    const { argv, env, cwd: childCwd } = JSON.parse(await readFile(argsFile, 'utf8'));
    const flag = (name: string) => argv[argv.indexOf(name) + 1];
    expect(childCwd).toBe(cwd);
    expect(flag('--session-id')).toBe(s.claudeSessionId);
    expect(flag('--append-system-prompt')).toBe('You are fe-1, a developer.');
    expect(JSON.parse(flag('--mcp-config'))).toEqual({
      mcpServers: { team: { type: 'http', url: s.mcpUrl } },
    });
    const settings = JSON.parse(flag('--settings'));
    expect(settings.permissions.allow).toEqual(['mcp__team']);
    expect(settings.hooks.Stop[0].hooks[0].url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hooks\/[\w-]{20,}$/);
    expect(flag('--model')).toBe('opus');
    expect(flag('--permission-mode')).toBe('acceptEdits');
    expect(flag('-n')).toBe('Anna · fe-1');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('NANOGPT_API_KEY');
    expect(env).toMatchObject({
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      PROJECTMAN_SESSION_ID: s.sessionId,
      // The marker of the machine display (PM-320): the module hands the instance's tag to the session.
      PROJECTMAN_INSTANCE: 'tag-of-this-test',
    });
    expect(env.NO_PROXY.split(',')).toEqual(expect.arrayContaining(['127.0.0.1', 'localhost', '::1']));
    expect(env.no_proxy.split(',')).toEqual(expect.arrayContaining(['127.0.0.1', 'localhost', '::1']));
  });

  it('gives the fake claude the compaction window in --settings, on a new and a resumed session (PM-212)', async () => {
    await setup();
    // A conversation with a turn in it, as the restart tests above: only that can be resumed.
    const s = spec({ autoCompactWindowTokens: 200_000, initialMessage: 'first run' });
    await runner.runner.start(s);
    await assistantSaid(s.sessionId, 'Echo: first run');
    await waitState(s.sessionId, 'idle');
    const settingsOf = async () => {
      const { argv } = JSON.parse(await readFile(argsFile, 'utf8')) as { argv: string[] };
      return { argv, settings: JSON.parse(argv[argv.indexOf('--settings') + 1]!) };
    };
    const fresh = await settingsOf();
    expect(fresh.argv).toContain('--session-id');
    expect(fresh.settings.autoCompactWindow).toBe(200_000);
    await runner.runner.stop(s.sessionId);

    await runner.runner.start({
      ...s,
      resume: true,
      initialMessage: 'second run',
      autoCompactWindowTokens: 150_000,
    });
    await assistantSaid(s.sessionId, 'Echo: second run');
    const resumed = await settingsOf();
    expect(resumed.argv).toContain('--resume');
    expect(resumed.settings.autoCompactWindow).toBe(150_000);
    await runner.runner.stop(s.sessionId, { force: true });
  });

  it('queues messages while working and types long, multi-line text without paste collapse', async () => {
    await setup();
    const s = spec();
    await runner.runner.start(s);
    await waitState(s.sessionId, 'idle');

    const long = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}: ${'detail '.repeat(12)}`.trim()).join(
      '\n',
    );
    const typed = Promise.all([
      runner.runner.sendUserMessage(s.sessionId, 'SLOW first task'),
      runner.runner.sendUserMessage(s.sessionId, `Second task\n\n${long}`),
      runner.runner.sendUserMessage(s.sessionId, '!important: not a shell command'),
    ]);
    await typed;
    await assistantSaid(s.sessionId, 'Echo: !important: not a shell command');

    const prompts = chatOf(s.sessionId).filter((i) => i.kind === 'user_text');
    expect(prompts.map((i) => (i.kind === 'user_text' ? i.text : ''))).toEqual([
      'SLOW first task',
      `Second task\n\n${long}`,
      '!important: not a shell command',
    ]);
    const replies = chatOf(s.sessionId).filter((i) => i.kind === 'assistant_text');
    expect(replies.map((i) => (i.kind === 'assistant_text' ? i.text : ''))).toEqual([
      'Echo: SLOW first task',
      'Echo: Second task',
      'Echo: !important: not a shell command',
    ]);
    await waitState(s.sessionId, 'idle');
  });

  it('asks the broker for permission and remembers an "allow for this session"', async () => {
    await setup();
    const s = spec();
    await runner.runner.start(s);
    await waitState(s.sessionId, 'idle');

    answers.push({ behavior: 'allow', rememberForSession: true });
    await runner.runner.sendUserMessage(s.sessionId, 'Please PERMISSION push');
    await assistantSaid(s.sessionId, 'Echo: Please PERMISSION push');
    expect(statesOf(s.sessionId)).toEqual([
      'starting',
      'idle',
      'working',
      'waiting_permission',
      'working',
      'idle',
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.info).toMatchObject({
      sessionId: s.sessionId,
      toolName: 'Bash',
      toolInput: { command: 'git push' },
    });
    expect(chatOf(s.sessionId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'tool_call', name: 'Bash', summary: 'git push' }),
        expect.objectContaining({ kind: 'tool_result', ok: true, summary: 'Everything up-to-date' }),
      ]),
    );
    const working = events.find(
      (e) => e.type === 'state' && e.sessionId === s.sessionId && e.state === 'waiting_permission',
    );
    expect(working).toMatchObject({ activity: 'Bash: git push' });

    // The session rule applies to the same command: no second request.
    await waitState(s.sessionId, 'idle');
    await runner.runner.sendUserMessage(s.sessionId, 'Again PERMISSION push');
    await assistantSaid(s.sessionId, 'Echo: Again PERMISSION push');
    expect(requests).toHaveLength(1);
  });

  it('does not ask for pre-allowed tools (rules as core passes them)', async () => {
    await setup();
    const s = spec({
      allowedTools: ['mcp__team__*', 'Read', 'Grep', 'Bash(git diff:*)', 'Bash(git push:*)'],
    });
    await runner.runner.start(s);
    await waitState(s.sessionId, 'idle');
    await runner.runner.sendUserMessage(s.sessionId, 'PERMISSION and TEAM');
    await assistantSaid(s.sessionId, 'Echo: PERMISSION and TEAM');
    expect(requests).toHaveLength(0);
    expect(statesOf(s.sessionId)).not.toContain('waiting_permission');
  });

  it('denies with the broker message, and automatically after the timeout', async () => {
    await setup({ permissionTimeoutMs: 700 });
    const s = spec();
    await runner.runner.start(s);
    await waitState(s.sessionId, 'idle');

    answers.push({ behavior: 'deny', message: 'Not on Fridays' });
    await runner.runner.sendUserMessage(s.sessionId, 'Try PERMISSION one');
    await assistantSaid(s.sessionId, 'Echo: Try PERMISSION one');
    expect(chatOf(s.sessionId)).toContainEqual(
      expect.objectContaining({ kind: 'tool_result', ok: false, summary: 'Not on Fridays' }),
    );

    await waitState(s.sessionId, 'idle');
    answers.push('wait');
    await runner.runner.sendUserMessage(s.sessionId, 'Try PERMISSION two');
    await assistantSaid(s.sessionId, 'Echo: Try PERMISSION two');
    expect(requests[1]!.signal.aborted).toBe(true);
    const denied = chatOf(s.sessionId).filter((i) => i.kind === 'tool_result' && !i.ok);
    expect(denied.at(-1)).toMatchObject({ summary: expect.stringContaining('No human answered') });
  });

  it('shows team messages in both directions', async () => {
    await setup();
    const s = spec();
    await runner.runner.start(s);
    await waitState(s.sessionId, 'idle');
    await runner.runner.sendUserMessage(
      s.sessionId,
      formatInjectedTeamMessage('qa', 'Please TEAM check', 'ACME-21'),
    );
    await assistantSaid(s.sessionId, 'Echo: [team message from qa about ACME-21]');
    expect(requests).toHaveLength(0); // mcp__team is pre-allowed
    const team = chatOf(s.sessionId).filter((i) => i.kind === 'team_message');
    expect(team).toEqual([
      expect.objectContaining({ direction: 'in', from: 'qa', to: ['fe-1'], text: 'Please TEAM check' }),
      expect.objectContaining({ direction: 'out', from: 'fe-1', to: ['qa'], text: 'Ready for review' }),
    ]);
  });

  it('forwards a terminal question to the broker and turns the call away instead of waiting (PM-199)', async () => {
    forwardResult = true;
    await setup();
    const s = spec();
    await runner.runner.start(s);
    await waitState(s.sessionId, 'idle');

    await runner.runner.sendUserMessage(s.sessionId, 'ASK me something');
    await assistantSaid(s.sessionId, 'Echo: ASK me something');
    await waitState(s.sessionId, 'idle');

    expect(statesOf(s.sessionId)).not.toContain('waiting_input');
    expect(forwarded).toEqual([
      expect.objectContaining({
        sessionId: s.sessionId,
        toolName: 'AskUserQuestion',
        toolInput: {
          questions: [{ question: 'Which option?', options: [{ label: 'One' }, { label: 'Two' }] }],
        },
      }),
    ]);
    // The agent is told where its question went; the answer comes later as a team message.
    const refusal = chatOf(s.sessionId).find((i) => i.kind === 'tool_result' && !i.ok);
    expect(JSON.stringify(refusal)).toContain('team inbox');

    // Typing goes on at once: nothing holds the next message back.
    await runner.runner.sendUserMessage(s.sessionId, 'after the question');
    await assistantSaid(s.sessionId, 'Echo: after the question');
  });

  it("keeps the CLI's own prompt suggestion out of the inbox and still forwards a real question (PM-345)", async () => {
    forwardResult = true;
    process.env.FAKE_CLAUDE_SUGGESTION_MODE = '1';
    await setup();
    const s = spec();
    await runner.runner.start(s);
    await waitState(s.sessionId, 'idle');

    // The CLI is started with its prompt suggestions off: no suggestion question after a turn.
    await runner.runner.sendUserMessage(s.sessionId, 'plain turn');
    await assistantSaid(s.sessionId, 'Echo: plain turn');
    await waitState(s.sessionId, 'idle');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(forwarded).toEqual([]);
    expect(statesOf(s.sessionId)).not.toContain('waiting_input');

    // The member's own question still goes to the inbox (PM-199).
    await runner.runner.sendUserMessage(s.sessionId, 'ASK me something');
    await assistantSaid(s.sessionId, 'Echo: ASK me something');
    await waitState(s.sessionId, 'idle');
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.toolInput).toEqual({
      questions: [{ question: 'Which option?', options: [{ label: 'One' }, { label: 'Two' }] }],
    });
  });

  it('leaves the question to the terminal when the broker cannot take it', async () => {
    forwardResult = false;
    await setup();
    const s = spec();
    await runner.runner.start(s);
    await waitState(s.sessionId, 'idle');

    await runner.runner.sendUserMessage(s.sessionId, 'ASK me something');
    await waitState(s.sessionId, 'waiting_input');
    expect(forwarded).toHaveLength(1);
    runner.runner.writeTerminal(s.sessionId, '1');
    await assistantSaid(s.sessionId, 'Echo: ASK me something');
  });

  it('waits for input on a question and on Esc goes idle without a Stop hook', async () => {
    await setup();
    const s = spec();
    await runner.runner.start(s);
    await waitState(s.sessionId, 'idle');

    await runner.runner.sendUserMessage(s.sessionId, 'ASK me something');
    await waitState(s.sessionId, 'waiting_input');
    runner.runner.writeTerminal(s.sessionId, '2');
    await assistantSaid(s.sessionId, 'Echo: ASK me something');
    await waitState(s.sessionId, 'idle');

    await runner.runner.sendUserMessage(s.sessionId, 'SLOW long job');
    await waitState(s.sessionId, 'working');
    runner.runner.writeTerminal(s.sessionId, '\x1b');
    await waitChat(
      s.sessionId,
      (i) => i.kind === 'system_note' && i.text === 'Interrupted by user',
      'interrupt note',
    );
    await waitState(s.sessionId, 'idle');

    await runner.runner.sendUserMessage(s.sessionId, 'after the interrupt');
    await assistantSaid(s.sessionId, 'Echo: after the interrupt');
  });

  describe('pausing (PM-218)', () => {
    const pausedEvents = (id: string) =>
      events.filter(
        (e) => (e.type === 'session_pausing' || e.type === 'session_paused') && e.sessionId === id,
      );
    const toolCalls = (id: string) => chatOf(id).filter((i) => i.kind === 'tool_call');
    const toolResult = (id: string) => waitChat(id, (i) => i.kind === 'tool_result', 'the tool result');
    const holdFake = (phase: 'WORK' | 'TOOL') => {
      const file = path.join(cwd, `${phase.toLowerCase()}-release`);
      process.env[`FAKE_CLAUDE_${phase}_RELEASE_FILE`] = file;
      return () => writeFile(file, 'release');
    };
    const waitPausing = (id: string) =>
      waitFor(() => pausedEvents(id).some((e) => e.type === 'session_pausing'), { what: 'pause requested' });

    it('stops an idle session and a session waiting for permission at once', async () => {
      await setup();
      const s = spec();
      await runner.runner.start(s);
      await waitState(s.sessionId, 'idle');
      await expect(runner.runner.pause(s.sessionId)).resolves.toEqual({ point: 'idle', tool: null });
      expect(runner.runner.release(s.sessionId)).toBe(true);

      answers = ['wait'];
      await runner.runner.sendUserMessage(s.sessionId, 'PERMISSION please');
      await waitState(s.sessionId, 'waiting_permission');
      await expect(runner.runner.pause(s.sessionId)).resolves.toEqual({
        point: 'waiting_permission',
        tool: 'Bash',
      });
      expect(runner.runner.release(s.sessionId)).toBe(true);
    });

    it('lets a running tool finish and halts the turn after it (after_tool)', async () => {
      const finishTool = holdFake('TOOL');
      answers = [{ behavior: 'allow' }];
      await setup();
      const s = spec();
      await runner.runner.start(s);
      await waitState(s.sessionId, 'idle');

      await runner.runner.sendUserMessage(s.sessionId, 'LONGTOOL go');
      // This marker follows PreToolUse and permission approval, with the tool held at its gate.
      await waitSnapshot(s.sessionId, 'Long tool running: LONGTOOL go');
      const pause = runner.runner.pause(s.sessionId);
      await waitPausing(s.sessionId);
      await finishTool();
      const outcome = await pause;
      expect(outcome).toEqual({ point: 'after_tool', tool: 'Bash' });
      expect(pausedEvents(s.sessionId).map((e) => e.type)).toEqual(['session_pausing', 'session_paused']);
      // The tool ran to its end; the model did not answer afterwards.
      expect(await toolResult(s.sessionId)).toEqual(expect.objectContaining({ ok: true }));
      await waitState(s.sessionId, 'idle');
      expect(chatOf(s.sessionId).some((i) => i.kind === 'assistant_text')).toBe(false);
    });

    it('halts the next tool call while the model is still writing it (before_tool)', async () => {
      const finishWriting = holdFake('WORK');
      answers = [{ behavior: 'allow' }];
      await setup();
      const s = spec();
      await runner.runner.start(s);
      await waitState(s.sessionId, 'idle');

      await runner.runner.sendUserMessage(s.sessionId, 'LONGTOOL go');
      await waitState(s.sessionId, 'working');
      await waitSnapshot(s.sessionId, 'Waiting before tool: LONGTOOL go');
      const pause = runner.runner.pause(s.sessionId);
      await waitPausing(s.sessionId);
      expect(toolCalls(s.sessionId)).toHaveLength(0);
      await finishWriting();
      const outcome = await pause;
      expect(outcome).toEqual({ point: 'before_tool', tool: 'Bash' });
      expect(await toolResult(s.sessionId)).toEqual(expect.objectContaining({ ok: false }));
      await waitState(s.sessionId, 'idle');
    });

    it('interrupts with Esc when the deadline passes or forcePause is called', async () => {
      holdFake('TOOL');
      answers = [{ behavior: 'allow' }, { behavior: 'allow' }];
      await setup();
      const s = spec();
      await runner.runner.start(s);
      await waitState(s.sessionId, 'idle');

      await runner.runner.sendUserMessage(s.sessionId, 'LONGTOOL go');
      await waitSnapshot(s.sessionId, 'Long tool running: LONGTOOL go');
      await expect(runner.runner.pause(s.sessionId, { forceAfterMs: 500 })).resolves.toEqual({
        point: 'interrupted',
        tool: 'Bash',
      });
      await waitState(s.sessionId, 'idle');
      expect(runner.runner.release(s.sessionId)).toBe(true);

      await runner.runner.sendUserMessage(s.sessionId, 'LONGTOOL again');
      await waitSnapshot(s.sessionId, 'Long tool running: LONGTOOL again');
      const pause = runner.runner.pause(s.sessionId);
      await runner.runner.forcePause(s.sessionId);
      await expect(pause).resolves.toEqual({ point: 'interrupted', tool: 'Bash' });
      await waitState(s.sessionId, 'idle');
      await waitFor(
        () =>
          chatOf(s.sessionId).filter((i) => i.kind === 'system_note' && i.text === 'Interrupted by user')
            .length === 2,
        { what: 'both Esc interruption notes' },
      );
      expect(chatOf(s.sessionId).some((i) => i.kind === 'tool_result')).toBe(false);
    });

    it('types a message queued during the pause only after the release, the nudge first', async () => {
      await setup();
      const s = spec();
      await runner.runner.start(s);
      await waitState(s.sessionId, 'idle');
      await runner.runner.pause(s.sessionId);

      void runner.runner.sendUserMessage(s.sessionId, 'queued during the pause').catch(() => undefined);
      // Holding the input is synchronous; the delivery order below also checks that it stays held.
      expect(chatOf(s.sessionId).some((i) => i.kind === 'user_text')).toBe(false);

      runner.runner.release(s.sessionId, { nudge: 'Carry on.' });
      await assistantSaid(s.sessionId, 'Echo: Carry on.');
      await assistantSaid(s.sessionId, 'Echo: queued during the pause');
      const typed = chatOf(s.sessionId).filter((i) => i.kind === 'user_text');
      expect(typed.map((i) => (i.kind === 'user_text' ? i.text : ''))).toEqual([
        'Carry on.',
        'queued during the pause',
      ]);
    });

    it('delivers the halting PostToolUse answer through the sandbox forwarder', async () => {
      const finishTool = holdFake('TOOL');
      answers = [{ behavior: 'allow' }];
      await setup();
      // The sandboxed session sends every hook through the command forwarder (PM-153).
      const s = spec({ sandbox: { allowWrite: [], allowedDomains: [], allowLocalBinding: true } });
      await runner.runner.start(s);
      await waitState(s.sessionId, 'idle');

      await runner.runner.sendUserMessage(s.sessionId, 'LONGTOOL go');
      await waitSnapshot(s.sessionId, 'Long tool running: LONGTOOL go');
      const pause = runner.runner.pause(s.sessionId);
      await waitPausing(s.sessionId);
      await finishTool();
      await expect(pause).resolves.toEqual({ point: 'after_tool', tool: 'Bash' });
      expect(await toolResult(s.sessionId)).toEqual(expect.objectContaining({ ok: true }));
    });
  });

  it('stops a session and resumes the conversation later without replaying history', async () => {
    await setup();
    const s = spec({ initialMessage: 'first run' });
    await runner.runner.start(s);
    await assistantSaid(s.sessionId, 'Echo: first run');
    await waitState(s.sessionId, 'idle');

    await runner.runner.stop(s.sessionId);
    const exit = events.find((e) => e.type === 'exit' && e.sessionId === s.sessionId);
    expect(exit).toMatchObject({ type: 'exit', exitCode: 0 });
    expect(stateOf(s.sessionId)).toBe('exited');
    expect(runner.runner.isRunning(s.sessionId)).toBe(false);
    expect(runner.runner.list()).toEqual([]);
    expect((await waitSnapshot(s.sessionId, 'Echo: first run')).data).toContain('Echo: first run');
    await expect(runner.runner.sendUserMessage(s.sessionId, 'too late')).rejects.toThrow(/not running/);

    const before = chatOf(s.sessionId).length;
    await runner.runner.start({ ...s, resume: true, initialMessage: 'second run' });
    await assistantSaid(s.sessionId, 'Echo: second run');
    const after = chatOf(s.sessionId).slice(before);
    expect(
      after.map((i) => (i.kind === 'user_text' || i.kind === 'assistant_text' ? i.text : i.kind)),
    ).toEqual(['second run', 'Echo: second run']);
    const full = await runner.transcripts.read(path.join(transcriptDir, `${s.claudeSessionId}.jsonl`));
    expect(full.filter((i) => i.kind === 'user_text')).toHaveLength(2);
    expect(full.filter((i) => i.kind === 'user_text').map((i) => i.origin)).toEqual(['brief', 'human']);
  });

  it('types the first message of a resumed session once SessionStart says it runs, ahead of later ones', async () => {
    await setup();
    const s = spec({ initialMessage: 'first run' });
    await runner.runner.start(s);
    await assistantSaid(s.sessionId, 'Echo: first run');
    await waitState(s.sessionId, 'idle');
    await runner.runner.stop(s.sessionId);

    // Claude Code reports SessionStart at launch, for a resumed conversation too (source
    // "resume"): nothing depends on the screen, so the first message is typed, not passed as an
    // argument, and a message queued straight after follows it.
    const before = chatOf(s.sessionId).length;
    await runner.runner.start({ ...s, resume: true, initialMessage: 'Your session was restarted.' });
    const queued = runner.runner.sendUserMessage(s.sessionId, 'A message queued during the restart');
    await assistantSaid(s.sessionId, 'Echo: A message queued during the restart');
    await queued;
    const { argv } = JSON.parse(await readFile(argsFile, 'utf8'));
    expect(argv).toEqual(expect.arrayContaining(['--resume', s.claudeSessionId]));
    expect(argv).not.toContain('Your session was restarted.');
    expect(
      chatOf(s.sessionId)
        .slice(before)
        .flatMap((i) => (i.kind === 'user_text' ? [i.text] : [])),
    ).toEqual(['Your session was restarted.', 'A message queued during the restart']);
  });

  describe('a tool hook after the turn ended (PM-343)', () => {
    const noteCount = (id: string) =>
      chatOf(id).filter((i) => i.kind === 'system_note' && i.text === 'Interrupted by user').length;

    it('does not reopen a turn closed by its Stop hook', async () => {
      process.env.FAKE_CLAUDE_LATE_TOOL = 'after_stop';
      await setup();
      const s = spec();
      await runner.runner.start(s);
      await waitState(s.sessionId, 'idle');

      await runner.runner.sendUserMessage(s.sessionId, 'hello');
      await assistantSaid(s.sessionId, 'Echo: hello');
      await waitState(s.sessionId, 'idle');
      // The fake sends its late PreToolUse of ToolSearch 300 ms after the Stop hook.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(stateOf(s.sessionId)).toBe('idle');
      expect(statesOf(s.sessionId).slice(-3)).toEqual(['idle', 'working', 'idle']);
    });

    it('closes a turn whose Stop hook never came, and is not reopened by the late hook', async () => {
      process.env.FAKE_CLAUDE_LATE_TOOL = 'no_stop';
      await setup();
      const s = spec();
      await runner.runner.start(s);
      await waitState(s.sessionId, 'idle');

      await runner.runner.sendUserMessage(s.sessionId, 'hello');
      await assistantSaid(s.sessionId, 'Echo: hello');
      await waitState(s.sessionId, 'idle');
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(stateOf(s.sessionId)).toBe('idle');
      expect(statesOf(s.sessionId).slice(-3)).toEqual(['idle', 'working', 'idle']);
    });

    it('lets a forced pause take the session whose turn ended as stopped, without an Esc', async () => {
      process.env.FAKE_CLAUDE_LATE_TOOL = 'no_stop';
      await setup();
      const s = spec();
      await runner.runner.start(s);
      await waitState(s.sessionId, 'idle');

      await runner.runner.sendUserMessage(s.sessionId, 'hello');
      await assistantSaid(s.sessionId, 'Echo: hello');
      // The late hook came after the answer; the session still works, as the Stop hook never came.
      await waitSnapshot(s.sessionId, 'Echo: hello');
      await expect(runner.runner.pause(s.sessionId, { forceAfterMs: 0 })).resolves.toEqual(
        expect.objectContaining({ point: expect.stringMatching(/^(turn_end|idle|interrupted)$/) }),
      );
      expect(stateOf(s.sessionId)).toBe('idle');
      expect(noteCount(s.sessionId)).toBe(0);
      expect(runner.runner.release(s.sessionId)).toBe(true);
    });
  });

  describe('compaction (PM-213)', () => {
    const compactionEvents = (id: string) =>
      events.flatMap((e) =>
        e.type === 'compaction' && e.sessionId === id
          ? [`${e.phase}${e.requested ? ' (asked for)' : ''}`]
          : [],
      );

    it('compacts an idle session, holds a message back while it works, and goes on in the same conversation', async () => {
      await setup();
      process.env.FAKE_CLAUDE_COMPACT_DELAY_MS = '600';
      const s = spec({ initialMessage: 'first round' });
      await runner.runner.start(s);
      await assistantSaid(s.sessionId, 'Echo: first round');
      await waitState(s.sessionId, 'idle');

      await expect(runner.runner.compact?.(s.sessionId, 'Keep the card and the open bugs.')).resolves.toBe(
        true,
      );
      const queued = runner.runner.sendUserMessage(s.sessionId, 'second round');
      await waitState(s.sessionId, 'working');
      // The session works while the conversation is summarised: the message is not typed over it.
      expect(compactionEvents(s.sessionId)).toEqual(['started (asked for)']);
      expect(chatOf(s.sessionId).some((i) => i.kind === 'user_text' && i.text === 'second round')).toBe(
        false,
      );

      await assistantSaid(s.sessionId, 'Echo: second round');
      await queued;
      expect(compactionEvents(s.sessionId)).toEqual(['started (asked for)', 'finished (asked for)']);
      // The same transcript file: the next round continues the same conversation.
      const transcript = await readFile(path.join(transcriptDir, `${s.claudeSessionId}.jsonl`), 'utf8');
      expect(transcript).toContain('<command-args>Keep the card and the open bugs.</command-args>');
      expect(transcript).toContain('compact_boundary');
      expect(events.filter((e) => e.type === 'transcript_path' && e.sessionId === s.sessionId)).toHaveLength(
        1,
      );
    });

    it('compacts a resumed conversation before the message that woke it', async () => {
      await setup();
      const s = spec({ initialMessage: 'first round' });
      await runner.runner.start(s);
      await assistantSaid(s.sessionId, 'Echo: first round');
      await waitState(s.sessionId, 'idle');
      await runner.runner.stop(s.sessionId);

      await runner.runner.start({
        ...s,
        resume: true,
        compactFirst: 'Keep the card.',
        initialMessage: 'You have a new message',
      });
      await assistantSaid(s.sessionId, 'Echo: You have a new message');
      expect(compactionEvents(s.sessionId)).toEqual(['started (asked for)', 'finished (asked for)']);
      const full = await runner.transcripts.read(path.join(transcriptDir, `${s.claudeSessionId}.jsonl`));
      const said = full.flatMap((i) => (i.kind === 'user_text' ? [i.text] : []));
      expect(said.at(-1)).toBe('You have a new message');
    });

    it('gives a compaction up that never starts, and the session takes messages again', async () => {
      await setup();
      process.env.FAKE_CLAUDE_COMPACT_IGNORED = '1';
      const s = spec({ initialMessage: 'first round' });
      await runner.runner.start(s);
      await assistantSaid(s.sessionId, 'Echo: first round');
      await waitState(s.sessionId, 'idle');

      await runner.runner.compact?.(s.sessionId, 'Keep the card.');
      // No PreCompact comes: the runner gives up after its start timeout (10 s).
      await waitFor(() => compactionEvents(s.sessionId).includes('abandoned (asked for)'), {
        timeoutMs: 20_000,
        what: 'the compaction given up',
      });
      expect(stateOf(s.sessionId)).toBe('idle');
      await runner.runner.sendUserMessage(s.sessionId, 'after the swallowed command');
      await assistantSaid(s.sessionId, 'Echo: after the swallowed command');
    });
  });

  it('follows the new transcript after /clear', async () => {
    await setup();
    const s = spec({ initialMessage: 'before clear' });
    await runner.runner.start(s);
    await assistantSaid(s.sessionId, 'Echo: before clear');
    await waitState(s.sessionId, 'idle');

    await runner.runner.sendUserMessage(s.sessionId, '/clear');
    const paths = () =>
      events.flatMap((e) => (e.type === 'transcript_path' && e.sessionId === s.sessionId ? [e.path] : []));
    await waitFor(() => paths().length === 2, { what: 'second transcript path' });
    expect(paths()[1]).not.toBe(paths()[0]);

    await runner.runner.sendUserMessage(s.sessionId, 'after clear');
    await assistantSaid(s.sessionId, 'Echo: after clear');
    const fresh = await runner.transcripts.read(paths()[1]!, { self: 'fe-1' });
    expect(fresh.map((i) => (i.kind === 'user_text' ? i.text : i.kind))).toEqual([
      'after clear',
      'assistant_text',
    ]);
  });

  it('reports a session that cannot start as failed', async () => {
    await setup();
    const s = spec({ resume: true, initialMessage: 'never typed' });
    await runner.runner.start(s);
    await waitState(s.sessionId, 'failed');
    expect(events.find((e) => e.type === 'exit' && e.sessionId === s.sessionId)).toMatchObject({
      exitCode: 1,
    });
    const snapshot = await waitSnapshot(s.sessionId, '[session ended: exit code 1]');
    expect(snapshot.data).toContain('No conversation found');
    expect(snapshot.data).toContain('[session ended: exit code 1]');
    // Nothing follows the exit event.
    const exitIndex = events.findIndex((e) => e.type === 'exit' && e.sessionId === s.sessionId);
    expect(events.slice(exitIndex + 1).filter((e) => e.sessionId === s.sessionId)).toEqual([]);

    const missingCli = createRunnerModule({
      claudeBin: '/nonexistent/claude',
      publicBaseUrl: 'http://127.0.0.1:1',
      broker,
      permissionTimeoutMs: 1000,
      logger: silentLogger(),
      trustWorkspaces: false,
    });
    expect(await missingCli.runner.providerStatus!('claude')).toMatchObject({
      loggedIn: false,
      problem: 'cli_missing',
    });
    await expect(missingCli.runner.start(spec())).rejects.toThrow(/CLI not found/);
    await expect(runner.runner.start(spec({ cwd: path.join(cwd, 'missing') }))).rejects.toThrow(
      /does not exist/,
    );
    await expect(runner.runner.start(spec({ claudeSessionId: 'not-a-uuid' }))).rejects.toThrow(/invalid/);
    const running = spec();
    await runner.runner.start(running);
    await expect(runner.runner.start(running)).rejects.toThrow(/already running/);
  });

  it('flags the workspace trust dialog when trust is not pre-accepted, and continues once answered', async () => {
    await setup({ trustWorkspaces: false });
    const s = spec({ initialMessage: 'after trust' });
    await runner.runner.start(s);
    await waitState(s.sessionId, 'waiting_input', 5_000);
    const flagged = events.findLast((e) => e.type === 'state' && e.sessionId === s.sessionId);
    expect(flagged).toMatchObject({ activity: 'Workspace trust confirmation is waiting in the terminal' });
    expect(JSON.parse(await readFile(configFile, 'utf8')).projects).toEqual({});

    runner.runner.writeTerminal(s.sessionId, '\r');
    await assistantSaid(s.sessionId, 'Echo: after trust');
  });

  it('does not type into a start-up dialog, and continues once it is answered', async () => {
    process.env.FAKE_CLAUDE_MCP_DIALOG = '1';
    await setup();
    const s = spec({ initialMessage: 'brief after dialog' });
    await runner.runner.start(s);
    await waitState(s.sessionId, 'waiting_input', 5_000);
    const flagged = events.findLast((e) => e.type === 'state' && e.sessionId === s.sessionId);
    expect(flagged).toMatchObject({ activity: 'Approval of project MCP servers is waiting in the terminal' });
    expect(chatOf(s.sessionId)).toEqual([]);

    runner.runner.writeTerminal(s.sessionId, '\r');
    await assistantSaid(s.sessionId, 'Echo: brief after dialog');
    expect(statesOf(s.sessionId)).toEqual(['starting', 'idle', 'waiting_input', 'idle', 'working', 'idle']);
  });

  it('resizes the terminal and stops every session on shutdown', async () => {
    await setup();
    const a = spec();
    const b = spec();
    await Promise.all([runner.runner.start(a), runner.runner.start(b)]);
    await Promise.all([waitState(a.sessionId, 'idle'), waitState(b.sessionId, 'idle')]);
    runner.runner.resize(a.sessionId, 132, 43);
    expect(runner.runner.list().find((i) => i.sessionId === a.sessionId)).toMatchObject({
      cols: 132,
      rows: 43,
    });
    expect(runner.runner.snapshot(a.sessionId)).toMatchObject({ cols: 132, rows: 43 });

    await runner.runner.shutdown();
    expect(runner.runner.list()).toEqual([]);
    expect(stateOf(a.sessionId)).toBe('exited');
    expect(stateOf(b.sessionId)).toBe('exited');
  });
});
