import { describe, expect, it } from 'vitest';
import { silentLogger } from '../../test-helpers';
import {
  codexPermissionOutput,
  codexPromptVisible,
  createCodexAdapter,
  detectCodexBlockingScreen,
} from './index';

const composer = [
  '› Ask Codex to do anything',
  '',
  '  ? for shortcuts                                              100% context left',
];

describe('Codex screen checks', () => {
  it('sees the composer, even below history that quotes a dialog', () => {
    const screen = [
      '› fix the login',
      '• Sign in with ChatGPT is mentioned in the docs; Trust this folder? is another dialog.',
      '',
      ...composer,
    ].join('\n');
    expect(codexPromptVisible(screen)).toBe(true);
    expect(detectCodexBlockingScreen(screen)).toBeNull();
    const working = ['› Ask Codex to do anything', '', '  Working (3s • esc to interrupt)'].join('\n');
    expect(codexPromptVisible(working)).toBe(true);
  });

  it('flags the dialogs that replace the composer', () => {
    const cases: Array<[string[], string]> = [
      [
        [
          'Trust this folder? Codex can read, edit, and run files here.',
          '› 1. Trust and continue',
          '  2. Quit',
        ],
        'Workspace trust confirmation is waiting in the terminal',
      ],
      [
        ['Sign in with ChatGPT to use Codex as part of your paid plan', '› 1. Sign in with ChatGPT'],
        'Codex is not logged in; log in from the terminal',
      ],
      [
        ['Hooks need review', '2 hooks need review before they can run.'],
        'Review of Codex hooks is waiting in the terminal',
      ],
      [
        ['Codex just got an upgrade. Introducing gpt-fake-2.', '› 1. Try new model'],
        'A Codex model upgrade prompt is waiting in the terminal',
      ],
      [
        ['Would you like to run the following command?', '  $ git push', '› 1. Yes, proceed'],
        'A Codex approval prompt is waiting in the terminal',
      ],
    ];
    for (const [lines, reason] of cases) {
      expect(codexPromptVisible(lines.join('\n'))).toBe(false);
      expect(detectCodexBlockingScreen(lines.join('\n'))).toBe(reason);
    }
    // A menu option is not the composer, even with a footer-like line below.
    expect(codexPromptVisible(['› 1. Trust and continue', '  context left'].join('\n'))).toBe(false);
  });
});

describe('Codex adapter', () => {
  const adapter = createCodexAdapter({ bin: 'codex', codexHome: '/nonexistent', logger: silentLogger() });

  it('answers PermissionRequest hooks without the fields Codex rejects', () => {
    expect(
      codexPermissionOutput({ behavior: 'allow', rememberForSession: true, updatedInput: { a: 1 } }),
    ).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    expect(codexPermissionOutput({ behavior: 'deny' })).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'A human denied this permission request.' },
      },
    });
    expect(adapter.denyOutput('Too late')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'Too late' },
      },
    });
  });

  it('parses hook payloads with a null transcript path and knows subagent hooks', () => {
    const payload = adapter.parseHook({
      hook_event_name: 'Stop',
      session_id: '019a0b1c-2d3e-7f40-8a5b-6c7d8e9f0a1b',
      turn_id: 't1',
      transcript_path: null,
      last_assistant_message: null,
      cwd: '/work',
      model: 'gpt-fake',
      permission_mode: 'default',
      stop_hook_active: false,
    });
    expect(payload).not.toBeNull();
    expect(payload).not.toHaveProperty('transcript_path');
    expect(payload).toMatchObject({ hook_event_name: 'Stop', turn_id: 't1', stop_hook_active: false });
    expect(adapter.isSubagentHook(payload!)).toBe(false);
    expect(adapter.isSubagentHook({ hook_event_name: 'Stop', agent_id: 'agent-1' })).toBe(true);
    expect(adapter.parseHook({ nope: 1 })).toBeNull();
  });

  it('declares what Codex can do', () => {
    expect(adapter.capabilities).toEqual({
      presetSessionId: false,
      sessionPermissionRules: false,
      readiness: 'screen',
    });
    expect(adapter.inputTools.has('request_user_input')).toBe(true);
    expect(adapter.timing.enterDelayMs).toBeGreaterThan(120);
  });
});
