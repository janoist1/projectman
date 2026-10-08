import { describe, expect, it } from 'vitest';
import type { StartSessionSpec } from '../../../contracts';
import { silentLogger } from '../../test-helpers';
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
  const launch = (s: StartSessionSpec) =>
    adapter.launch({ spec: s, hookUrl: 'http://127.0.0.1:1/hooks/x', permissionTimeoutMs: 1000 });

  it("sets CLAUDE_CODE_TMPDIR to the session's own directory", async () => {
    const command = await launch(spec('/var/pm/tmp/0123456789ab'));
    expect(command.env).toEqual({ CLAUDE_CODE_TMPDIR: '/var/pm/tmp/0123456789ab' });
  });

  it('leaves the environment alone without a directory of its own', async () => {
    expect((await launch(spec())).env).toBeUndefined();
  });
});
