import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { decideGeminiToolCall, mapGeminiTool, parseGeminiHook } from './hooks';
import { geminiSpec, CONVERSATION_ID } from './test-helpers';
const fixtures = new URL('../../../../test/fixtures/gemini/hooks/stdin/', import.meta.url);
describe('Gemini hooks', () => {
  it('parses every supported captured hook and rejects other events', async () => {
    for (const file of await readdir(fixtures)) {
      const event = file.split('.')[0]!;
      const body = JSON.parse(await readFile(new URL(file, fixtures), 'utf8'));
      const result = parseGeminiHook(body, event);
      if (event === 'PostInvocation') expect(result).toBeNull();
      else
        expect(result).toMatchObject({
          session_id: body.conversationId,
          transcript_path: body.transcriptPath,
        });
    }
    expect(parseGeminiHook({}, 'PreToolUse')).toBeNull();
    expect(parseGeminiHook({ conversationId: CONVERSATION_ID }, 'PreToolUse')).toBeNull();
    expect(parseGeminiHook({ conversationId: CONVERSATION_ID }, 'Stop')?.hook_event_name).toBe('StopNotIdle');
    expect(
      parseGeminiHook({ conversationId: CONVERSATION_ID, error: 'failed' }, 'Stop')?.hook_event_name,
    ).toBe('StopFailure');
  });
  it.each([
    ['run_command', { CommandLine: 'npm test', Cwd: '/work' }, 'Bash', 'command'],
    ['view_file', { AbsolutePath: '/work/a' }, 'Read', 'read'],
    ['list_dir', { DirectoryPath: '/work' }, 'LS', 'read'],
    ['grep_search', { SearchPath: '/work', Query: 'x' }, 'Grep', 'read'],
    ['write_to_file', { TargetFile: '/work/a' }, 'Write', 'edit'],
    ['replace_file_content', { TargetFile: '/work/a' }, 'Edit', 'edit'],
    ['multi_replace_file_content', { TargetFile: '/work/a' }, 'Edit', 'edit'],
    [
      'call_mcp_tool',
      { ServerName: 'team', ToolName: 'get_task', Arguments: {} },
      'mcp__team__get_task',
      'team_mcp',
    ],
    ['call_mcp_tool', { ServerName: 'other', ToolName: 'tool' }, 'mcp__other__tool', 'mcp'],
    ['read_url_content', { Url: 'https://example.com' }, 'WebFetch', 'web'],
    ['search_web', {}, 'WebSearch', 'web'],
    ['browser_open', { Url: 'https://example.com' }, 'browser_open', 'browser'],
    ['new_tool', {}, 'new_tool', 'unknown'],
    ['list_dir', {}, 'LS', 'unknown'],
  ])('maps %s conservatively', (raw, args, name, category) => {
    expect(mapGeminiTool(raw as string, args as Record<string, unknown>)).toMatchObject({
      name,
      call: { category, sandboxed: false },
    });
  });
  it('applies policy, artifact exceptions and .agents approval', () => {
    const policy = geminiSpec().policy!;
    policy.deniedOperations = ['git_push', 'pull_request_create', 'pull_request_merge'];
    const check = (name: string, args: Record<string, unknown>, root: string | null = null) =>
      decideGeminiToolCall(
        policy,
        parseGeminiHook(
          { conversationId: CONVERSATION_ID, stepIdx: 1, toolCall: { name, args } },
          'PreToolUse',
        )!,
        root,
      );
    expect(check('run_command', { CommandLine: 'npm test', Cwd: '/work' }).decision).toBe('allow');
    expect(check('run_command', { CommandLine: 'echo hello', Cwd: '/work' }).decision).toBe('ask');
    expect(check('run_command', { CommandLine: 'npm test && echo hello', Cwd: '/work' }).decision).toBe(
      'ask',
    );
    expect(check('run_command', { CommandLine: 'git push', Cwd: '/work' })).toEqual({
      decision: 'deny',
      reason: 'denied_operation',
    });
    expect(check('write_to_file', { TargetFile: '/work/.agents/settings.json' }).decision).toBe('ask');
    policy.filesystem.deniedPaths = ['/providers'];
    const brain = `/providers/ses/antigravity-cli/brain/${CONVERSATION_ID}`;
    expect(check('view_file', { AbsolutePath: `${brain}/artifact.md` }, '/providers/ses').decision).toBe(
      'allow',
    );
    expect(
      check('view_file', { AbsolutePath: `${brain}/.system_generated/log` }, '/providers/ses').decision,
    ).toBe('deny');
    expect(check('view_file', { AbsolutePath: `${brain}/../other/a` }, '/providers/ses').decision).toBe(
      'deny',
    );
    expect(check('read_url_content', { Url: 'http://127.0.0.1' }).decision).toBe('deny');
  });
});
