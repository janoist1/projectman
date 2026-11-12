import { z } from 'zod';
import { ComplexityPoints } from './complexity';
import { StageId } from './pipeline';

/**
 * Why a step stage gave a card to its main owners or to its small-card owners (PM-1378). The rule that
 * decides is `pickStageOwners` (`config/stage-owner-pick`); everything but `small` hands the card to the
 * main owners.
 */
export const StageOwnerPickReason = z.discriminatedUnion('code', [
  z.object({ code: z.literal('small'), points: ComplexityPoints }),
  z.object({ code: z.literal('no_points') }),
  z.object({ code: z.literal('over_limit'), points: ComplexityPoints, maxPoints: ComplexityPoints }),
  z.object({
    code: z.literal('central_files'),
    files: z.array(z.string()).max(3),
    count: z.number().int().positive(),
  }),
  z.object({ code: z.literal('no_branch') }),
  z.object({ code: z.literal('unreadable') }),
  z.object({ code: z.literal('small_owner_is_author') }),
  z.object({ code: z.literal('small_owners_on_leave') }),
]);
export type StageOwnerPickReason = z.infer<typeof StageOwnerPickReason>;

/** The decision taken when the card entered the stage; the owners are resolved when used, never stored. */
export const StageOwnerPick = z.object({
  stageId: StageId,
  small: z.boolean(),
  reason: StageOwnerPickReason,
});
export type StageOwnerPick = z.infer<typeof StageOwnerPick>;

/** The changed files of the card's branch; null: they could not be read (unknown commit, failure). */
export type ChangedFiles = { paths: readonly string[]; truncated: boolean } | null;
