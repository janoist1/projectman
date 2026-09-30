import { describe, expect, it } from 'vitest';
import { ClaudeHookPayload, permissionOutput, sessionPermissionUpdates } from './permissions';

const payload = (extra: Record<string, unknown>) =>
  ClaudeHookPayload.parse({ hook_event_name: 'PermissionRequest', session_id: 's', ...extra });

describe('ClaudeHookPayload', () => {
  it('requires the suggestions to be a list when present', () => {
    expect(ClaudeHookPayload.safeParse({ hook_event_name: 'PermissionRequest' }).success).toBe(true);
    expect(
      ClaudeHookPayload.safeParse({ hook_event_name: 'PermissionRequest', permission_suggestions: {} })
        .success,
    ).toBe(false);
    expect(ClaudeHookPayload.parse({ hook_event_name: 'Stop', something_new: 1 }).something_new).toBe(1);
  });
});

describe('sessionPermissionUpdates', () => {
  it('re-scopes suggested allow rules to the session', () => {
    const updates = sessionPermissionUpdates(
      payload({
        tool_name: 'Bash',
        tool_input: { command: 'npm run lint' },
        permission_suggestions: [
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash', ruleContent: 'npm run lint' }],
            behavior: 'allow',
            destination: 'localSettings',
          },
          { type: 'addDirectories', directories: ['/tmp'], destination: 'localSettings' },
          { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
        ],
      }),
    );
    expect(updates).toEqual([
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'npm run lint' }],
        behavior: 'allow',
        destination: 'session',
      },
    ]);
  });

  it('keeps an accept-edits mode suggestion, scoped to the session', () => {
    const updates = sessionPermissionUpdates(
      payload({
        tool_name: 'Edit',
        permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
      }),
    );
    expect(updates).toEqual([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]);
  });

  it('allows the exact call again when nothing was suggested', () => {
    expect(
      sessionPermissionUpdates(payload({ tool_name: 'Bash', tool_input: { command: 'git push' } })),
    ).toEqual([
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'git push' }],
        behavior: 'allow',
        destination: 'session',
      },
    ]);
    expect(
      sessionPermissionUpdates(payload({ tool_name: 'WebFetch', tool_input: { url: 'https://x' } })),
    ).toEqual([
      { type: 'addRules', rules: [{ toolName: 'WebFetch' }], behavior: 'allow', destination: 'session' },
    ]);
    expect(sessionPermissionUpdates(payload({}))).toEqual([]);
  });

  it('never widens a Bash call without a command to every command', () => {
    expect(sessionPermissionUpdates(payload({ tool_name: 'Bash', tool_input: {} }))).toEqual([]);
  });
});

const request = ClaudeHookPayload.parse({
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: 'git push' },
  permission_suggestions: [
    {
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'git push' }],
      behavior: 'allow',
      destination: 'localSettings',
    },
  ],
});

describe('permissionOutput', () => {
  it('allows, optionally with a session rule', () => {
    expect(permissionOutput({ behavior: 'allow' }, request)).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    expect(permissionOutput({ behavior: 'allow', rememberForSession: true }, request)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'allow',
          updatedPermissions: [
            {
              type: 'addRules',
              rules: [{ toolName: 'Bash', ruleContent: 'git push' }],
              behavior: 'allow',
              destination: 'session',
            },
          ],
        },
      },
    });
  });

  it('passes an updated input only when it is an object', () => {
    const changed = permissionOutput(
      { behavior: 'allow', updatedInput: { command: 'git push --dry-run' } },
      request,
    );
    expect(changed.hookSpecificOutput.decision).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'git push --dry-run' },
    });
    const invalid = permissionOutput({ behavior: 'allow', updatedInput: 'git push --dry-run' }, request);
    expect(invalid.hookSpecificOutput.decision).toEqual({ behavior: 'allow' });
  });

  it('denies with the given message or a default one', () => {
    expect(
      permissionOutput({ behavior: 'deny', message: 'Not now' }, request).hookSpecificOutput.decision,
    ).toEqual({
      behavior: 'deny',
      message: 'Not now',
    });
    expect(permissionOutput({ behavior: 'deny' }, request).hookSpecificOutput.decision).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('denied'),
    });
  });
});
