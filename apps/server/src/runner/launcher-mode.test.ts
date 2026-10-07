import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { VM_PROFILE_NAME, VM_PROFILE_VERSION } from '@projectman/shared';
import type { AgentProvider } from '@projectman/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testConfig } from '../../test/helpers/test-template';
import { buildSessionPolicy } from '../../test/helpers/session-policy';
import type {
  LaunchSessionRequest,
  LaunchedSession,
  ManagedVmAttestation,
  ManagedVmBoundary,
  RunnerEvent,
  SessionLauncher,
  StartSessionSpec,
  WorkerLayout,
  WorkerRunRequest,
} from '../contracts';
import { SessionManager } from './runner';
import { FAKE_CLAUDE, FAKE_CODEX, silentLogger, tempDirs, waitFor } from './test-helpers';
import type { AgentSession } from './session';

/**
 * The runner in the managed VM (PM-140): sessions start through the launcher as the member's
 * worker. No pseudo-terminal here: the launcher is a fake that records requests and hands back
 * a fake relayed terminal.
 */

class FakeLaunched implements LaunchedSession {
  readonly pid = process.pid;
  readonly writes: string[] = [];
  readonly signals: string[] = [];
  private exitListener: ((event: { exitCode: number; signal?: number }) => void) | null = null;
  write(data: string) {
    this.writes.push(data);
  }
  resize() {}
  kill(signal?: string) {
    this.signals.push(signal ?? 'SIGTERM');
    this.exitListener?.({ exitCode: 0 });
  }
  onData() {}
  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListener = listener;
  }
}

const dirs = tempDirs();
let home: string;
let starts: LaunchSessionRequest[];
let runs: WorkerRunRequest[];
let loggedIn: boolean;
let events: RunnerEvent[];
let manager: SessionManager;

function launcher(): SessionLauncher {
  return {
    ping: async () => true,
    async start(request) {
      starts.push(request);
      return new FakeLaunched();
    },
    async run(request) {
      runs.push(request);
      if (request.program === 'claude')
        return {
          exitCode: loggedIn ? 0 : 1,
          stdout: JSON.stringify({
            loggedIn,
            authMethod: loggedIn ? 'claude.ai' : 'none',
            apiProvider: 'firstParty',
          }),
          stderr: '',
          timedOut: false,
        };
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    },
  };
}

beforeEach(async () => {
  home = await dirs.make('pm-worker-home-');
  starts = [];
  runs = [];
  loggedIn = true;
  events = [];
  const layout: WorkerLayout = {
    home: () => home,
    workspaces: () => path.join(home, 'workspaces'),
    sessions: (_m, p) => path.join(home, 'sessions', p),
    spoolIn: () => '/spool/in',
    spoolOut: () => '/spool/out',
  };
  manager = new SessionManager({
    claudeBin: FAKE_CLAUDE,
    codexBin: FAKE_CODEX,
    publicBaseUrl: 'http://127.0.0.1:4700',
    broker: { decide: async () => ({ behavior: 'deny' }) },
    permissionTimeoutMs: 60_000,
    logger: silentLogger(),
    env: {},
    launcher: launcher(),
    workerLayout: layout,
  });
  manager.onEvent((event) => events.push(event));
});

afterEach(async () => {
  await manager.shutdown();
  await dirs.cleanup();
});

const spec = (patch: Partial<StartSessionSpec> = {}): StartSessionSpec => ({
  sessionId: 'ses_1',
  claudeSessionId: '0b8a3c2e-1f5d-4c4e-9a7b-2d6e8f1a3b5c',
  resume: false,
  cwd: path.join(home, 'sessions', 'AR'),
  displayName: 'Dev · AR-1',
  appendSystemPrompt: 'You are dev.',
  mcpUrl: 'http://127.0.0.1:4700/mcp/tok',
  allowedTools: [],
  member: 'dev',
  egressToken: 'egress-token-0123456789',
  ...patch,
});

const session = (id = 'ses_1') =>
  (manager as unknown as { sessions: Map<string, AgentSession> }).sessions.get(id)!;

describe('sessions through the launcher', () => {
  it('starts the CLI through the launcher with its own arguments, member, directory and egress token', async () => {
    const info = await manager.start(spec());
    expect(info.pid).toBe(process.pid);
    expect(starts).toHaveLength(1);
    const request = starts[0]!;
    expect(request).toMatchObject({
      sessionId: 'ses_1',
      member: 'dev',
      provider: 'claude',
      cwd: path.join(home, 'sessions', 'AR'),
      egressToken: 'egress-token-0123456789',
      cols: 120,
      rows: 40,
    });
    // The CLI's own arguments: no fake script, no interpreter; the launcher picks the program.
    expect(request.args).not.toContain(FAKE_CLAUDE);
    expect(request.args).toEqual(
      expect.arrayContaining(['--session-id', '0b8a3c2e-1f5d-4c4e-9a7b-2d6e8f1a3b5c']),
    );
    // The login was checked and the trust recorded as the worker.
    expect(runs.map((r) => [r.member, r.program, r.args])).toEqual([
      ['dev', 'claude', ['auth', 'status']],
      ['dev', 'claude-trust', [path.join(home, 'sessions', 'AR')]],
    ]);
    expect(runs.every((r) => r.cwd === home)).toBe(true);
  });

  it('refuses a session without its member or egress token', async () => {
    await expect(manager.start(spec({ member: undefined }))).rejects.toThrow(/member, egress token/);
    await expect(manager.start(spec({ egressToken: undefined }))).rejects.toThrow(/member, egress token/);
    expect(starts).toEqual([]);
  });

  it('checks the worker’s own login and refuses when it is not logged in', async () => {
    loggedIn = false;
    await expect(manager.start(spec())).rejects.toMatchObject({ code: 'provider_not_logged_in' });
    expect(starts).toEqual([]);
    await expect(manager.providerStatus('claude', { member: 'dev' })).resolves.toMatchObject({
      loggedIn: false,
    });
  });

  it('records no trust for Codex and runs its login check as the worker', async () => {
    await manager.start(spec({ provider: 'codex' }));
    expect(runs.map((r) => [r.program, r.args])).toEqual([['codex', ['login', 'status']]]);
    expect(starts[0]!.provider).toBe('codex');
  });

  it('stops a session through the relayed terminal', async () => {
    await manager.start(spec());
    await manager.stop('ses_1', { force: true });
    await waitFor(() => events.find((e) => e.type === 'exit'), { what: 'exit' });
    expect(manager.isRunning('ses_1')).toBe(false);
  });

  it('follows a transcript only inside the worker home, never through a symlink out of it', async () => {
    await manager.start(spec());
    const projects = path.join(home, '.claude', 'projects', 'x');
    await mkdir(projects, { recursive: true });
    const outside = await dirs.make('pm-outside-');
    await writeFile(path.join(outside, 'secret.jsonl'), '{}\n');
    await symlink(outside, path.join(home, 'escape'));
    const hook = (transcript: string, event = 'SessionStart') =>
      session().handleHook(
        {
          hook_event_name: event,
          session_id: '0b8a3c2e-1f5d-4c4e-9a7b-2d6e8f1a3b5c',
          transcript_path: transcript,
        },
        new AbortController().signal,
      );
    await hook(path.join(outside, 'secret.jsonl'));
    await hook('~/escape/secret.jsonl');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events.filter((e) => e.type === 'transcript_path')).toEqual([]);
    await hook('~/.claude/projects/x/conversation.jsonl');
    const followed = await waitFor(() => events.find((e) => e.type === 'transcript_path'), {
      what: 'transcript',
    });
    expect(followed).toMatchObject({ path: path.join(projects, 'conversation.jsonl') });
  });
});

describe('a question-free session (PM-141) through the launcher', () => {
  const attestation: ManagedVmAttestation = {
    profile: { name: VM_PROFILE_NAME, version: VM_PROFILE_VERSION },
    verifiedAt: '2026-10-01T12:00:00.000Z',
    providerVersions: { claude: ['0.0.0'], codex: ['0.159.1'], nanogpt: [] },
  };
  const managedSpec = (provider: AgentProvider = 'claude') =>
    spec({
      provider,
      policy: buildSessionPolicy({
        config: testConfig(),
        role: 'developer',
        task: { repo: 'web' },
        placement: { kind: 'member_workspace', path: path.join(home, 'sessions', 'AR'), use: 'home' },
        managedVm: { boundary: attestation.profile },
      }),
    });
  function managedManager(boundary?: ManagedVmBoundary): SessionManager {
    return new SessionManager({
      claudeBin: FAKE_CLAUDE,
      codexBin: FAKE_CODEX,
      publicBaseUrl: 'http://127.0.0.1:4700',
      broker: { decide: async () => ({ behavior: 'deny' }) },
      permissionTimeoutMs: 60_000,
      logger: silentLogger(),
      env: {},
      launcher: launcher(),
      workerLayout: {
        home: () => home,
        workspaces: () => path.join(home, 'workspaces'),
        sessions: (_m, p) => path.join(home, 'sessions', p),
        spoolIn: () => '/spool/in',
        spoolOut: () => '/spool/out',
      },
      ...(boundary ? { managedVm: boundary } : {}),
    });
  }

  it('starts only with a verified boundary', async () => {
    const without = managedManager();
    try {
      await expect(without.start(managedSpec())).rejects.toMatchObject({ reason: 'no_boundary' });
    } finally {
      await without.shutdown();
    }
    const verified = managedManager({ verify: async () => attestation });
    try {
      await verified.start(managedSpec());
      expect(starts).toHaveLength(1);
    } finally {
      await verified.shutdown();
    }
  });

  it("reads the CLIs' user configuration from the worker home, and never through a link", async () => {
    const m = managedManager({ verify: async () => attestation });
    try {
      await mkdir(path.join(home, '.claude'), { recursive: true });
      await writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [] } }));
      await expect(m.start(managedSpec('claude'))).rejects.toMatchObject({ reason: 'ambient_config' });
      // A worker-controlled link to a clean file elsewhere is not followed: the start is refused.
      const outside = await dirs.make('pm-outside-');
      await writeFile(path.join(outside, 'config.toml'), '');
      await mkdir(path.join(home, '.codex'), { recursive: true });
      await symlink(path.join(outside, 'config.toml'), path.join(home, '.codex', 'config.toml'));
      await expect(m.start(managedSpec('codex'))).rejects.toMatchObject({ reason: 'ambient_config' });
      expect(starts).toEqual([]);
    } finally {
      await m.shutdown();
    }
  });
});
