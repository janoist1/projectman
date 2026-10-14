import { TaskKey } from '@projectman/shared';
import { z } from 'zod';
import { defineTool, type TeamToolGroup } from '../kit';

export const MERGE_TOOL_GROUP: TeamToolGroup = {
  module: 'services/merges',
  tools: [
    defineTool({
      name: 'merge_task',
      title: 'Merge a task',
      readOnly: false,
      description:
        "Start merging the card's approved commit into its repository's default branch. Only the card's merger may call this. The result arrives as a team message. Call again to retry a failed or blocked merge.",
      input: {
        task_key: TaskKey,
        fix_conflict: z
          .boolean()
          .optional()
          .describe(
            'After a conflict failure, request a writable merge-fix worktree. Your session restarts when this turn ends.',
          ),
        resolution: z
          .string()
          .min(1)
          .max(2000)
          .optional()
          .describe(
            'While fixing: describe what and where you resolved, after committing the mechanical conflict resolution.',
          ),
      },
      async run({ ctx, args, handler }) {
        const { task } = await handler.mergeTask(ctx, {
          taskKey: args.task_key,
          fixConflict: args.fix_conflict,
          resolution: args.resolution,
        });
        if (task.merge?.state === 'fixing' && task.merge.fix)
          return `fixing mergeId=${task.merge.id}. End this turn so your session restarts in the merge-fix worktree. There run git merge ${task.merge.fix.base}, resolve only mechanical conflicts, commit, then call merge_task with resolution describing what and where you fixed. For a behavioral conflict, send the card back with update_task and a reason.`;
        const state = task.merge?.state ?? 'merged';
        const mergeId = `${state} mergeId=${task.merge?.id ?? ''}`;
        if (state === 'queued' || state === 'running')
          return `${mergeId}. The server runs the merge and its full check. Do not wait for it: end your turn now. Your session closes, and a failure or a block wakes you with a team message.`;
        return mergeId;
      },
    }),
    defineTool({
      name: 'prioritize_merge',
      title: 'Move a merge to the front of the queue',
      readOnly: false,
      description:
        "Only the card's merger, or the Operator during an open owner request. One merge runs at a time per repository, in the order the cards were requested; use this to decide that this card's queued merge goes next, e.g. a fix that the queued cards' tests depend on. Only a merge that waits in the queue can move (not one that is not started yet or already runs). The merge that runs now is not interrupted. The reason goes on the card's timeline: say who or what it unblocks. A merge already at the front is left as it is (moved: false).",
      input: {
        task_key: TaskKey,
        reason: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .describe('Why this card goes first; it is shown on the timeline.'),
      },
      async run({ ctx, args, handler }) {
        const { moved } = await handler.prioritizeMerge(ctx, {
          taskKey: args.task_key,
          reason: args.reason,
        });
        return moved
          ? `moved: ${args.task_key} merges next, after the one that runs now.`
          : `not moved: ${args.task_key} is first in the queue already.`;
      },
    }),
  ],
};
