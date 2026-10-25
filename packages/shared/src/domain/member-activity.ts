import type { TaskKey, TaskViewer } from './task';

export interface MemberActivity {
  activity: string | null;
  activityTaskKey?: TaskKey | null;
}

/** A client gets an AI member's activity only from a session of a card they see (PM-245). */
export function visibleActivity<T extends MemberActivity>(
  viewer: Pick<TaskViewer, 'access'>,
  state: T,
  canSeeKey: (key: TaskKey) => boolean,
): T {
  if (viewer.access !== 'client') return state;
  if (state.activityTaskKey != null && canSeeKey(state.activityTaskKey)) return state;
  if (state.activity == null && state.activityTaskKey == null) return state;
  return { ...state, activity: null, activityTaskKey: null };
}
