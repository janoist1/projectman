import { ChatItem, formatInjectedTeamMessage } from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import { TranscriptParser, parseTranscript, resultSummary } from './parser';

/** Synthetic transcript entries shaped like Claude Code's JSONL (no real data). */
let n = 0;
const base = () => ({
  parentUuid: null,
  isSidechain: false,
  userType: 'external',
  cwd: '/work/repo',
  sessionId: '11111111-1111-4111-8111-111111111111',
  version: '2.1.223',
  gitBranch: 'main',
  uuid: `uuid-${++n}`,
  timestamp: `2026-09-29T10:00:${String(n % 60).padStart(2, '0')}.000Z`,
});
const user = (content: unknown, extra: Record<string, unknown> = {}) => ({
  ...base(),
  type: 'user',
  message: { role: 'user', content },
  ...extra,
});
const assistant = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  ...base(),
  type: 'assistant',
  message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'claude-x', content },
  ...extra,
});
const jsonl = (...entries: unknown[]) => entries.map((e) => JSON.stringify(e)).join('\n');

describe('TranscriptParser', () => {
  it('turns prompts and replies into user_text and assistant_text', () => {
    const items = parseTranscript(
      jsonl(
        user('Fix the login bug'),
        assistant([{ type: 'thinking', thinking: 'hmm', signature: 'x' }]),
        assistant([{ type: 'text', text: 'Looking into it.' }]),
      ),
    );
    expect(items.map((i) => i.kind)).toEqual(['user_text', 'assistant_text']);
    expect(items[0]).toMatchObject({ kind: 'user_text', text: 'Fix the login bug' });
    expect(items[1]).toMatchObject({ kind: 'assistant_text', text: 'Looking into it.' });
    for (const item of items) expect(ChatItem.safeParse(item).success).toBe(true);
  });

  it('uses the entry uuid as id, suffixed by block index for multi-block entries', () => {
    const single = user('hello');
    const multi = assistant([
      { type: 'text', text: 'Two things.' },
      { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/work/repo/a.ts' } },
    ]);
    const items = parseTranscript(jsonl(single, multi));
    expect(items[0]!.id).toBe(single.uuid);
    expect(items[1]!.id).toBe(`${multi.uuid}:0`);
    expect(items[2]!.id).toBe(`${multi.uuid}:1`);
    expect(items[0]!.ts).toBe(single.timestamp);
  });

  it('summarises tool calls and their results', () => {
    const items = parseTranscript(
      jsonl(
        assistant([
          {
            type: 'tool_use',
            id: 't1',
            name: 'Bash',
            input: { command: 'npm test\n# more', description: 'Run tests' },
          },
        ]),
        user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }], {
          toolUseResult: { stdout: '\n 12 passed', stderr: '', interrupted: false, isImage: false },
        }),
        assistant([
          {
            type: 'tool_use',
            id: 't2',
            name: 'Edit',
            input: { file_path: '/work/repo/src/app.ts', old_string: 'a', new_string: 'b' },
          },
        ]),
        user([{ type: 'tool_result', tool_use_id: 't2', content: 'The file has been updated.' }], {
          toolUseResult: { filePath: '/work/repo/src/app.ts' },
        }),
        assistant([{ type: 'tool_use', id: 't3', name: 'Grep', input: { pattern: 'TODO' } }]),
        user([{ type: 'tool_result', tool_use_id: 't3', content: 'Found 3 files', is_error: false }], {
          toolUseResult: { numFiles: 3, filenames: ['a', 'b', 'c'] },
        }),
        assistant([{ type: 'tool_use', id: 't4', name: 'Bash', input: { command: 'false' } }]),
        user([{ type: 'tool_result', tool_use_id: 't4', content: 'Exit code 1\nboom', is_error: true }]),
        assistant([{ type: 'tool_use', id: 't5', name: 'WebSearch', input: { query: 'vitest pty' } }]),
      ),
      { cwd: '/work/repo' },
    );
    expect(items).toMatchObject([
      { kind: 'tool_call', toolUseId: 't1', name: 'Bash', summary: 'npm test' },
      { kind: 'tool_result', toolUseId: 't1', ok: true, summary: '12 passed' },
      { kind: 'tool_call', toolUseId: 't2', name: 'Edit', summary: 'src/app.ts' },
      { kind: 'tool_result', toolUseId: 't2', ok: true, summary: 'Edited' },
      { kind: 'tool_call', name: 'Grep', summary: 'TODO' },
      { kind: 'tool_result', ok: true, summary: '3 files' },
      { kind: 'tool_call', name: 'Bash', summary: 'false' },
      { kind: 'tool_result', ok: false, summary: 'Exit code 1' },
      { kind: 'tool_call', name: 'WebSearch', summary: 'vitest pty' },
    ]);
    expect((items[2] as { input: unknown }).input).toEqual({
      file_path: '/work/repo/src/app.ts',
      old_string: 'a',
      new_string: 'b',
    });
  });

  it('cuts long tool inputs', () => {
    const [call] = parseTranscript(
      jsonl(
        assistant([
          { type: 'tool_use', id: 't', name: 'Write', input: { file_path: '/x', content: 'x'.repeat(5000) } },
        ]),
      ),
    );
    const content = (call as { input: { content: string } }).input.content;
    expect(content.length).toBeLessThan(2100);
    expect(content).toContain('(5000 chars)');
  });

  it('skips meta entries, sidechains, command noise and compaction summaries', () => {
    const items = parseTranscript(
      jsonl(
        user('Caveat: The messages below were generated by the user while running local commands.', {
          isMeta: true,
        }),
        user('<local-command-caveat>Caveat: …</local-command-caveat>'),
        user('<local-command-stdout>Compacted</local-command-stdout>'),
        user('<system-reminder>internal</system-reminder>'),
        user('<task-notification>\n<task-id>x</task-id>\n</task-notification>'),
        user('subagent prompt', { isSidechain: true }),
        assistant([{ type: 'text', text: 'subagent reply' }], { isSidechain: true }),
        user('This session is being continued from a previous conversation…', { isCompactSummary: true }),
        user([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } }]),
        { type: 'attachment', attachment: { type: 'x' }, uuid: 'a1' },
        { type: 'custom-title', customTitle: 'x', sessionId: 's' },
        { type: 'file-history-snapshot', messageId: 'm', snapshot: {} },
        'not json at all',
      ),
    );
    expect(items).toEqual([]);
  });

  it('keeps slash commands, shell input and compaction as system notes', () => {
    const items = parseTranscript(
      jsonl(
        user(
          '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>keep tests</command-args>',
        ),
        user('<bash-input>ls -la</bash-input>'),
        {
          ...base(),
          type: 'system',
          subtype: 'compact_boundary',
          content: 'Conversation compacted',
          level: 'info',
        },
        { ...base(), type: 'system', subtype: 'api_error', level: 'error', error: {} },
      ),
    );
    expect(items).toMatchObject([
      { kind: 'system_note', text: '/compact keep tests' },
      { kind: 'system_note', text: '! ls -la' },
      { kind: 'system_note', text: 'Conversation compacted' },
    ]);
  });

  it('reports interruptions', () => {
    const parser = new TranscriptParser();
    const interrupted = user([{ type: 'text', text: '[Request interrupted by user]' }]);
    const result = parser.parseLines([JSON.stringify(user('go')), JSON.stringify(interrupted)]);
    expect(result.items.at(-1)).toMatchObject({ kind: 'system_note', text: 'Interrupted by user' });
    expect(result.interruptedAt).toBe(interrupted.timestamp);
    const forTool = parser.parseLines([
      JSON.stringify(user([{ type: 'text', text: '[Request interrupted by user for tool use]' }])),
    ]);
    expect(forTool.interruptedAt).not.toBeNull();
    expect(parser.parseLines([JSON.stringify(user('fine'))]).interruptedAt).toBeNull();
  });

  it('recognises injected team messages, also inside pasted-content markers', () => {
    const plain = user(formatInjectedTeamMessage('qa', 'Tests fail on CI.\nPlease look.', 'AR-21'));
    const marked = user(
      `<pasted_content id="1">\n${formatInjectedTeamMessage('lead', 'Ship it')}\n</pasted_content id="1">`,
    );
    const items = parseTranscript(jsonl(plain, marked), { self: 'fe-1' });
    expect(items).toMatchObject([
      {
        kind: 'team_message',
        direction: 'in',
        from: 'qa',
        to: ['fe-1'],
        text: 'Tests fail on CI.\nPlease look.',
      },
      { kind: 'team_message', direction: 'in', from: 'lead', to: ['fe-1'], text: 'Ship it' },
    ]);
    for (const item of items) expect(ChatItem.safeParse(item).success).toBe(true);
  });

  it('turns send_message tool calls into outgoing team messages', () => {
    const items = parseTranscript(
      jsonl(
        assistant([
          {
            type: 'tool_use',
            id: 'm1',
            name: 'mcp__team__send_message',
            input: { to: ['qa', 'Not A Handle'], text: 'Ready for review' },
          },
        ]),
        user([{ type: 'tool_result', tool_use_id: 'm1', content: [{ type: 'text', text: 'Delivered' }] }]),
        assistant([
          { type: 'tool_use', id: 'm2', name: 'mcp__team__send_message', input: { to: 'lead', text: 'Hi' } },
        ]),
        user([{ type: 'tool_result', tool_use_id: 'm2', content: 'unknown member', is_error: true }]),
      ),
      { self: 'fe-1' },
    );
    expect(items).toMatchObject([
      { kind: 'team_message', direction: 'out', from: 'fe-1', to: ['qa'], text: 'Ready for review' },
      { kind: 'team_message', direction: 'out', from: 'fe-1', to: ['lead'], text: 'Hi' },
      { kind: 'system_note', text: 'Team message not delivered: unknown member' },
    ]);
    const anonymous = parseTranscript(
      jsonl(
        assistant([
          { type: 'tool_use', id: 'm3', name: 'mcp__team__send_message', input: { to: ['qa'], text: 'x' } },
        ]),
      ),
    );
    expect(anonymous[0]).toMatchObject({ from: 'unknown' });
  });

  it('keeps text of prompts with images and shows API error messages as notes', () => {
    const items = parseTranscript(
      jsonl(
        user([
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } },
          { type: 'text', text: 'What is on this screenshot?' },
        ]),
        assistant([{ type: 'text', text: 'API Error: Rate limit reached' }], { isApiErrorMessage: true }),
      ),
    );
    expect(items).toMatchObject([
      { kind: 'user_text', text: 'What is on this screenshot?' },
      { kind: 'system_note', text: 'API Error: Rate limit reached' },
    ]);
  });

  it('parses entries incrementally with the same results as a whole file', () => {
    const entries = [
      user('one'),
      assistant([{ type: 'tool_use', id: 'x1', name: 'Bash', input: { command: 'ls' } }]),
      user([{ type: 'tool_result', tool_use_id: 'x1', content: 'a\nb' }], {
        toolUseResult: { stdout: 'a\nb', stderr: '' },
      }),
      assistant([{ type: 'text', text: 'done' }]),
    ];
    const whole = parseTranscript(jsonl(...entries));
    const parser = new TranscriptParser();
    const pieces = entries.flatMap((e) => parser.parseLines([JSON.stringify(e)]).items);
    expect(pieces).toEqual(whole);
    expect(whole[2]).toMatchObject({ kind: 'tool_result', summary: 'a' });
  });
});

describe('resultSummary', () => {
  it('describes common tools', () => {
    expect(resultSummary('Read', true, '1\tx', { type: 'text', file: { numLines: 42 } })).toBe('42 lines');
    expect(resultSummary('Write', true, '', { type: 'create' })).toBe('Created');
    expect(resultSummary('Write', true, '', { type: 'update' })).toBe('Updated');
    expect(resultSummary('Bash', true, '', { stdout: '', stderr: '', interrupted: true })).toBe(
      'Interrupted',
    );
    expect(resultSummary('Bash', true, '', { stdout: '', stderr: '' })).toBe('Done');
    expect(resultSummary(null, false, '', null)).toBe('Failed');
    expect(resultSummary('Custom', true, `${'y'.repeat(300)}`, null)).toHaveLength(120);
  });
});
