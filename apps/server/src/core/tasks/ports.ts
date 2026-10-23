import type { AgentProvider, PlanUsage, ProjectPauseView } from '@projectman/shared';

export interface BoardPlanUsage {
  peek(provider?: AgentProvider): PlanUsage | null;
}

export interface BoardPauses {
  projectView(projectKey: string): ProjectPauseView;
}
