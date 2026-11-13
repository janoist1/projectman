import type { ProjectManagerCorner } from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import { projectManagerStripOf } from './projectManagerChannel';

/** The corner of the project manager in the given state, with `open` items in the queue and none in work. */
function corner(state: ProjectManagerCorner['state'], open: number): ProjectManagerCorner {
  return {
    member: { handle: 'pm', displayName: 'PM', onLeave: false },
    state,
    sessionId: null,
    requests: [],
    readOnly: false,
    signals: [],
    openSignals: 0,
    queue: { open, current: null },
  } as ProjectManagerCorner;
}

describe('operatorStripOf without an item in work', () => {
  it('says the session is starting only while it is starting', () => {
    expect(projectManagerStripOf(corner('starting', 2))).toEqual({ kind: 'starting' });
  });

  // PM-1269: an open item that wakes nobody stays in the queue while the project manager is idle.
  it.each(['available', 'working', 'on_leave'] as const)(
    'has no strip while the project manager is %s',
    (state) => {
      expect(projectManagerStripOf(corner(state, 2))).toBeNull();
    },
  );
});
