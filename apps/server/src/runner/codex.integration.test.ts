import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
  RunnerEvent,
  RunnerModule,
  StartSessionSpec,
} from '../contracts';
import { createRunnerModule } from './index';
import { buildSessionPolicy } from '../domain';
import { testConfig } from '../../test/helpers/test-template';
import { FAKE_CLAUDE, FAKE_CODEX, freePort, silentLogger, tempDirs, waitFor } from './test-helpers';

/**
 * End to end with the fake Codex CLI (test/fixtures/fake-codex.mjs) in a real
 * pseudo-terminal: hooks through the command forwarder, approvals, the learned session id,
 * resume, transcripts and plan usage from a temporary CODEX_HOME.
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
let codexHome: string;
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
  options: {
    permissionTimeoutMs?: number;
    nanogptKey?: () => Promise<string | null>;
    nanogptCodexHome?: string;
  } = {},
): Promise<void> {
  const port = await freePort();
  app = Fastify({ logger: false });
  runner = createRunnerModule({
    claudeBin: FAKE_CLAUDE,
    codexBin: FAKE_CODEX,
    codexHome,
    nanogptKey: options.nanogptKey,
    nanogptCodexHome: options.nanogptCodexHome,
    publicBaseUrl: `http://127.0.0.1:${port}`,
    broker,
    permissionTimeoutMs: options.permissionTimeoutMs ?? 10_000,
    logger: silentLogger(),
    trustWorkspaces: false,
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
  codexHome = await dirs.make('codex-home-');
  argsFile = path.join(codexHome, 'args.json');
  process.env.CODEX_HOME = codexHome;
  process.env.FAKE_CODEX_ARGS_FILE = argsFile;
  // Billing and parent-session variables that must never reach the child.
  process.env.OPENAI_API_KEY = 'sk-openai-must-not-leak';
  process.env.CODEX_API_KEY = 'sk-codex-must-not-leak';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-must-not-leak';
  process.env.NANOGPT_API_KEY = 'inherited-nanogpt-must-not-leak';
  process.env.CODEX_THREAD_ID = 'parent-thread';
  process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = 'parent';
  // A dead proxy: the forwarder (curl honours http_proxy) only reaches the server because the
  // runner puts the loopback hosts into no_proxy.
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
    // A placeholder for new Codex sessions: Codex picks its own id.
    claudeSessionId: randomUUID(),
    resume: false,
    cwd,
    displayName: 'Anna · fe-1',
    appendSystemPrompt: 'You are fe-1, a developer.\nSpeak "Hungarian".',
    initialMessage: null,
    mcpUrl: 'http://127.0.0.1:1/mcp/token',
    allowedTools: ['mcp__team__*'],
    policy: buildSessionPolicy({
      config: testConfig(),
      role: 'developer',
      task: { repo: 'web' },
      permissionMode: extra.permissionMode ?? 'acceptEdits',
      placement: { kind: 'task_worktree', path: cwd },
    }),
    member: 'fe-1',
    model: 'opus',
    permissionMode: 'acceptEdits',
    provider: 'codex',
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
const waitSnapshot = (id: string, text: string) =>
  waitFor(
    () => {
      const snapshot = runner.runner.snapshot(id);
      return snapshot?.data.includes(text) ? snapshot : null;
    },
    { what: `terminal snapshot: ${text}` },
  );
const providerIdOf = (id: string) =>
  events.findLast(
    (e): e is Extract<RunnerEvent, { type: 'provider_session_id' }> =>
      e.type === 'provider_session_id' && e.sessionId === id,
  )?.providerSessionId;

describe('runner with the fake Codex CLI', { timeout: 30_000 }, () => {
  it('runs NanoGPT hooks, team tools, permissions and resume in its own home without exposing the key', async () => {
    const nanoHome = await dirs.make('nano-home-');
    process.env.FAKE_CODEX_VERSION = '0.159.1';
    process.env.NANOGPT_API_KEY = 'inherited-must-not-leak';
    let key: string | null = 'nanogpt-private-sentinel';
    await setup({ nanogptKey: async () => key, nanogptCodexHome: nanoHome });
    const s = spec({ provider: 'nanogpt', initialMessage: 'TEAM' });
    await runner.runner.start(s);
    await assistantSaid(s.sessionId, 'Echo: TEAM');
    await waitState(s.sessionId, 'idle');
    answers.push({ behavior: 'allow' });
    await runner.runner.sendUserMessage(s.sessionId, 'PERMISSION');
    await assistantSaid(s.sessionId, 'Echo: PERMISSION');
    await waitState(s.sessionId, 'idle');
    expect(requests).toHaveLength(1);
    expect(chatOf(s.sessionId)).toContainEqual(
      expect.objectContaining({ kind: 'team_message', direction: 'out', text: 'Ready for review' }),
    );
    const diagnostics = JSON.parse(await readFile(argsFile, 'utf8'));
    expect(diagnostics.config.model_provider).toBe('nanogpt');
    expect(diagnostics.env.NANOGPT_API_KEY).toBe('<set>');
    expect(diagnostics.env.CODEX_HOME).toBe(nanoHome);
    expect(diagnostics.env.OPENAI_API_KEY).toBeUndefined();
    const transcript = events.find((e) => e.type === 'transcript_path') as Extract<
      RunnerEvent,
      { type: 'transcript_path' }
    >;
    expect(transcript.path.startsWith(nanoHome)).toBe(true);
    expect(await runner.transcripts.read(transcript.path, { provider: 'nanogpt', self: 'fe-1' })).toEqual(
      chatOf(s.sessionId),
    );
    expect(await readFile(transcript.path, 'utf8')).not.toContain(key!);
    expect(JSON.stringify(events)).not.toContain(key!);
    expect(await runner.planUsageFor!('nanogpt').get()).toBeNull();
    expect(await runner.planUsageFor!('codex').get()).toBeNull();
    const learned = providerIdOf(s.sessionId)!;
    key = null;
    await runner.runner.sendUserMessage(s.sessionId, 'still running');
    await assistantSaid(s.sessionId, 'Echo: still running');
    await runner.runner.stop(s.sessionId);
    await expect(runner.runner.start(spec({ provider: 'nanogpt' }))).rejects.toMatchObject({
      code: 'nanogpt_key_missing',
    });
    key = 'replacement-test-key';
    const resumed = spec({
      provider: 'nanogpt',
      resume: true,
      claudeSessionId: learned,
      initialMessage: 'resume test',
    });
    await runner.runner.start(resumed);
    await assistantSaid(resumed.sessionId, 'Echo: resume test');
    expect(JSON.parse(await readFile(argsFile, 'utf8')).argv).toContain(learned);
    expect(await readFile(transcript.path, 'utf8')).toContain('resume test');
  });
  it('starts a NanoGPT conversation from its model footer and sends the first queued message', async () => {
    process.env.FAKE_CODEX_VERSION = '0.159.1';
    process.env.FAKE_CODEX_MODEL_FOOTER = '1';
    const nanoHome = await dirs.make('nano-footer-home-');
    await setup({ nanogptKey: async () => 'fictional-footer-key', nanogptCodexHome: nanoHome });
    const s = spec({ provider: 'nanogpt', model: 'z-ai/glm-5.3-flash-uncensored' });
    await runner.runner.start(s);
    // No prompt argument or initial SessionStart hook: only the screen can release this message.
    await runner.runner.sendUserMessage(s.sessionId, 'First NanoGPT message');
    await assistantSaid(s.sessionId, 'Echo: First NanoGPT message');
    await waitState(s.sessionId, 'idle');
    expect(statesOf(s.sessionId)).toEqual(['starting', 'idle', 'working', 'idle']);
    expect(chatOf(s.sessionId).filter((item) => item.kind === 'user_text')).toHaveLength(1);
  });

  it('passes the brief on the command line, learns the session id and follows the turn', async () => {
    await setup();
    const s = spec({ initialMessage: 'Hello from the brief' });
    const info = await runner.runner.start(s);
    expect(info).toMatchObject({ sessionId: s.sessionId, state: 'starting', cols: 100, rows: 30 });

    await assistantSaid(s.sessionId, 'Echo: Hello from the brief');
    await waitState(s.sessionId, 'idle');
    expect(statesOf(s.sessionId)).toEqual(['starting', 'idle', 'working', 'idle']);
    // The developer instructions and Codex's own context are not chat.
    expect(chatOf(s.sessionId).map((i) => i.kind)).toEqual(['user_text', 'assistant_text']);
    expect(chatOf(s.sessionId)[0]).toMatchObject({ origin: 'brief' });

    const learned = providerIdOf(s.sessionId);
    expect(learned).toMatch(/^[0-9a-f-]{36}$/);
    expect(learned).not.toBe(s.claudeSessionId);
    const pathEvent = events.find((e) => e.type === 'transcript_path');
    expect(pathEvent).toMatchObject({ type: 'transcript_path', sessionId: s.sessionId });
    const transcript = (pathEvent as Extract<RunnerEvent, { type: 'transcript_path' }>).path;
    expect(transcript.startsWith(path.join(codexHome, 'sessions'))).toBe(true);
    expect(path.basename(transcript)).toMatch(new RegExp(`^rollout-.*-${learned}\\.jsonl$`));
    expect(await runner.transcripts.read(transcript, { self: 'fe-1' })).toEqual(chatOf(s.sessionId));

    // The plan's rate limits come from the transcript, without any request.
    expect(await runner.planUsageFor!('codex').get()).toMatchObject({
      fiveHourPercent: 12.5,
      weeklyPercent: 41,
    });
  });

  it('launches codex with per-process config and a subscription-only environment', async () => {
    await setup({ permissionTimeoutMs: 20_000 });
    const s = spec({ initialMessage: 'hi' });
    await runner.runner.start(s);
    await assistantSaid(s.sessionId, 'Echo: hi');
    const { argv, env, config, cwd: childCwd } = JSON.parse(await readFile(argsFile, 'utf8'));
    expect(childCwd).toBe(cwd);
    expect(argv).toEqual(
      expect.arrayContaining(['--no-alt-screen', '--no-daemon', '--dangerously-bypass-hook-trust']),
    );
    expect(argv).not.toContain('--sandbox');
    expect(argv).toContain('default_permissions="projectman"');
    expect(
      argv.some(
        (arg: string) =>
          arg.startsWith('permissions.projectman=') && arg.includes('":workspace_roots"={"."="write"'),
      ),
    ).toBe(true);
    expect(argv[argv.indexOf('--ask-for-approval') + 1]).toBe('on-request');
    // "opus" is a Claude alias: Codex members get projectman's default model and effort.
    expect(argv[argv.indexOf('--model') + 1]).toBe('gpt-6.1-sol');
    expect(argv).toContain('model_reasoning_effort="medium"');
    expect(argv.slice(-2)).toEqual(['--', 'hi']);
    expect(config).toMatchObject({
      check_for_update_on_startup: false,
      projects: { [cwd]: { trust_level: 'trusted' } },
      project_doc_fallback_filenames: ['CLAUDE.md'],
      developer_instructions: 'You are fe-1, a developer.\nSpeak "Hungarian".',
      mcp_servers: { team: { url: s.mcpUrl, default_tools_approval_mode: 'approve' } },
      features: { hooks: true },
    });
    expect(Object.keys(config.hooks).sort()).toEqual(
      [
        'Interrupt',
        'PermissionRequest',
        'PostToolUse',
        'PreToolUse',
        'SessionEnd',
        'SessionStart',
        'Stop',
        'UserPromptSubmit',
      ].sort(),
    );
    expect(config.hooks.PermissionRequest[0].hooks[0]).toMatchObject({ type: 'command', timeout: 50 });
    expect(config.hooks.Stop[0].hooks[0]).toMatchObject({ type: 'command', timeout: 10 });
    for (const name of [
      'OPENAI_API_KEY',
      'CODEX_API_KEY',
      'ANTHROPIC_API_KEY',
      'NANOGPT_API_KEY',
      'CODEX_THREAD_ID',
      'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
    ]) {
      expect(env).not.toHaveProperty(name);
    }
    expect(env).toMatchObject({ CODEX_HOME: codexHome, PROJECTMAN_SESSION_ID: s.sessionId });
    expect(env.NO_PROXY.split(',')).toEqual(expect.arrayContaining(['127.0.0.1', 'localhost', '::1']));

    await runner.runner.stop(s.sessionId);
    const other = spec({ model: 'gpt-fake-codex', permissionMode: 'default' });
    await runner.runner.start(other);
    await waitState(other.sessionId, 'idle');
    const second = JSON.parse(await readFile(argsFile, 'utf8'));
    expect(second.argv[second.argv.indexOf('--model') + 1]).toBe('gpt-fake-codex');
    expect(second.argv).not.toContain('--sandbox');
    expect(
      second.argv.some(
        (arg: string) => arg.startsWith('permissions.projectman=') && !arg.includes('"write"'),
      ),
    ).toBe(true);
    expect(second.argv).not.toContain('--');
  });

  it('becomes ready from the screen and types later messages as pastes, Enter after the paste guard', async () => {
    await setup();
    const s = spec();
    await runner.runner.start(s);
    await waitState(s.sessionId, 'idle');

    const long = Array.from({ length: 30 }, (_, i) => `Line ${i + 1}: ${'detail '.repeat(12)}`.trim()).join(
      '\n',
    );
    await Promise.all([
      runner.runner.sendUserMessage(s.sessionId, 'SLOW first task'),
      runner.runner.sendUserMessage(s.sessionId, `Second task\n\n${long}`),
      runner.runner.sendUserMessage(s.sessionId, '!not a shell command'),
    ]);
    await assistantSaid(s.sessionId, 'Echo: !not a shell command');
    const prompts = chatOf(s.sessionId).filter((i) => i.kind === 'user_text');
    expect(prompts.map((i) => (i.kind === 'user_text' ? i.text : ''))).toEqual([
      'SLOW first task',
      `Second task\n\n${long}`,
      '!not a shell command',
    ]);
    await waitState(s.sessionId, 'idle');
  });

  it('answers Codex approvals from the broker and remembers "allow for this session" itself', async () => {
    await setup();
    const s = spec({ initialMessage: 'warm up' });
    await runner.runner.start(s);
    await assistantSaid(s.sessionId, 'Echo: warm up');
    await waitState(s.sessionId, 'idle');

    answers.push({ behavior: 'allow', rememberForSession: true });
    await runner.runner.sendUserMessage(s.sessionId, 'Please PERMISSION push');
    await assistantSaid(s.sessionId, 'Echo: Please PERMISSION push');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.info).toMatchObject({
      sessionId: s.sessionId,
      toolName: 'Bash',
      toolInput: { command: 'git push', description: 'Push the branch' },
    });
    expect(statesOf(s.sessionId)).toContain('waiting_permission');
    const waiting = events.find(
      (e) => e.type === 'state' && e.sessionId === s.sessionId && e.state === 'waiting_permission',
    );
    expect(waiting).toMatchObject({ activity: 'Bash: git push' });
    expect(chatOf(s.sessionId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'tool_call', name: 'Bash', summary: 'git push' }),
        expect.objectContaining({ kind: 'tool_result', ok: true, summary: 'Everything up-to-date' }),
      ]),
    );

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
      expect.objectContaining({
        kind: 'tool_result',
        ok: false,
        summary: expect.stringContaining('Not on Fridays'),
      }),
    );

    await waitState(s.sessionId, 'idle');
    answers.push('wait');
    await runner.runner.sendUserMessage(s.sessionId, 'Try PERMISSION two');
    await assistantSaid(s.sessionId, 'Echo: Try PERMISSION two');
    expect(requests[1]!.signal.aborted).toBe(true);
    const denied = chatOf(s.sessionId).filter((i) => i.kind === 'tool_result' && !i.ok);
    expect(denied.at(-1)).toMatchObject({ summary: expect.stringContaining('No human answered') });
  });

  it('pre-approves the team tools and shows team messages in both directions', async () => {
    await setup();
    const s = spec();
    await runner.runner.start(s);
    await waitState(s.sessionId, 'idle');
    await runner.runner.sendUserMessage(
      s.sessionId,
      formatInjectedTeamMessage('qa', 'Please TEAM check', 'ACME-21'),
    );
    await assistantSaid(s.sessionId, 'Echo: [team message from qa about ACME-21]');
    expect(requests).toHaveLength(0);
    const team = chatOf(s.sessionId).filter((i) => i.kind === 'team_message');
    expect(team).toEqual([
      expect.objectContaining({ direction: 'in', from: 'qa', to: ['fe-1'], text: 'Please TEAM check' }),
      expect.objectContaining({ direction: 'out', from: 'fe-1', to: ['qa'], text: 'Ready for review' }),
    ]);
  });

  it('closes an empty failed turn without a Stop hook and accepts the next message', async () => {
    await setup();
    const s = spec();
    await runner.runner.start(s);
    await waitState(s.sessionId, 'idle');
    await runner.runner.sendUserMessage(s.sessionId, 'EMPTY_FAILURE');
    await waitState(s.sessionId, 'working');
    await waitChat(
      s.sessionId,
      (i) => i.kind === 'system_note' && i.text === 'stream disconnected before completion',
      'failed turn',
    );
    await waitState(s.sessionId, 'idle');
    await runner.runner.sendUserMessage(s.sessionId, 'after the failure');
    await assistantSaid(s.sessionId, 'Echo: after the failure');
  });

  it('maps the permission mode to the sandbox: edits are asked in default mode only', async () => {
    await setup();
    const reviewer = spec({ permissionMode: 'default' });
    await runner.runner.start(reviewer);
    await waitState(reviewer.sessionId, 'idle');
    answers.push({ behavior: 'allow' });
    await runner.runner.sendUserMessage(reviewer.sessionId, 'EDIT the notes');
    await assistantSaid(reviewer.sessionId, 'Echo: EDIT the notes');
    expect(requests.map((r) => r.info.toolName)).toEqual(['apply_patch']);
    expect(chatOf(reviewer.sessionId)).toContainEqual(
      expect.objectContaining({ kind: 'tool_call', name: 'apply_patch', summary: 'notes.txt' }),
    );

    const developer = spec({ permissionMode: 'acceptEdits' });
    await runner.runner.start(developer);
    await waitState(developer.sessionId, 'idle');
    await runner.runner.sendUserMessage(developer.sessionId, 'EDIT the notes');
    await assistantSaid(developer.sessionId, 'Echo: EDIT the notes');
    expect(requests).toHaveLength(1);
  });

  it('waits for input on a question, ignores subagent hooks, and goes idle on Esc', async () => {
    await setup();
    const s = spec();
    await runner.runner.start(s);
    await waitState(s.sessionId, 'idle');

    await runner.runner.sendUserMessage(s.sessionId, 'ASK me something');
    await waitState(s.sessionId, 'waiting_input');
    // The hook reaches the server before the fake CLI shows its question and takes keys as the
    // answer: a key typed in between would go into the composer, and the question never ends.
    await waitSnapshot(s.sessionId, 'Which option?');
    runner.runner.writeTerminal(s.sessionId, '2');
    await assistantSaid(s.sessionId, 'Echo: ASK me something');
    await waitState(s.sessionId, 'idle');

    const before = statesOf(s.sessionId).length;
    await runner.runner.sendUserMessage(s.sessionId, 'SUBAGENT work');
    await assistantSaid(s.sessionId, 'Echo: SUBAGENT work');
    await waitState(s.sessionId, 'idle');
    // A subagent's Stop must not end the turn early.
    expect(statesOf(s.sessionId).slice(before)).toEqual(['working', 'idle']);

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
    // The tool the runner knows is running: its PreToolUse hook came. The transcript's tool_call item is
    // written before that hook, so a pause that waits for the item alone may beat the hook.
    const toolCalls = (id: string) =>
      events.filter(
        (e) =>
          e.type === 'state' && e.sessionId === id && e.state === 'working' && e.activity?.startsWith('Bash'),
      );

    it('stops an idle session at once, and holds the input until the release, the nudge first', async () => {
      await setup();
      const s = spec();
      await runner.runner.start(s);
      await waitState(s.sessionId, 'idle');
      await expect(runner.runner.pause(s.sessionId)).resolves.toEqual({ point: 'idle', tool: null });

      void runner.runner.sendUserMessage(s.sessionId, 'queued during the pause').catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(chatOf(s.sessionId).some((i) => i.kind === 'user_text')).toBe(false);

      expect(runner.runner.release(s.sessionId, { nudge: 'Carry on.' })).toBe(true);
      await assistantSaid(s.sessionId, 'Echo: Carry on.');
      await assistantSaid(s.sessionId, 'Echo: queued during the pause');
    });

    it('lets a running tool finish, then ends the turn with one Esc, confirmed by the Interrupt hook', async () => {
      process.env.FAKE_CODEX_TOOL_MS = '1500';
      await setup();
      const s = spec();
      await runner.runner.start(s);
      await waitState(s.sessionId, 'idle');

      await runner.runner.sendUserMessage(s.sessionId, 'LONGTOOL go');
      await waitFor(() => toolCalls(s.sessionId).length > 0, { what: 'the tool call' });
      await expect(runner.runner.pause(s.sessionId)).resolves.toEqual({ point: 'after_tool', tool: 'Bash' });
      expect(chatOf(s.sessionId).some((i) => i.kind === 'tool_result')).toBe(true);
      expect(chatOf(s.sessionId).some((i) => i.kind === 'assistant_text')).toBe(false);

      expect(runner.runner.release(s.sessionId, { nudge: 'Carry on.' })).toBe(true);
      await assistantSaid(s.sessionId, 'Echo: Carry on.');
    });

    it('interrupts a long tool when the deadline passes or forcePause is called', async () => {
      process.env.FAKE_CODEX_TOOL_MS = '20000';
      await setup();
      const s = spec();
      await runner.runner.start(s);
      await waitState(s.sessionId, 'idle');

      await runner.runner.sendUserMessage(s.sessionId, 'LONGTOOL go');
      await waitFor(() => toolCalls(s.sessionId).length > 0, { what: 'the tool call' });
      await expect(runner.runner.pause(s.sessionId, { forceAfterMs: 500 })).resolves.toEqual({
        point: 'interrupted',
        tool: 'Bash',
      });
      await waitState(s.sessionId, 'idle');
      expect(runner.runner.release(s.sessionId)).toBe(true);

      await runner.runner.sendUserMessage(s.sessionId, 'LONGTOOL again');
      await waitFor(() => toolCalls(s.sessionId).length > 1, { what: 'the second tool call' });
      const pause = runner.runner.pause(s.sessionId);
      await runner.runner.forcePause(s.sessionId);
      await expect(pause).resolves.toEqual({ point: 'interrupted', tool: 'Bash' });
    });
  });

  it('reports the token usage of each turn from token_count, also after a resume (PM-178)', async () => {
    await setup();
    const s = spec({ initialMessage: 'first run' });
    await runner.runner.start(s);
    await assistantSaid(s.sessionId, 'Echo: first run');
    await waitState(s.sessionId, 'idle');
    const usage = () =>
      mergeTokenUsage(
        events.flatMap((e) => (e.type === 'usage' && e.sessionId === s.sessionId ? e.entries : [])),
      );
    // Input 10 of which 4 cached, output 5; the repeated event is not counted again.
    await waitFor(() => usage().length === 1, { what: 'the first turn usage' });
    const [first] = usage();
    expect(first).toEqual({
      model: first!.model,
      scope: 'main',
      input: 6,
      output: 5,
      cacheRead: 4,
      cacheWrite: 0,
    });
    expect(first!.model).not.toBe('unknown');

    await runner.runner.stop(s.sessionId);
    await runner.runner.start({
      ...s,
      claudeSessionId: providerIdOf(s.sessionId)!,
      resume: true,
      initialMessage: 'second run',
    });
    await assistantSaid(s.sessionId, 'Echo: second run');
    await waitFor(() => usage()[0]?.output === 10, { what: 'the second turn usage' });
    expect(usage()).toEqual([{ ...first, input: 12, output: 10, cacheRead: 8 }]);
  });

  it('resumes with codex resume <learned id> without replaying history', async () => {
    await setup();
    const s = spec({ initialMessage: 'first run' });
    await runner.runner.start(s);
    await assistantSaid(s.sessionId, 'Echo: first run');
    await waitState(s.sessionId, 'idle');
    const learned = providerIdOf(s.sessionId)!;
    const transcript = events.find((e) => e.type === 'transcript_path') as Extract<
      RunnerEvent,
      { type: 'transcript_path' }
    >;
    await runner.runner.stop(s.sessionId);
    expect(stateOf(s.sessionId)).toBe('exited');

    const before = chatOf(s.sessionId).length;
    const idEvents = events.filter((e) => e.type === 'provider_session_id').length;
    await runner.runner.start({ ...s, claudeSessionId: learned, resume: true, initialMessage: 'second run' });
    await assistantSaid(s.sessionId, 'Echo: second run');
    const { argv } = JSON.parse(await readFile(argsFile, 'utf8'));
    expect(argv[0]).toBe('resume');
    expect(argv.slice(-3)).toEqual(['--', learned, 'second run']);
    const after = chatOf(s.sessionId).slice(before);
    expect(
      after.map((i) => (i.kind === 'user_text' || i.kind === 'assistant_text' ? i.text : i.kind)),
    ).toEqual(['second run', 'Echo: second run']);
    // Same conversation: no new id, same transcript.
    expect(events.filter((e) => e.type === 'provider_session_id')).toHaveLength(idEvents);
    const full = await runner.transcripts.read(transcript.path);
    expect(full.filter((i) => i.kind === 'user_text')).toHaveLength(2);
    expect(full.filter((i) => i.kind === 'user_text').map((i) => i.origin)).toEqual(['brief', 'human']);

    await runner.runner.stop(s.sessionId);
    const unknown = spec({ claudeSessionId: randomUUID(), resume: true });
    await runner.runner.start(unknown);
    await waitState(unknown.sessionId, 'failed');
    await waitFor(() => runner.runner.snapshot(unknown.sessionId)?.data.includes('No saved session found'), {
      what: 'failed session terminal output parsed',
    });
  });

  it('becomes ready from the composer of a resumed screen, below a long history that quotes dialogs', async () => {
    await setup();
    // A conversation taller than the terminal, whose text quotes what start-up dialogs say.
    const notes = Array.from(
      { length: 45 },
      (_, i) => `Note ${i + 1}: Press enter to continue. Update available. Sign in with ChatGPT.`,
    ).join('\n');
    const s = spec({ initialMessage: `Read these notes\n${notes}` });
    await runner.runner.start(s);
    await assistantSaid(s.sessionId, 'Echo: Read these notes');
    await waitState(s.sessionId, 'idle');
    const learned = providerIdOf(s.sessionId)!;
    await runner.runner.stop(s.sessionId);

    // Resumed with nothing on the command line, Codex reports nothing until a turn starts: the
    // session can only become ready by recognising the composer under the history.
    await runner.runner.start({ ...s, claudeSessionId: learned, resume: true, initialMessage: null });
    await waitState(s.sessionId, 'idle');
    const { argv } = JSON.parse(await readFile(argsFile, 'utf8'));
    expect(argv.slice(-2)).toEqual(['--', learned]);
    const screen = (await waitSnapshot(s.sessionId, 'Ask Codex to do anything')).data;
    expect(screen.indexOf('Note 45')).toBeGreaterThan(-1);
    expect(screen.indexOf('Note 45')).toBeLessThan(screen.indexOf('Ask Codex to do anything'));

    await runner.runner.sendUserMessage(s.sessionId, 'Carry on after the restart');
    await assistantSaid(s.sessionId, 'Echo: Carry on after the restart');
    await waitState(s.sessionId, 'idle');
  });

  it('types a message queued for a resumed session that got its first message on the command line', async () => {
    await setup();
    const s = spec({ initialMessage: 'first run' });
    await runner.runner.start(s);
    await assistantSaid(s.sessionId, 'Echo: first run');
    await waitState(s.sessionId, 'idle');
    const learned = providerIdOf(s.sessionId)!;
    await runner.runner.stop(s.sessionId);

    const before = chatOf(s.sessionId).length;
    await runner.runner.start({
      ...s,
      claudeSessionId: learned,
      resume: true,
      initialMessage: 'Your session was restarted. Carry on.',
    });
    // Queued at once, before the first turn has even started: typed after it, on SessionStart's
    // word that the session runs.
    const queued = runner.runner.sendUserMessage(s.sessionId, 'A message queued during the restart');
    await assistantSaid(s.sessionId, 'Echo: A message queued during the restart');
    await queued;
    const { argv } = JSON.parse(await readFile(argsFile, 'utf8'));
    expect(argv.slice(-3)).toEqual(['--', learned, 'Your session was restarted. Carry on.']);
    expect(
      chatOf(s.sessionId)
        .slice(before)
        .flatMap((i) => (i.kind === 'user_text' ? [i.text] : [])),
    ).toEqual(['Your session was restarted. Carry on.', 'A message queued during the restart']);
    await waitState(s.sessionId, 'idle');
  });

  it('refuses to start when Codex is not logged in with ChatGPT', async () => {
    await setup();
    process.env.FAKE_CODEX_LOGGED_OUT = '1';
    await expect(runner.runner.start(spec())).rejects.toMatchObject({
      code: 'provider_not_logged_in',
      provider: 'codex',
    });
    expect(await runner.runner.providerStatus!('codex')).toMatchObject({
      provider: 'codex',
      loggedIn: false,
      method: 'none',
    });
    expect(runner.runner.list()).toEqual([]);

    delete process.env.FAKE_CODEX_LOGGED_OUT;
    process.env.FAKE_CODEX_AUTH = 'api_key';
    expect(await runner.runner.providerStatus!('codex', { refresh: true })).toMatchObject({
      loggedIn: false,
      method: 'api_key',
    });
    delete process.env.FAKE_CODEX_AUTH;
    expect(await runner.runner.providerStatus!('codex', { refresh: true })).toMatchObject({
      loggedIn: true,
      method: 'chatgpt',
    });
  });

  it('fails a session whose ChatGPT login is lost mid-session', async () => {
    await setup();
    const s = spec();
    await runner.runner.start(s);
    await waitState(s.sessionId, 'idle');
    await runner.runner.sendUserMessage(s.sessionId, 'EXPIRE now');
    const authError = await waitFor(
      () => events.find((e) => e.type === 'auth_error' && e.sessionId === s.sessionId),
      { what: 'auth_error event' },
    );
    expect(authError).toMatchObject({ provider: 'codex', message: expect.stringContaining('sign in again') });
    await waitFor(() => events.some((e) => e.type === 'exit' && e.sessionId === s.sessionId), {
      what: 'exit',
    });
    expect(stateOf(s.sessionId)).toBe('failed');
    const failed = events.findLast((e) => e.type === 'state' && e.sessionId === s.sessionId);
    expect(failed).toMatchObject({ state: 'failed', activity: expect.stringContaining('refresh token') });
  });
});
