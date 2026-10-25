import { describe, expect, it } from 'vitest';
import { visibleActivity } from './member-activity';
import type { MemberActivity } from './member-activity';
import type { TaskViewer } from './task';

describe('visibleActivity', () => {
  it.each<{
    name: string;
    access: TaskViewer['access'];
    state: MemberActivity;
    visible: boolean;
    same: boolean;
  }>([
    {
      name: 'internal card',
      access: 'client',
      state: { activity: 'Read file', activityTaskKey: 'AR-1' },
      visible: false,
      same: false,
    },
    {
      name: 'shared card',
      access: 'client',
      state: { activity: 'Read file', activityTaskKey: 'AR-1' },
      visible: true,
      same: true,
    },
    {
      name: 'no card',
      access: 'client',
      state: { activity: 'Read file', activityTaskKey: null },
      visible: false,
      same: false,
    },
    { name: 'legacy state', access: 'client', state: { activity: 'Read file' }, visible: false, same: false },
    {
      name: 'owner',
      access: 'owner',
      state: { activity: 'Read file', activityTaskKey: 'AR-1' },
      visible: false,
      same: true,
    },
    {
      name: 'empty state',
      access: 'client',
      state: { activity: null, activityTaskKey: null },
      visible: false,
      same: true,
    },
    { name: 'empty legacy state', access: 'client', state: { activity: null }, visible: false, same: true },
    {
      name: 'hidden key without text',
      access: 'client',
      state: { activity: null, activityTaskKey: 'AR-1' },
      visible: false,
      same: false,
    },
  ])('$name', ({ access, state, visible, same }) => {
    const result = visibleActivity({ access }, state, () => visible);
    if (same) expect(result).toBe(state);
    else {
      expect(result).toEqual({ activity: null, activityTaskKey: null });
      expect(result).not.toBe(state);
    }
  });
});
