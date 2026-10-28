import { z } from 'zod';
import { MemberHandle } from './member';

export const COMPLEXITY_POINTS = [1, 2, 3, 5, 8, 13] as const;
export const ComplexityPoints = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(5),
  z.literal(8),
  z.literal(13),
]);
export type ComplexityPoints = z.infer<typeof ComplexityPoints>;
export const MAX_COMPLEXITY = 13;
export const DEFAULT_COMPLEXITY_LIMIT = 5;
/** The largest card a temp worker takes when the project sets nothing (PM-1101). */
export const DEFAULT_TEMP_MAX_POINTS: ComplexityPoints = 5;
export const COMPLEXITY_REASON_MAX = 300;

export const TaskComplexity = z.object({
  points: ComplexityPoints,
  reason: z.string().max(COMPLEXITY_REASON_MAX).nullable(),
  setBy: MemberHandle,
  setAt: z.string(),
});
export type TaskComplexity = z.infer<typeof TaskComplexity>;

export function isComplexityPoints(value: unknown): value is ComplexityPoints {
  return ComplexityPoints.safeParse(value).success;
}

export function complexityText(c: TaskComplexity): string {
  return `${c.points} points${c.reason ? ` — ${c.reason.replace(/\s+/g, ' ')}` : ''}`;
}
