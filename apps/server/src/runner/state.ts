import type { SessionState } from '@projectman/shared';

/**
 * Session state machine, driven by the agent CLI's hooks (and a few terminal/transcript signals):
 *
 *   starting --SessionStart (or the prompt on screen)--> idle --UserPromptSubmit--> working --Stop--> idle
 *   idle|working --PreCompact--> working (compacting) --PostCompact--> idle (a compaction asked for) | working
 *   working --PermissionRequest--> waiting_permission --(answered)--> working
 *   working --PreToolUse(AskUserQuestion)--> waiting_input --PostToolUse--> working
 *   starting --(setup screen: trust/login)--> waiting_input --SessionStart--> idle
 *   idle --(dialog before the first prompt, e.g. MCP approval)--> waiting_input --(gone)--> idle
 *   any --(login lost mid-session)--> failed
 *   any --exit--> exited | failed
 */

export type SessionSignal =
  /**
   * SessionStart hook (source startup, resume, clear or compact). `first` is true for the
   * first one of the process, which means Claude Code is ready for input.
   */
  | { kind: 'session_start'; source: string | null; first: boolean }
  | { kind: 'prompt_submit' }
  | { kind: 'pre_tool'; activity: string | null; needsInput: boolean }
  | { kind: 'post_tool' }
  | { kind: 'permission_request'; activity: string | null }
  /** A permission request got its answer (or was withdrawn); `pending` requests remain. */
  | { kind: 'permission_resolved'; pending: number }
  | { kind: 'stop' }
  | { kind: 'stop_failure'; error: string | null }
  | { kind: 'notification'; type: string | null; message: string | null }
  /** The turn was interrupted from the terminal (Esc): Claude Code sends no Stop hook then. */
  | { kind: 'interrupted' }
  /** PreCompact: the conversation is being compacted (PM-213); the session works until it ends. */
  | { kind: 'compact_start' }
  /**
   * PostCompact, or giving the compaction up. A compaction the agent's own turn ran into (auto)
   * goes on with the turn; one that was asked for ends in idle, as no Stop hook follows it.
   */
  | { kind: 'compact_end'; idle: boolean }
  /** A dialog in the terminal (workspace trust, login, MCP approval, ...) blocks the session. */
  | { kind: 'setup_prompt'; description: string }
  /** The dialog is gone; `ready` tells whether the prompt was already up before. */
  | { kind: 'setup_cleared'; ready: boolean }
  /** The CLI lost its login (e.g. "Login expired · Please run /login"); the session is stopped. */
  | { kind: 'auth_failed'; message: string }
  | { kind: 'exit'; failed: boolean };

export interface StateSnapshot {
  state: SessionState;
  activity: string | null;
}

/** The activity of a session whose conversation is being compacted. */
export const COMPACTING_ACTIVITY = 'Compacting the conversation';

const TERMINAL_STATES: ReadonlySet<SessionState> = new Set(['exited', 'failed']);

export function isLive(state: SessionState): boolean {
  return !TERMINAL_STATES.has(state);
}

/** Pure transition function. Unknown or irrelevant signals keep the current state. */
export function nextState(current: StateSnapshot, signal: SessionSignal): StateSnapshot {
  const { state } = current;
  if (!isLive(state)) return current;

  switch (signal.kind) {
    case 'session_start':
      // The first SessionStart of a process means the CLI can take input (a setup screen,
      // if any, is gone). A later one, e.g. after compaction, can arrive in the middle of a
      // turn and changes nothing; after /clear the session is idle with a new conversation.
      if (signal.first && (state === 'starting' || state === 'waiting_input')) {
        return { state: 'idle', activity: null };
      }
      if (signal.source === 'clear') return { state: 'idle', activity: null };
      return current;

    case 'prompt_submit':
      return { state: 'working', activity: null };

    case 'pre_tool':
      if (signal.needsInput) return { state: 'waiting_input', activity: signal.activity };
      if (state === 'waiting_permission') return { state, activity: current.activity };
      return { state: 'working', activity: signal.activity ?? current.activity };

    case 'post_tool':
      if (state === 'waiting_input' || state === 'waiting_permission' || state === 'starting') {
        return { state: 'working', activity: current.activity };
      }
      return current;

    case 'permission_request':
      return { state: 'waiting_permission', activity: signal.activity ?? current.activity };

    case 'permission_resolved':
      if (state === 'waiting_permission' && signal.pending === 0) {
        return { state: 'working', activity: current.activity };
      }
      return current;

    case 'stop':
      return { state: 'idle', activity: null };

    case 'stop_failure':
      return { state: 'idle', activity: signal.error ? `Error: ${signal.error}` : null };

    case 'notification':
      // Claude finished about a minute ago and nobody typed: a safety net for a missed Stop.
      if (signal.type === 'idle_prompt' && state === 'working') return { state: 'idle', activity: null };
      if (signal.type === 'elicitation_dialog' || signal.type === 'elicitation_url_dialog') {
        return { state: 'waiting_input', activity: signal.message ?? current.activity };
      }
      if (signal.type === 'permission_prompt' && (state === 'working' || state === 'idle')) {
        return { state: 'waiting_permission', activity: signal.message ?? current.activity };
      }
      return current;

    case 'interrupted':
      if (state === 'working' || state === 'waiting_permission' || state === 'waiting_input') {
        return { state: 'idle', activity: null };
      }
      return current;

    case 'compact_start':
      if (state === 'idle' || state === 'working') {
        return { state: 'working', activity: COMPACTING_ACTIVITY };
      }
      return current;

    case 'compact_end':
      if (state === 'working') return { state: signal.idle ? 'idle' : 'working', activity: null };
      return current;

    case 'setup_prompt':
      if (state === 'starting' || state === 'waiting_input' || state === 'idle') {
        return { state: 'waiting_input', activity: signal.description };
      }
      return current;

    case 'setup_cleared':
      if (state === 'waiting_input') return { state: signal.ready ? 'idle' : 'starting', activity: null };
      return current;

    case 'auth_failed':
      return { state: 'failed', activity: signal.message };

    case 'exit':
      return { state: signal.failed ? 'failed' : 'exited', activity: null };
  }
}
