import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { formatInjectedTeamMessage, type ChatItem, type SessionState } from '@projectman/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  PermissionBroker,
  PermissionDecision,
  PermissionRequestInfo,
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
  });
  runner.registerHookRoutes(app);
  await app.listen({ host: '127.0.0.1', port });
  runner.runner.onEvent((event) => events.push(event));
}

beforeEach(async () => {
  events = [];
  requests = [];
  answers = [];
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

describe('runner with the fake Claude Code CLI', () => {
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

    const snapshot = runner.runner.snapshot(s.sessionId);
    expect(snapshot).toMatchObject({ cols: 100, rows: 30 });
    expect(snapshot!.data).toContain('Echo: Hello from the brief');
    expect(events.some((e) => e.type === 'terminal_data' && e.sessionId === s.sessionId)).toBe(true);

    // The workspace was trusted up front, so the fake showed no trust dialog.
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    expect(config.projects[cwd].hasTrustDialogAccepted).toBe(true);
    expect(config.numStartups).toBe(1);
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
    expect(env).toMatchObject({
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      PROJECTMAN_SESSION_ID: s.sessionId,
    });
    expect(env.NO_PROXY.split(',')).toEqual(expect.arrayContaining(['127.0.0.1', 'localhost', '::1']));
    expect(env.no_proxy.split(',')).toEqual(expect.arrayContaining(['127.0.0.1', 'localhost', '::1']));
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
      formatInjectedTeamMessage('qa', 'Please TEAM check', 'AR-21'),
    );
    await assistantSaid(s.sessionId, 'Echo: [team message from qa about AR-21]');
    expect(requests).toHaveLength(0); // mcp__team is pre-allowed
    const team = chatOf(s.sessionId).filter((i) => i.kind === 'team_message');
    expect(team).toEqual([
      expect.objectContaining({ direction: 'in', from: 'qa', to: ['fe-1'], text: 'Please TEAM check' }),
      expect.objectContaining({ direction: 'out', from: 'fe-1', to: ['qa'], text: 'Ready for review' }),
    ]);
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
    expect(runner.runner.snapshot(s.sessionId)?.data).toContain('Echo: first run');
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
  });

  it('reports a session that cannot start as failed', async () => {
    await setup();
    const s = spec({ resume: true, initialMessage: 'never typed' });
    await runner.runner.start(s);
    await waitState(s.sessionId, 'failed');
    expect(events.find((e) => e.type === 'exit' && e.sessionId === s.sessionId)).toMatchObject({
      exitCode: 1,
    });
    expect(runner.runner.snapshot(s.sessionId)?.data).toContain('No conversation found');

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
