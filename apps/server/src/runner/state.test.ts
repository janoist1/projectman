import { describe, expect, it } from 'vitest';
import { nextState, type SessionSignal, type StateSnapshot } from './state';

function run(
  signals: SessionSignal[],
  from: StateSnapshot = { state: 'starting', activity: null },
): StateSnapshot {
  return signals.reduce(nextState, from);
}

describe('session state machine', () => {
  it('follows a normal turn', () => {
    let s: StateSnapshot = { state: 'starting', activity: null };
    s = nextState(s, { kind: 'session_start', source: 'startup', first: true });
    expect(s).toEqual({ state: 'idle', activity: null });
    s = nextState(s, { kind: 'prompt_submit' });
    expect(s).toEqual({ state: 'working', activity: null });
    s = nextState(s, { kind: 'pre_tool', activity: 'Bash: npm test', needsInput: false });
    expect(s).toEqual({ state: 'working', activity: 'Bash: npm test' });
    s = nextState(s, { kind: 'post_tool' });
    expect(s).toEqual({ state: 'working', activity: 'Bash: npm test' });
    s = nextState(s, { kind: 'stop' });
    expect(s).toEqual({ state: 'idle', activity: null });
  });

  it('waits for permission and resumes working once every request is answered', () => {
    let s = run([
      { kind: 'session_start', source: 'startup', first: true },
      { kind: 'prompt_submit' },
      { kind: 'permission_request', activity: 'Bash: git push' },
    ]);
    expect(s).toEqual({ state: 'waiting_permission', activity: 'Bash: git push' });
    s = nextState(s, { kind: 'pre_tool', activity: 'Read: a.ts', needsInput: false });
    expect(s.state).toBe('waiting_permission');
    s = nextState(s, { kind: 'permission_resolved', pending: 1 });
    expect(s.state).toBe('waiting_permission');
    s = nextState(s, { kind: 'permission_resolved', pending: 0 });
    expect(s).toEqual({ state: 'working', activity: 'Bash: git push' });
  });

  it('waits for input on AskUserQuestion until the tool finishes', () => {
    let s = run([{ kind: 'session_start', source: 'startup', first: true }, { kind: 'prompt_submit' }]);
    s = nextState(s, { kind: 'pre_tool', activity: 'AskUserQuestion', needsInput: true });
    expect(s.state).toBe('waiting_input');
    s = nextState(s, { kind: 'post_tool' });
    expect(s.state).toBe('working');
  });

  it('treats only the first SessionStart as readiness', () => {
    const working = run([
      { kind: 'session_start', source: 'startup', first: true },
      { kind: 'prompt_submit' },
    ]);
    expect(nextState(working, { kind: 'session_start', source: 'compact', first: false })).toBe(working);
    const cleared = nextState(
      { state: 'idle', activity: null },
      { kind: 'session_start', source: 'clear', first: false },
    );
    expect(cleared.state).toBe('idle');
  });

  it('flags setup screens while starting and clears them', () => {
    let s = nextState(
      { state: 'starting', activity: null },
      { kind: 'setup_prompt', description: 'Workspace trust confirmation is waiting in the terminal' },
    );
    expect(s).toEqual({
      state: 'waiting_input',
      activity: 'Workspace trust confirmation is waiting in the terminal',
    });
    expect(nextState(s, { kind: 'setup_cleared', ready: false })).toEqual({
      state: 'starting',
      activity: null,
    });
    s = nextState(s, { kind: 'session_start', source: 'startup', first: true });
    expect(s.state).toBe('idle');
  });

  it('flags a dialog that covers the prompt of a ready session, and returns to idle', () => {
    const idle: StateSnapshot = { state: 'idle', activity: null };
    const blocked = nextState(idle, { kind: 'setup_prompt', description: 'MCP approval' });
    expect(blocked).toEqual({ state: 'waiting_input', activity: 'MCP approval' });
    expect(nextState(blocked, { kind: 'setup_cleared', ready: true })).toEqual(idle);
    const working: StateSnapshot = { state: 'working', activity: 'Bash: ls' };
    expect(nextState(working, { kind: 'setup_prompt', description: 'x' })).toBe(working);
    expect(nextState(working, { kind: 'setup_cleared', ready: true })).toBe(working);
  });

  it('goes idle on interruption, idle_prompt and StopFailure', () => {
    const working: StateSnapshot = { state: 'working', activity: 'Bash: sleep 100' };
    expect(nextState(working, { kind: 'interrupted' }).state).toBe('idle');
    expect(nextState(working, { kind: 'notification', type: 'idle_prompt', message: null }).state).toBe(
      'idle',
    );
    expect(nextState(working, { kind: 'notification', type: 'auth_success', message: null })).toBe(working);
    expect(nextState(working, { kind: 'stop_failure', error: 'rate_limit' })).toEqual({
      state: 'idle',
      activity: 'Error: rate_limit',
    });
    expect(nextState({ state: 'idle', activity: null }, { kind: 'interrupted' }).state).toBe('idle');
  });

  it('ends in exited or failed and stays there', () => {
    const exited = nextState({ state: 'working', activity: 'x' }, { kind: 'exit', failed: false });
    expect(exited).toEqual({ state: 'exited', activity: null });
    expect(nextState({ state: 'starting', activity: null }, { kind: 'exit', failed: true }).state).toBe(
      'failed',
    );
    expect(nextState(exited, { kind: 'prompt_submit' })).toBe(exited);
    expect(nextState(exited, { kind: 'session_start', source: 'startup', first: true })).toBe(exited);
  });
});
