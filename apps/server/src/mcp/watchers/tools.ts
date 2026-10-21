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
        'A system message told you that a card reached the limit of fix rounds and its implementer is held back: read the card and its timeline first, then decide. "continue" lets it have one more round (when you were asked for a more exact plan: the card starts a new count with your plan); "replan" (the lead only) asks another technical direction holder for a more exact plan first; "to_owner" gives the decision to the people (the integrator first, when one is available) and REQUIRES an assessment: recurrence (one sentence: does the same fault come back), current_state (where the work stands now) and recommendation (option_id replan, reassign or another_round, an outcome that can be carried out, and its reason). Without it the call is refused and nothing changes. The lead may give at most three extra rounds ("continue") within one count; after that the people decide at every limit. The reason is required (one or two sentences, no secrets): it is shown to the people and told to the implementer. Only the member the message named may decide, and only while the card is held.',
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
