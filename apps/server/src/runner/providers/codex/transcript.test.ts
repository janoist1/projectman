import { formatInjectedTeamMessage } from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import { patchSummary } from '../../tools';
import { CodexTranscriptParser, outputSummary, parseCodexTranscript } from './transcript';

const ID = '019a0b1c-2d3e-7f40-8a5b-6c7d8e9f0a1b';
describe('NanoGPT quota failures', () => {
  it.each(['task_complete', 'turn_aborted'])(
    'detects %s failures only with the NanoGPT parser option',
    (type) => {
      const entry = JSON.stringify({
        timestamp: '2026-10-06T12:00:00Z',
        type: 'event_msg',
        payload: { type, error: { message: 'exceeded retry limit, last status: 429 Too Many Requests' } },
      });
      expect(new CodexTranscriptParser().parseLines([entry]).rateLimit).toBeUndefined();
      expect(new CodexTranscriptParser({ detectRateLimit: true }).parseLines([entry]).rateLimit).toEqual({
        at: '2026-10-06T12:00:00Z',
        message: 'exceeded retry limit, last status: 429 Too Many Requests',
      });
    },
  );
  it.each([
    [{ http_status: 429, message: 'Request failed' }, true],
    [{ codex_error_info: 'rate_limit_exceeded', message: 'Request failed' }, true],
    [{ codex_error_info: 'usage_limit_exceeded', message: 'Request failed' }, true],
    [
      {
        codex_error_info: { response_too_many_failed_attempts: { http_status_code: 429 } },
        message: 'Request failed',
      },
      true,
    ],
    [{ codex_error_info: { stream_error: { http_status_code: 429 } }, message: 'Request failed' }, true],
    [{ http_status: 500, message: 'Request failed after 429 tokens' }, false],
    [{ message: 'unrelated failure' }, false],
  ])('uses structured status before message matching: %j', (error, limited) => {
    const entry = JSON.stringify({
      timestamp: '2026-10-06T12:00:00Z',
      type: 'event_msg',
      payload: { type: 'task_complete', error },
    });
    expect(Boolean(new CodexTranscriptParser({ detectRateLimit: true }).parseLines([entry]).rateLimit)).toBe(
      limited,
    );
  });
});
let second = 0;
/** One rollout line, with increasing timestamps. */
function line(type: string, payload: unknown): string {
  second += 1;
  return JSON.stringify({
    timestamp: `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`,
    type,
    payload,
  });
}
const text = (role: string, value: string, kind = role === 'assistant' ? 'output_text' : 'input_text') =>
  line('response_item', { type: 'message', role, content: [{ type: kind, text: value }] });

const rollout = [
  line('session_meta', { id: ID, cwd: '/work', originator: 'codex_cli_rs', cli_version: '0.159.1' }),
  text('developer', 'You are fe-1, a developer.'),
  text('user', '<environment_context>\n  <cwd>/work</cwd>\n</environment_context>'),
  text('user', '# AGENTS.md instructions for /work\n\n<INSTRUCTIONS>\nUse npm.\n</INSTRUCTIONS>'),
  line('event_msg', { type: 'task_started', turn_id: 't1' }),
  text('user', 'Fix the login page'),
  line('response_item', { type: 'reasoning', summary: [], encrypted_content: 'x' }),
  line('response_item', {
    type: 'function_call',
    name: 'exec_command',
    arguments: JSON.stringify({ cmd: 'npm test', workdir: '/work' }),
    call_id: 'call_1',
  }),
  line('response_item', {
    type: 'function_call_output',
    call_id: 'call_1',
    output: 'Chunk ID: a1\nWall time: 1.2000 seconds\nProcess exited with code 1\nOutput:\n2 tests failed',
  }),
  line('response_item', {
    type: 'custom_tool_call',
    status: 'completed',
    call_id: 'call_2',
    name: 'apply_patch',
    input: '*** Begin Patch\n*** Update File: /work/src/login.ts\n@@\n-a\n+b\n*** End Patch',
  }),
  line('response_item', {
    type: 'custom_tool_call_output',
    call_id: 'call_2',
    output: 'Success. Updated the following files:\nM src/login.ts',
  }),
  line('response_item', {
    type: 'function_call',
    name: 'send_message',
    namespace: 'mcp__team__',
    arguments: JSON.stringify({ to: ['qa', 'Not A Handle'], text: 'Ready for review' }),
    call_id: 'call_3',
  }),
  line('response_item', {
    type: 'function_call_output',
    call_id: 'call_3',
    output: [{ type: 'input_text', text: 'Delivered to qa' }],
  }),
  line('response_item', {
    type: 'function_call',
    name: 'write_stdin',
    arguments: JSON.stringify({ session_id: 3, chars: '' }),
    call_id: 'call_4',
  }),
  line('response_item', { type: 'function_call_output', call_id: 'call_4', output: 'still running' }),
  line('response_item', {
    type: 'web_search_call',
    status: 'completed',
    action: { type: 'search', query: 'vitest mock timers' },
  }),
  text('assistant', 'Fixed; one test was flaky.'),
  line('event_msg', {
    type: 'token_count',
    info: null,
    rate_limits: {
      limit_id: 'codex',
      primary: { used_percent: 20, window_minutes: 300, resets_at: 1767232800 },
      secondary: { used_percent: 55.5, window_minutes: 10080, resets_at: 1767664800 },
    },
  }),
  line('event_msg', { type: 'task_complete', turn_id: 't1', last_agent_message: 'Fixed' }),
  text('user', formatInjectedTeamMessage('qa', 'Please re-run the tests', 'AR-7')),
  line('event_msg', { type: 'turn_aborted', turn_id: 't2', reason: 'interrupted' }),
  line('compacted', { message: 'summary' }),
];

describe('CodexTranscriptParser', () => {
  it('ignores context fragments and marks brief and human turns across incremental reads', () => {
    const parser = new CodexTranscriptParser({ self: 'dev-1' });
    const first = parser.parseLines([
      text('user', '<environment_context>cwd</environment_context>'),
      text('user', 'Fictional brief'),
    ]);
    expect(first.items).toEqual([
      expect.objectContaining({ kind: 'user_text', origin: 'brief', text: 'Fictional brief' }),
    ]);
    expect(parser.parseLines([text('user', 'Human follow-up')]).items[0]).toMatchObject({ origin: 'human' });
    expect(
      new CodexTranscriptParser({ firstUserOrigin: 'human' }).parseLines([text('user', 'After resume')])
        .items[0],
    ).toMatchObject({ origin: 'human' });
    const teamFirst = parseCodexTranscript(
      [text('user', formatInjectedTeamMessage('qa', 'Review ready')), text('user', 'Human reply')].join('\n'),
    );
    expect(teamFirst[0]).toMatchObject({ kind: 'team_message', from: 'qa' });
    expect(teamFirst[1]).toMatchObject({ origin: 'human' });
  });

  it('turns a rollout into chat items, skipping the context Codex adds itself', () => {
    const result = new CodexTranscriptParser({ self: 'fe-1', cwd: '/work' }).parseLines(rollout);
    expect(result.sessionId).toBe(ID);
    expect(result.items.map((i) => [i.kind, 'text' in i ? i.text : 'summary' in i ? i.summary : ''])).toEqual(
      [
        ['user_text', 'Fix the login page'],
        ['tool_call', 'npm test'],
        ['tool_result', '2 tests failed'],
        ['tool_call', 'src/login.ts'],
        ['tool_result', 'Success. Updated the following files:'],
        ['team_message', 'Ready for review'],
        ['tool_call', 'vitest mock timers'],
        ['assistant_text', 'Fixed; one test was flaky.'],
        ['team_message', 'Please re-run the tests'],
        ['system_note', 'Interrupted by user'],
        ['system_note', 'Conversation compacted'],
      ],
    );
    expect(result.items[1]).toMatchObject({
      name: 'Bash',
      toolUseId: 'call_1',
      input: { command: 'npm test' },
    });
    expect(result.items[2]).toMatchObject({ toolUseId: 'call_1', ok: false });
    expect(result.items[3]).toMatchObject({ name: 'apply_patch' });
    expect(result.items[4]).toMatchObject({ ok: true });
    expect(result.items[5]).toMatchObject({ direction: 'out', from: 'fe-1', to: ['qa'] });
    expect(result.items[6]).toMatchObject({ name: 'WebSearch' });
    expect(result.items[8]).toMatchObject({ direction: 'in', from: 'qa', to: ['fe-1'] });
    expect(result.interruptedAt).toBe(JSON.parse(rollout.at(-2)!).timestamp);
    expect(result.authError).toBeNull();
    expect(result.rateLimits).toEqual({
      at: JSON.parse(rollout[17]!).timestamp,
      limitId: 'codex',
      primary: { usedPercent: 20, windowMinutes: 300, resetsAt: 1767232800 },
      secondary: { usedPercent: 55.5, windowMinutes: 10080, resetsAt: 1767664800 },
    });
  });

  it('gives items the same ids on every read, and reads incrementally', () => {
    const whole = parseCodexTranscript(rollout.join('\n'), { self: 'fe-1' });
    const parser = new CodexTranscriptParser({ self: 'fe-1' });
    const parts = [
      ...parser.parseLines(rollout.slice(0, 10)).items,
      ...parser.parseLines(rollout.slice(10)).items,
    ];
    expect(parts).toEqual(whole);
    expect(new Set(whole.map((i) => i.id)).size).toBe(whole.length);
  });

  it('reports a failed turn, and a lost login', () => {
    const failed = new CodexTranscriptParser().parseLines([
      line('event_msg', {
        type: 'task_complete',
        turn_id: 't9',
        last_agent_message: null,
        error: {
          message: 'stream disconnected before completion',
          codex_error_info: 'response_stream_disconnected',
        },
      }),
    ]);
    expect(failed.items).toMatchObject([
      { kind: 'system_note', text: 'stream disconnected before completion' },
    ]);
    expect(failed.authError).toBeNull();
    expect(failed.turnEnded).toBe(true);

    const lost = new CodexTranscriptParser().parseLines([
      line('event_msg', {
        type: 'task_complete',
        turn_id: 't9',
        error: {
          message:
            'Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.',
          codex_error_info: 'unauthorized',
        },
      }),
    ]);
    expect(lost.authError).toContain('sign in again');
    const byInfo = new CodexTranscriptParser().parseLines([
      line('event_msg', {
        type: 'turn_aborted',
        reason: 'replaced',
        error: { message: 'x', codex_error_info: 'unauthorized' },
      }),
    ]);
    expect(byInfo.authError).toBe('x');
    expect(byInfo.interruptedAt).toBeNull();
  });

  it('skips malformed lines', () => {
    expect(
      new CodexTranscriptParser().parseLines(['{', '', 'null', '{"type":"response_item"}']).items,
    ).toEqual([]);
  });

  it('ends an empty failed turn and lets a later start supersede it', () => {
    const complete = line('event_msg', {
      type: 'task_complete',
      last_agent_message: null,
      error: { message: 'exceeded retry limit, last status: 429 Too Many Requests' },
    });
    const parser = new CodexTranscriptParser();
    expect(parser.parseLines([complete])).toMatchObject({ turnEnded: true, turnAt: expect.any(String) });
    expect(parser.parseLines([complete, line('event_msg', { type: 'task_started' })])).toMatchObject({
      turnEnded: false,
    });
    expect(
      parser.parseLines([line('event_msg', { type: 'turn_aborted', reason: 'replaced' })]),
    ).toMatchObject({
      turnEnded: true,
    });
  });
});

describe('tool output summaries', () => {
  it('reads exit codes of both output formats and rejections', () => {
    expect(outputSummary('Exit code: 0\nWall time: 0.1 seconds\nOutput:\nok')).toEqual({
      ok: true,
      summary: 'ok',
    });
    expect(outputSummary('Chunk ID: x\nWall time: 1 seconds\nProcess exited with code 2\nOutput:\n')).toEqual(
      {
        ok: false,
        summary: 'Exit code 2',
      },
    );
    expect(outputSummary('{"output":"done","metadata":{"exit_code":0}}')).toEqual({
      ok: true,
      summary: 'done',
    });
    expect(outputSummary('exec command rejected by user')).toMatchObject({ ok: false });
    expect(outputSummary('Delivered to qa')).toEqual({ ok: true, summary: 'Delivered to qa' });
  });

  it('names the first file of a patch', () => {
    expect(patchSummary('*** Begin Patch\n*** Add File: notes.txt\n+x\n*** End Patch')).toBe('notes.txt');
    expect(patchSummary('garbage')).toBeNull();
  });
});
