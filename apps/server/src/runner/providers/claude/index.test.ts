import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { StartSessionSpec } from '../../../contracts';
import { silentLogger, tempDirs } from '../../test-helpers';
import {
  CLAUDE_AUTH_ERROR,
  claudePromptVisible,
  claudeWorkingVisible,
  createClaudeAdapter,
  detectBlockingScreen,
} from './index';

const promptBox = [
  '────────────── Anna · AR-1 ──',
  '❯ ',
  '──────────────────────────────',
  '  ? for shortcuts',
];

describe('Claude Code screen checks', () => {
  it('reads dialog words above a visible prompt box as history (a resumed conversation)', () => {
    // A resumed session redraws its history, including an old login error, above the prompt.
    const screen = [
      '⏺ Login expired · Please run /login',
      '',
      '> resume the task',
      '⏺ Resuming where we left off.',
      ...promptBox,
    ].join('\n');
    expect(claudePromptVisible(screen)).toBe(true);
    expect(detectBlockingScreen(screen)).toBeNull();
  });

  it('tells a working screen from an idle one: the prompt box is up in both (PM-218)', () => {
    const working = ['✻ Running… (12s · esc to interrupt)', ...promptBox];
    expect(claudePromptVisible(working.join('\n'))).toBe(true);
    expect(claudeWorkingVisible(working.join('\n'))).toBe(true);
    expect(claudeWorkingVisible(promptBox.join('\n'))).toBe(false);
  });

  it('still sees a dialog that replaced the prompt box', () => {
    const login = ['⏺ An earlier answer', 'Select login method:', '❯ 1. Claude account with subscription'];
    expect(claudePromptVisible(login.join('\n'))).toBe(false);
    expect(detectBlockingScreen(login.join('\n'))).toBe(
      'Claude Code is not logged in; log in from the terminal',
    );

    // A menu option between rules is not the prompt box.
    const trust = ['──────────', '❯ 1. Yes, I trust this folder', '──────────', 'Quick safety check'];
    expect(claudePromptVisible(trust.join('\n'))).toBe(false);
    expect(detectBlockingScreen(trust.join('\n'))).toBe(
      'Workspace trust confirmation is waiting in the terminal',
    );
  });

  it('recognises multi-line input and the boxed prompt of older versions', () => {
    const multiLine = [
      'Please run /login',
      '──── Anna · AR-1 ──',
      '❯ first line',
      '  second line',
      '────────',
    ];
    expect(detectBlockingScreen(multiLine.join('\n'))).toBeNull();
    const boxed = ['Not logged in', '╭──────────────╮', '│ > draft      │', '╰──────────────╯'];
    expect(detectBlockingScreen(boxed.join('\n'))).toBeNull();
    // A rule and an input line without a closing rule is not a box.
    expect(claudePromptVisible(['────────', '❯ '].join('\n'))).toBe(false);
  });
});

describe('refuseToolOutput (PM-743)', () => {
  it('turns any tool call away with a PreToolUse deny', () => {
    const adapter = createClaudeAdapter({ bin: 'claude', logger: silentLogger() });
    expect(adapter.refuseToolOutput!('wait')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'wait',
      },
    });
  });
});

describe('detectBlockingScreen', () => {
  it('recognises Claude Code dialogs that block input', () => {
    expect(
      detectBlockingScreen('Quick safety check: Is this a project you created or one you trust?'),
    ).toMatch(/trust/);
    expect(detectBlockingScreen('New MCP server found in this project: db')).toMatch(/MCP/);
    expect(detectBlockingScreen('3 new MCP servers found in this project')).toMatch(/MCP/);
    expect(detectBlockingScreen('Select login method:')).toMatch(/not logged in/);
    expect(detectBlockingScreen('> Try "fix lint errors"\n  ? for shortcuts')).toBeNull();
  });
});

describe('Claude Code login failures', () => {
  const adapter = createClaudeAdapter({ bin: 'claude', logger: silentLogger() });

  it('recognises the messages of a lost login', () => {
    for (const text of [
      'Login expired · Please run /login',
      'Not logged in · Please run /login',
      'OAuth token has expired',
    ]) {
      expect(CLAUDE_AUTH_ERROR.test(text)).toBe(true);
    }
    expect(CLAUDE_AUTH_ERROR.test('Rate limited, try again later')).toBe(false);
  });

  it('finds a lost login in the transcript and in a StopFailure hook', () => {
    const parser = adapter.createTranscriptParser({ self: 'fe-1', cwd: null });
    const entry = {
      type: 'assistant',
      uuid: 'u1',
      timestamp: '2026-01-01T00:00:00.000Z',
      isApiErrorMessage: true,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Login expired · Please run /login' }] },
    };
    expect(parser.parseLines([JSON.stringify(entry)])).toMatchObject({
      authError: 'Login expired · Please run /login',
      items: [{ kind: 'system_note', text: 'Login expired · Please run /login' }],
    });
    expect(
      adapter.hookAuthError({ hook_event_name: 'StopFailure', error: 'authentication_failed' }),
    ).toContain('authentication_failed');
    expect(adapter.hookAuthError({ hook_event_name: 'StopFailure', error: 'rate_limit' })).toBeNull();
    expect(adapter.hookAuthError({ hook_event_name: 'Stop' })).toBeNull();
  });

  it('declares what Claude Code can do', () => {
    expect(adapter.capabilities).toEqual({
      presetSessionId: true,
      sessionPermissionRules: true,
      readiness: 'session_start',
      toolGate: 'permission_request',
      mcpImageResults: true,
      sandboxEscalation: false,
    });
  });
});

describe('the temporary root of a Claude Code process (PM-353)', () => {
  const adapter = createClaudeAdapter({ bin: 'claude', logger: silentLogger(), trustWorkspaces: false });
  const spec = (tmpDir?: string): StartSessionSpec => ({
    sessionId: 'ses_1',
    claudeSessionId: '11111111-1111-4111-8111-111111111111',
    resume: false,
    cwd: '/work/checkout',
    displayName: 'Anna · AR-1',
    appendSystemPrompt: 'You are Anna.',
    mcpUrl: 'http://127.0.0.1:4700/mcp/tok',
    allowedTools: [],
    ...(tmpDir
      ? {
          sandbox: {
            allowWrite: [tmpDir],
            allowedDomains: [],
            allowLocalBinding: true,
            portable: { allowWrite: [tmpDir], env: {}, tmpDir },
          },
        }
      : {}),
  });
  const dirs = tempDirs();
  afterEach(() => dirs.cleanup());
  const launch = async (s: StartSessionSpec, sessionConfigDir?: string) =>
    adapter.launch({
      spec: s,
      hookUrl: 'http://127.0.0.1:1/hooks/x',
      sessionConfigDir: sessionConfigDir ?? (await dirs.make()),
      permissionTimeoutMs: 1000,
    });

  it("sets CLAUDE_CODE_TMPDIR to the session's own directory", async () => {
    const command = await launch(spec('/var/pm/tmp/0123456789ab'));
    expect(command.env).toEqual({ CLAUDE_CODE_TMPDIR: '/var/pm/tmp/0123456789ab' });
  });

  it('leaves the environment alone without a directory of its own', async () => {
    expect((await launch(spec())).env).toBeUndefined();
  });
});

describe('the private launch files of a Claude Code session (PM-156)', () => {
  const HOOK_TOKEN = 'CANARY-hook-token-0123456789';
  const MCP_TOKEN = 'CANARY-mcp-token-9876543210';
  const adapter = createClaudeAdapter({ bin: 'claude', logger: silentLogger(), trustWorkspaces: false });
  const dirs = tempDirs();
  afterEach(() => dirs.cleanup());
  const spec = (resume: boolean, sandboxed: boolean): StartSessionSpec => ({
    sessionId: 'ses_1',
    claudeSessionId: '11111111-1111-4111-8111-111111111111',
    resume,
    cwd: '/work/checkout',
    displayName: 'Anna · AR-1',
    appendSystemPrompt: 'You are Anna.',
    mcpUrl: `http://127.0.0.1:4700/mcp/${MCP_TOKEN}`,
    allowedTools: [],
    ...(sandboxed ? { sandbox: { allowWrite: [], allowedDomains: [], allowLocalBinding: true } } : {}),
  });
  const launch = async (resume: boolean, sandboxed: boolean) => {
    const sessionConfigDir = await dirs.make();
    const launched = await adapter.launch({
      spec: spec(resume, sandboxed),
      hookUrl: `http://127.0.0.1:4700/hooks/${HOOK_TOKEN}`,
      sessionConfigDir,
      permissionTimeoutMs: 1000,
    });
    return { launched, sessionConfigDir };
  };

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])('keeps the tokens off the command line, resume=%s sandboxed=%s', async (resume, sandboxed) => {
    const { launched, sessionConfigDir } = await launch(resume, sandboxed);
    const argv = [launched.file, ...launched.args].join('\n');
    expect(argv).not.toContain(HOOK_TOKEN);
    expect(argv).not.toContain(MCP_TOKEN);
    const flag = (name: string) => launched.cliArgs[launched.cliArgs.indexOf(name) + 1];
    expect(flag('--settings')).toBe(path.join(sessionConfigDir, 'claude-settings.json'));
    expect(flag('--mcp-config')).toBe(path.join(sessionConfigDir, 'claude-mcp.json'));
    expect(flag(resume ? '--resume' : '--session-id')).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('writes the files with the tokens, readable by the owner alone', async () => {
    const { sessionConfigDir } = await launch(false, false);
    const settings = JSON.parse(await readFile(path.join(sessionConfigDir, 'claude-settings.json'), 'utf8'));
    expect(settings.hooks.PermissionRequest[0].hooks[0]).toMatchObject({
      type: 'http',
      url: `http://127.0.0.1:4700/hooks/${HOOK_TOKEN}`,
    });
    // SessionStart is a command: it names the forwarder's target file, not the URL.
    const start = settings.hooks.SessionStart[0].hooks[0].command as string;
    expect(start).toContain(path.join(sessionConfigDir, 'hook.curl'));
    expect(start).not.toContain(HOOK_TOKEN);
    expect(JSON.parse(await readFile(path.join(sessionConfigDir, 'claude-mcp.json'), 'utf8'))).toEqual({
      mcpServers: { team: { type: 'http', url: `http://127.0.0.1:4700/mcp/${MCP_TOKEN}` } },
    });
    expect(await readFile(path.join(sessionConfigDir, 'hook.curl'), 'utf8')).toBe(
      `url = "http://127.0.0.1:4700/hooks/${HOOK_TOKEN}"\n`,
    );
    for (const name of ['claude-settings.json', 'claude-mcp.json', 'hook.curl'])
      expect((await stat(path.join(sessionConfigDir, name))).mode & 0o777).toBe(0o600);
  });

  it('puts no token in a hook command of a sandboxed session', async () => {
    const { sessionConfigDir } = await launch(false, true);
    const text = await readFile(path.join(sessionConfigDir, 'claude-settings.json'), 'utf8');
    const settings = JSON.parse(text);
    for (const groups of Object.values<Array<{ hooks: Array<{ type: string; command?: string }> }>>(
      settings.hooks,
    ))
      for (const hook of groups[0]!.hooks) {
        expect(hook.type).toBe('command');
        expect(hook.command).not.toContain(HOOK_TOKEN);
        expect(hook.command).toContain(path.join(sessionConfigDir, 'hook.curl'));
      }
    expect(text).not.toContain(HOOK_TOKEN);
  });

  it('refuses a session folder it cannot write to, without quoting a token', async () => {
    const error = await adapter
      .launch({
        spec: spec(false, false),
        hookUrl: `http://127.0.0.1:4700/hooks/${HOOK_TOKEN}`,
        sessionConfigDir: path.join(await dirs.make(), 'missing'),
        permissionTimeoutMs: 1000,
      })
      .then(
        () => null,
        (err: Error) => err,
      );
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).not.toContain(HOOK_TOKEN);
  });
});
