import { z } from 'zod';
import type { ProjectConfig } from './schema';

export const OPERATOR_WATCH_LEVELS = ['report', 'unblock', 'drive'] as const;
export const OperatorWatch = z.enum(OPERATOR_WATCH_LEVELS);
export type OperatorWatch = z.infer<typeof OperatorWatch>;
export const DEFAULT_OPERATOR_WATCH: OperatorWatch = 'report';

/** How much the Operator does on its own on a system signal (PM-545); absent means report. */
export function operatorWatchOf(config: Pick<ProjectConfig, 'team'>): OperatorWatch {
  return config.team.operatorWatch ?? DEFAULT_OPERATOR_WATCH;
}
