import type { SessionState } from './session';

/**
 * The one live-session rule (PM-1114). A leaf module, so the config rules (`duties`) can use it without
 * importing the session schema and its event imports.
 */

/** Session states of a live session: a process that runs (or starts) for its work item; exited and failed ones ended. */
export const LIVE_SESSION_STATES: SessionState[] = [
  'starting',
  'idle',
  'working',
  'waiting_permission',
  'waiting_input',
];

/** Whether a session in this state still runs (it may be idle between turns). */
export function isLiveSessionState(state: SessionState): boolean {
  return LIVE_SESSION_STATES.includes(state);
}

/** Whether a session still runs (`isLiveSessionState`). */
export function isLiveSession(session: { state: SessionState }): boolean {
  return isLiveSessionState(session.state);
}
