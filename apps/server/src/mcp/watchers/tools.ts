import { z } from 'zod';
import { defineTool, type TeamToolGroup, taskKeyInput } from '../kit';

export const WATCHER_TOOL_GROUP: TeamToolGroup = {
  module: 'runtime/watchers',
  tools: [
    defineTool({
      name: 'decide_fix_limit',
      title: 'Decide how a card at its fix round limit goes on',
      readOnly: false,
      description:
        'Decide how a card at its fix round limit goes on, as the system message that named you describes: continue, replan or to_owner (which requires an assessment).',
      input: {
        task_key: taskKeyInput,
        decision: z.enum(['continue', 'replan', 'to_owner']),
        reason: z.string().trim().min(1).max(2000),
        assessment: z
          .object({
            recurrence: z.string(),
            current_state: z.string(),
            recommendation: z.object({ option_id: z.string(), reason: z.string() }),
          })
          .optional(),
      },
      async run({ ctx, args, handler }) {
        const assessment = args.assessment;
        return JSON.stringify(
          await handler.decideFixLimit(ctx, {
            taskKey: args.task_key,
            decision: args.decision,
            reason: args.reason,
            ...(assessment
              ? {
                  assessment: {
                    recurrence: assessment.recurrence,
                    currentState: assessment.current_state,
                    recommendation: {
                      optionId: assessment.recommendation.option_id,
                      reason: assessment.recommendation.reason,
                    },
                  },
                }
              : {}),
          }),
        );
      },
    }),
  ],
};
