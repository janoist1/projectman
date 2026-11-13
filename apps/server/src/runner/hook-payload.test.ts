import { describe, expect, it } from 'vitest';
import { HookPayload, sessionAllowScope } from './hook-payload';

const payload = (extra: Record<string, unknown>) =>
  HookPayload.parse({ hook_event_name: 'PermissionRequest', session_id: 's', ...extra });

describe('HookPayload', () => {
  it('accepts unknown fields and requires only the event name', () => {
    const parsed = HookPayload.parse({ hook_event_name: 'Stop', something_new: { a: 1 } });
    expect(parsed.something_new).toEqual({ a: 1 });
    expect(HookPayload.safeParse({ session_id: 'x' }).success).toBe(false);
  });
});

describe('sessionAllowScope', () => {
  it('covers the same Bash command, or the tool itself for other tools', () => {
    expect(sessionAllowScope(payload({ tool_name: 'Bash', tool_input: { command: 'git push' } }))).toEqual({
      toolName: 'Bash',
      command: 'git push',
    });
    expect(sessionAllowScope(payload({ tool_name: 'WebFetch', tool_input: { url: 'https://x' } }))).toEqual({
      toolName: 'WebFetch',
    });
  });

  it('adds the folder of a path tool call, resolved against the working directory', () => {
    const scope = (extra: Record<string, unknown>) =>
      sessionAllowScope(payload({ cwd: '/w/repo', ...extra }));
    expect(scope({ tool_name: 'Read', tool_input: { file_path: '/w/repo/src/a.ts' } })).toEqual({
      toolName: 'Read',
      directories: ['/w/repo/src'],
    });
    expect(scope({ tool_name: 'Edit', tool_input: { file_path: 'src/x/../a.ts' } })?.directories).toEqual([
      '/w/repo/src',
    ]);
    expect(scope({ tool_name: 'Grep', tool_input: { path: '/w/other', pattern: 'x' } })?.directories).toEqual(
      ['/w/other'],
    );
    expect(scope({ tool_name: 'LS', tool_input: { path: '/w/other' } })?.directories).toEqual(['/w/other']);
    expect(scope({ tool_name: 'Grep', tool_input: { pattern: 'x' } })?.directories).toEqual(['/w/repo']);
  });

  it('remembers nothing for a path tool call that shows no folder', () => {
    const scope = (extra: Record<string, unknown>) => sessionAllowScope(payload(extra));
    // A file tool without a path, a relative path without a working directory, a folder tool without either.
    expect(scope({ cwd: '/w/repo', tool_name: 'Read', tool_input: {} })).toBeNull();
    expect(scope({ tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } })).toBeNull();
    expect(scope({ tool_name: 'Grep', tool_input: { pattern: 'x' } })).toBeNull();
    expect(scope({ tool_name: 'Read', tool_input: { file_path: '/w/a.ts' } })?.directories).toEqual(['/w']);
  });

  it('lists the folders of every file an apply_patch touches, moves included', () => {
    const patch =
      '*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: lib/a.ts\n*** Delete File: /abs/x.ts\n*** End Patch';
    const scope = (tool_input: unknown) =>
      sessionAllowScope(payload({ cwd: '/w/repo', tool_name: 'apply_patch', tool_input }));
    expect(scope({ command: patch })?.directories).toEqual(['/abs', '/w/repo/lib', '/w/repo/src']);
    expect(scope(patch)?.directories).toEqual(['/abs', '/w/repo/lib', '/w/repo/src']);
    expect(scope({ command: 'no files here' })).toBeNull();
    // Codex trims the start of a header line, so an indented header names a file too.
    expect(
      scope({ command: '*** Begin Patch\n  *** Update File: src/a.ts\n\t*** Move to: lib/a.ts' })
        ?.directories,
    ).toEqual(['/w/repo/lib', '/w/repo/src']);
    // The set of blanks Codex trims also holds U+0085, which the regex \s does not.
    expect(scope({ command: '*** Begin Patch\n\u0085*** Update File: src/a.ts' })?.directories).toEqual([
      '/w/repo/src',
    ]);
  });

  it('remembers nothing without a tool or for a Bash call without a command', () => {
    expect(sessionAllowScope(payload({}))).toBeNull();
    expect(sessionAllowScope(payload({ tool_name: 'Bash' }))).toBeNull();
    expect(sessionAllowScope(payload({ tool_name: 'Bash', tool_input: { command: '' } }))).toBeNull();
    expect(sessionAllowScope(payload({ tool_name: 'Bash', tool_input: 'ls' }))).toBeNull();
  });
});
