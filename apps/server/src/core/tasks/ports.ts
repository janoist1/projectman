import type { AgentProvider, PlanUsage, ProjectPauseView } from '@projectman/shared';

export interface BoardPlanUsage {
  /** The last known usage of the project's account of a provider; reading starts no measurement. */
  peek(projectKey: string, provider?: AgentProvider): PlanUsage | null;
}

export interface BoardPauses {
  projectView(projectKey: string): ProjectPauseView;
}
