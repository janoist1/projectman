import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AgentProvider, ChatItem, SessionState } from '@projectman/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ManagedVmAttestation,
  ManagedVmBoundary,
  PermissionBroker,
  PermissionRequestInfo,
  RunnerEvent,
  RunnerModule,
  StartSessionSpec,
} from '../contracts';
import { testConfig } from '../../test/helpers/test-template';
import { buildSessionPolicy } from '../domain';
import { createRunnerModule } from './index';
import { FAKE_CLAUDE, FAKE_CODEX, freePort, silentLogger, tempDirs, waitFor } from './test-helpers';

/**
 * The managed VM profile (PM-141) end to end with the fake CLIs in real pseudo-terminals, for both
 * providers: what the CLI is started with, and that a routine turn creates no local approval
 * request. What is refused before anything is spawned is in managed-vm.test.ts (no pseudo-terminal).
 */

const dirs = tempDirs();
const savedEnv = { ...process.env };

const ATTESTATION: ManagedVmAttestation = {
  profile: { name: 'managed-vm', version: 1 },
  verifiedAt: '2026-10-01T12:00:00.000Z',
  // The fake CLI versions are pinned independently for each provider.
  providerVersions: { claude: ['0.0.0'], codex: ['0.159.1'], nanogpt: [] },
};

let app: FastifyInstance;
let runner: RunnerModule;
let events: RunnerEvent[];
let requests: PermissionRequestInfo[];
let cwd: string;
let home: string;
let claudeUser: string;
let codexUser: string;
let argsFile: string;

const broker: PermissionBroker = {
  decide(info) {
    requests.push(info);
    return Promise.resolve({ behavior: 'deny', message: 'a human was asked' });
  },
};

async function setup(boundary: ManagedVmBoundary | undefined = { verify: async () => ATTESTATION }) {
  const port = await freePort();
  app = Fastify({ logger: false });
  runner = createRunnerModule({
    claudeBin: FAKE_CLAUDE,
    codexBin: FAKE_CODEX,
    codexHome: home,
    publicBaseUrl: `http://127.0.0.1:${port}`,
    broker,
    permissionTimeoutMs: 10_000,
    logger: silentLogger(),
    trustWorkspaces: false,
    managedVm: boundary,
    ambientConfig: { claudeManaged: [], claudeUser, codexManaged: [], codexUser },
  });
  runner.registerHookRoutes(app);
  await app.listen({ host: '127.0.0.1', port });
  runner.runner.onEvent((event) => events.push(event));
}

beforeEach(async () => {
  events = [];
  requests = [];
  cwd = await dirs.make('ws-');
  home = await dirs.make('home-');
  claudeUser = path.join(home, 'claude-settings.json');
  codexUser = path.join(home, 'config.toml');
  argsFile = path.join(home, 'args.json');
  process.env.CODEX_HOME = home;
  process.env.FAKE_CLAUDE_TRANSCRIPT_DIR = await dirs.make('transcripts-');
  process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
  process.env.FAKE_CODEX_ARGS_FILE = argsFile;
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

function spec(provider: AgentProvider, extra: Partial<StartSessionSpec> = {}): StartSessionSpec {
  return {
    sessionId: `ses_${randomUUID().slice(0, 8)}`,
    claudeSessionId: randomUUID(),
    resume: false,
    cwd,
    displayName: 'Anna · fe-1',
    appendSystemPrompt: 'You are fe-1, a developer.',
    initialMessage: null,
    mcpUrl: 'http://127.0.0.1:1/mcp/token',
    // What the legacy path would hand over: the managed VM profile must not pass any of it on.
    allowedTools: ['Bash(git status:*)'],
    deniedTools: ['Bash(git push:*)'],
    sandbox: { allowWrite: ['~/.npm'], allowedDomains: ['registry.npmjs.org'], allowLocalBinding: true },
    policy: buildSessionPolicy({
      config: testConfig(),
      role: 'developer',
      task: { repo: 'web' },
      permissionMode: 'default',
      placement: { kind: 'member_workspace', path: cwd, use: 'home' },
      managedVm: { boundary: ATTESTATION.profile },
    }),
    member: 'fe-1',
    permissionMode: 'default',
    provider,
    cols: 100,
    rows: 30,
    ...extra,
  };
}

const stateOf = (id: string): SessionState | undefined =>
  events
    .filter((e): e is Extract<RunnerEvent, { type: 'state' }> => e.type === 'state' && e.sessionId === id)
    .map((e) => e.state)
    .at(-1);
const chatOf = (id: string): ChatItem[] =>
  events.flatMap((e) => (e.type === 'chat' && e.sessionId === id ? e.items : []));
const assistantSaid = (id: string, text: string) =>
  waitFor(() => chatOf(id).find((i) => i.kind === 'assistant_text' && i.text === text), {
    what: `assistant: ${text}`,
  });
const waitIdle = (id: string) => waitFor(() => stateOf(id) === 'idle', { what: `idle (now ${stateOf(id)})` });

describe.each(['claude', 'codex'] as const)('managed VM profile with the fake %s CLI', (provider) => {
  const forceRequest = () => {
    process.env[
      provider === 'claude' ? 'FAKE_CLAUDE_FORCE_PERMISSION_REQUEST' : 'FAKE_CODEX_FORCE_APPROVAL'
    ] = '1';
  };

  it('starts question-free and gives the CLI no inner limits', async () => {
    await setup();
    const s = spec(provider);
    await runner.runner.start(s);
    await waitIdle(s.sessionId);
    const { argv, env } = JSON.parse(await readFile(argsFile, 'utf8')) as {
      argv: string[];
      env: Record<string, string>;
    };
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    if (provider === 'claude') {
      expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
      expect(argv).toContain('--strict-mcp-config');
      expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('user');
      const settings = JSON.parse(argv[argv.indexOf('--settings') + 1]!);
      expect(settings).not.toHaveProperty('sandbox');
      expect(settings.permissions).not.toHaveProperty('deny');
      expect(settings.permissions.allow).toEqual(['mcp__team__*']);
      expect(settings.skipDangerousModePermissionPrompt).toBe(true);
    } else {
      expect(argv[argv.indexOf('--sandbox') + 1]).toBe('danger-full-access');
      expect(argv[argv.indexOf('--ask-for-approval') + 1]).toBe('never');
    }
  });

  it('runs a routine turn without any local approval request', async () => {
    await setup();
    const s = spec(provider);
    await runner.runner.start(s);
    await waitIdle(s.sessionId);
    // `git push` is the fake's command that would ask in the legacy profile.
    await runner.runner.sendUserMessage(s.sessionId, 'Please PERMISSION push');
    await assistantSaid(s.sessionId, 'Echo: Please PERMISSION push');
    expect(requests).toHaveLength(0);
    expect(JSON.stringify(chatOf(s.sessionId))).not.toMatch(/Permission denied|rejected by user/);
  });

  it('refuses a request that arrives anyway, without asking a human and without stopping the work', async () => {
    forceRequest();
    await setup();
    const s = spec(provider);
    await runner.runner.start(s);
    await waitIdle(s.sessionId);
    await runner.runner.sendUserMessage(s.sessionId, 'Please PERMISSION push');
    await assistantSaid(s.sessionId, 'Echo: Please PERMISSION push');
    // Not the broker (the inbox), and no command rule judged it: the profile has none.
    expect(requests).toHaveLength(0);
    expect(JSON.stringify(chatOf(s.sessionId))).toContain('runs without local approvals');
  });

  it('keeps the research-only mode of a member in plan mode', async () => {
    await setup();
    const s = spec(provider, {
      permissionMode: 'plan',
      policy: buildSessionPolicy({
        config: testConfig(),
        role: 'developer',
        task: { repo: 'web' },
        permissionMode: 'plan',
        placement: { kind: 'member_workspace', path: cwd, use: 'home' },
        managedVm: { boundary: ATTESTATION.profile },
      }),
    });
    await runner.runner.start(s);
    await waitIdle(s.sessionId);
    const { argv } = JSON.parse(await readFile(argsFile, 'utf8')) as { argv: string[] };
    if (provider === 'claude') expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('plan');
    else expect(argv[argv.indexOf('--sandbox') + 1]).toBe('read-only');
  });
});
