import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StartSessionSpec } from '../../../contracts';
import { silentLogger, tempDirs } from '../../test-helpers';
import * as codexArgs from './args';
import {
  codexPermissionOutput,
  codexPromptVisible,
  codexWorkingVisible,
  createCodexAdapter,
  detectCodexBlockingScreen,
} from './index';

const composer = [
  '› Ask Codex to do anything',
  '',
  '  ? for shortcuts                                              100% context left',
];

describe('Codex launch workspace check (PM-357)', () => {
  const dirs = tempDirs();
  afterEach(async () => {
    vi.restoreAllMocks();
    await dirs.cleanup();
  });
  it.each([false, true])('rejects before building arguments, including resume=%s', async (resume) => {
    const cwd = await dirs.make();
    const home = await dirs.make();
    await mkdir(path.join(cwd, '.codex'));
    const file = path.join(cwd, '.codex/config.toml');
    await writeFile(file, '[hooks.Stop]\ncommand = "fictional-command"');
    const args = vi.spyOn(codexArgs, 'buildCodexArgs');
    const adapter = createCodexAdapter({ bin: 'codex', codexHome: home, logger: silentLogger() });
    const spec: StartSessionSpec = {
      sessionId: 'ses_test',
      claudeSessionId: '0b8a3c2e-1f5d-4c4e-9a7b-2d6e8f1a3b5c',
      resume,
      cwd,
      displayName: 'Fictional member',
      model: 'gpt-test',
      permissionMode: 'default',
      appendSystemPrompt: 'Test',
      initialMessage: null,
      mcpUrl: 'http://127.0.0.1:1/mcp/test',
      allowedTools: [],
      provider: 'codex',
    };
    const input = { spec, hookUrl: 'http://127.0.0.1:1/hooks/test', permissionTimeoutMs: 1000 };
    await expect(adapter.launch(input)).rejects.toMatchObject({ code: 'workspace_codex_config' });
    expect(args).not.toHaveBeenCalled();
    await writeFile(file, 'model = "gpt-test"');
    const launch = await adapter.launch(input);
    expect(args).toHaveBeenCalledOnce();
    expect(launch.cliArgs).toEqual(
      codexArgs.buildCodexArgs({ ...input, realCwd: cwd, codexHome: home, disabledMcpServers: [] }).args,
    );
  });
});

describe('Codex screen checks', () => {
  it('recognizes the owner-captured 0.159.1 NanoGPT composer without context metadata', () => {
    const screen = [
      '  >_ OpenAI Codex (v0.159.1)',
      '     ~/.projectman-nanogpt-probe-work-02061e',
      '  May the source be with you.',
      '  Tip: Maximize usage with GPT-6.1 Sol. ...',
      '› Ask Codex to do anything',
      '  z-ai/glm-5.3-flash-uncensored medium · ~/.projectman-nanogpt-probe-work-02061e   ⚠ 3 warnings · f2 to view',
    ].join('\n');
    expect(codexPromptVisible(screen)).toBe(true);
    expect(detectCodexBlockingScreen(screen)).toBeNull();
    expect(codexPromptVisible(screen.replace('   ⚠ 3 warnings · f2 to view', ''))).toBe(true);
    expect(codexPromptVisible(screen.replace('› Ask Codex to do anything', '› 1. Continue'))).toBe(false);
    expect(codexPromptVisible('› Ask Codex to do anything\n  ⚠ 3 warnings · f2 to view')).toBe(false);
  });
  it('recognises the 0.159.1 composer reported on PM-125', () => {
    // Transcribed from the real terminal lines recorded by the owner on PM-125.
    const screen = readFileSync(
      new URL('../../../../test/fixtures/codex-0.159.1-composer.txt', import.meta.url),
      'utf8',
    );
    expect(codexPromptVisible(screen)).toBe(true);
    expect(detectCodexBlockingScreen(screen)).toBeNull();
  });

  it.each([
    'GPT-6-Astra high fast · ~/Dev/projectman',
    'gpt-6.1-sol medium · /work/project',
    'z-ai/glm-5.3-flash-uncensored medium fast · ~/work/project',
    'deepseek/custom-model high fast auto · /work/project',
    'GPT-6-Astra high · C:\\work\\project',
  ])('recognises the status footer without legacy shortcuts: %s', (footer) => {
    expect(codexPromptVisible(`› Ask Codex to do anything\n\n${footer}`)).toBe(true);
  });

  it('requires a composer above the new footer and rejects menu options', () => {
    const footer = 'GPT-6-Astra high fast · ~/Dev/projectman … ⚠ 3 warnings · f2 to view';
    for (const screen of [
      footer,
      `${footer}\n› Ask Codex to do anything`,
      `› 1. Trust and continue\n${footer}`,
      '› Ask Codex to do anything\nGPT-6-Astra high fast',
      '› Ask Codex to do anything\nThere are 3 warnings in the code.',
    ]) {
      expect(codexPromptVisible(screen)).toBe(false);
    }
  });

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
    // The composer is up while it works, so only this tells a working screen from an idle one (PM-218).
    expect(codexWorkingVisible(working)).toBe(true);
    expect(codexWorkingVisible(screen)).toBe(false);
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
      toolGate: 'permission_request',
    });
    expect(adapter.inputTools.has('request_user_input')).toBe(true);
    expect(adapter.timing.enterDelayMs).toBeGreaterThan(120);
  });
});
