import { describe, expect, it } from 'vitest';
import { HookPayload, sessionPermissionUpdates } from './hook-payload';

const payload = (extra: Record<string, unknown>) =>
  HookPayload.parse({ hook_event_name: 'PermissionRequest', session_id: 's', ...extra });

describe('HookPayload', () => {
  it('accepts unknown fields and requires only the event name', () => {
    const parsed = HookPayload.parse({ hook_event_name: 'Stop', something_new: { a: 1 } });
    expect(parsed.something_new).toEqual({ a: 1 });
    expect(HookPayload.safeParse({ session_id: 'x' }).success).toBe(false);
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
});
