import { describe, expect, it } from 'vitest';
import { HookPayload } from './hook-payload';
import { detectBlockingScreen, permissionOutput } from './session';

const request = HookPayload.parse({
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
