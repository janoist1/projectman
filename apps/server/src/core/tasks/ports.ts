import type { AgentProvider, PlanUsage, ProjectPauseView, Session } from '@projectman/shared';

export interface TaskPauseReader {
  isPaused(session: Pick<Session, 'id' | 'projectKey'>): boolean;
}

export interface BoardPlanUsage {
  peek(provider?: AgentProvider): PlanUsage | null;
}

export interface BoardPauses {
  projectView(projectKey: string): ProjectPauseView;
}
