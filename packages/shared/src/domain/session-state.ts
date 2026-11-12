import type { SessionState } from './session';

/**
 * The one place that groups session states (PM-1357; PM-1114 for the live rule). A leaf module, so the config
 * rules (`duties`) can use it without importing the session schema and its event imports. No other file
 * writes a list of session states (`test/architecture/session-state-lists.test.ts`).
 */

/** Session states of a live session: a process that runs (or starts) for its work item; exited and failed ones ended. */
export const LIVE_SESSION_STATES: SessionState[] = [
  'starting',
  'idle',
  'working',
  'waiting_permission',
  'waiting_input',
];

/** A turn is in progress: these count against `maxConcurrentAi`. */
const BUSY_SESSION_STATES: ReadonlySet<SessionState> = new Set(['starting', 'working', 'waiting_permission']);

/**
 * A member that is doing something now: a turn runs, or it waits for an answer. It differs from the busy states
 * by `waiting_input`: a session waiting for a person's answer does no work, but its member still holds the task.
 */
const ENGAGED_SESSION_STATES: ReadonlySet<SessionState> = new Set([
  'starting',
  'working',
  'waiting_permission',
  'waiting_input',
]);

/** A session works on its card (a starting one counts, as for the member's status). */
const WORKING_SESSION_STATES: ReadonlySet<SessionState> = new Set(['starting', 'working']);

/** Whether a session in this state still runs (it may be idle between turns). */
export function isLiveSessionState(state: SessionState): boolean {
  return LIVE_SESSION_STATES.includes(state);
}

/** Whether a session still runs (`isLiveSessionState`). */
export function isLiveSession(session: { state: SessionState }): boolean {
  return isLiveSessionState(session.state);
}

/** Whether a turn is in progress in the session (the capacity rule: starting, working, waiting for a permission). */
export function isBusySession(session: { state: SessionState }): boolean {
  return BUSY_SESSION_STATES.has(session.state);
}

/** Whether a member with a session in this state does something now (busy, or waiting for an answer). */
export function isEngagedSessionState(state: SessionState): boolean {
  return ENGAGED_SESSION_STATES.has(state);
}

/** Whether a session's member is engaged (`isEngagedSessionState`). */
export function isEngagedSession(session: { state: SessionState }): boolean {
  return isEngagedSessionState(session.state);
}

/** Whether a session in this state works (starting or working). */
export function isWorkingSessionState(state: SessionState): boolean {
  return WORKING_SESSION_STATES.has(state);
}

/** Whether a session works (`isWorkingSessionState`). */
export function isWorkingSession(session: { state: SessionState }): boolean {
  return isWorkingSessionState(session.state);
}
