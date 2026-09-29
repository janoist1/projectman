import { createContext, useContext, useMemo } from 'react';
import type { Me } from '@projectman/shared';
import { useBoard, useInbox } from '../api/queries';
import { indexMembers } from '../lib/members';
import type { MemberIndex } from '../lib/members';
import { indexPipeline } from '../lib/pipeline';
import type { PipelineIndex } from '../lib/pipeline';

export const MeContext = createContext<Me | null>(null);

export function useMeContext(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error('useMeContext must be used inside the auth gate');
  return me;
}

export interface ProjectContextValue {
  key: string;
  me: Me;
  /** The viewer's member handle in this project (null if not a member). */
  myHandle: string | null;
  isOwner: boolean;
  /** Allowed actions by access level (the server enforces them too). */
  can: { createTasks: boolean; manageTeam: boolean; workInSessions: boolean };
  search: string;
  setSearch: (value: string) => void;
  openNewTask: () => void;
}

export const ProjectContext = createContext<ProjectContextValue | null>(null);

export function useProject(): ProjectContextValue {
  const value = useContext(ProjectContext);
  if (!value) throw new Error('useProject must be used inside a project route');
  return value;
}

/** Board-derived lookups shared by most screens. */
export function useProjectIndexes(key: string): {
  members: MemberIndex;
  pipeline: PipelineIndex | null;
} {
  const board = useBoard(key);
  const members = board.data?.members;
  const stages = board.data?.stages;
  const columns = board.data?.columns;
  return {
    members: useMemo(() => indexMembers(members), [members]),
    pipeline: useMemo(() => (stages && columns ? indexPipeline({ stages, columns }) : null), [stages, columns]),
  };
}

/** Open inbox items assigned to the viewer (all open items when the handle is unknown). */
export function useMyOpenInbox(key: string, myHandle: string | null) {
  const inbox = useInbox(key);
  const items = inbox.data?.items;
  return useMemo(
    () => (items ?? []).filter((item) => item.state === 'open' && (!myHandle || item.assignees.includes(myHandle))),
    [items, myHandle],
  );
}
