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

  it('remembers nothing without a tool or for a Bash call without a command', () => {
    expect(sessionAllowScope(payload({}))).toBeNull();
    expect(sessionAllowScope(payload({ tool_name: 'Bash' }))).toBeNull();
    expect(sessionAllowScope(payload({ tool_name: 'Bash', tool_input: { command: '' } }))).toBeNull();
    expect(sessionAllowScope(payload({ tool_name: 'Bash', tool_input: 'ls' }))).toBeNull();
  });
});
