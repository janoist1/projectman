import type { DomainEvents } from '../../core/base';
import type { StartFailures } from './start-failures';

/**
 * Feeds the failed-start counter (PM-1335) from the sessions' events. Wired before the listeners that retry
 * the starts of a member whose session ended, so the failure is counted before the retry looks at the hold.
 */
export function wireStartFailures(deps: {
  events: DomainEvents;
  startFailures: Pick<StartFailures, 'sessionEnded' | 'stateChanged' | 'memberRenamed'>;
}): void {
  const { events, startFailures } = deps;
  events.on('session_ended', (session) => startFailures.sessionEnded(session));
  events.on('session_state_changed', (session) => startFailures.stateChanged(session));
  // The counts of a renamed member's old handle are of no use (the queue's lane is forgotten the same way).
  events.on('config_changed', ({ projectKey, renames }) => {
    for (const from of Object.keys(renames ?? {})) startFailures.memberRenamed(projectKey, from);
  });
}
