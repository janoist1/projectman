import { WORK_DOING_DETAIL_MAX, WORK_DOING_SUMMARY_MAX, WorkDoing } from '@projectman/shared';
import { formatCurrentWork } from '../format';
import { defineTool, type TeamToolGroup } from '../kit';

export const SESSION_TOOL_GROUP: TeamToolGroup = {
  module: 'runtime/sessions',
  tools: [
    defineTool({
      name: 'set_current_work',
      title: 'Say what you are doing',
      readOnly: false,
      description:
        "Say, in one declarative sentence, what you are doing on your task's card now; the card shows it next " +
        'to your name, e.g. "The gateway tests are being written". It always concerns your own session ' +
        'and card. Call it at the start of a multi-step stretch of work (implementing, testing, fixing review ' +
        'findings), not at every step and not for a short reply, and in the same response as your next ' +
        'step, never on its own. Only the latest sentence is kept, and it disappears when your round ends. ' +
        'Write it in the project language, without your name.',
      input: {
        summary: WorkDoing.shape.summary.describe(
          `One line, at most ${WORK_DOING_SUMMARY_MAX} characters, the card shows it.`,
        ),
        detail: WorkDoing.shape.detail.describe(
          `More about it, at most ${WORK_DOING_DETAIL_MAX} characters; only the task page shows it.`,
        ),
      },
      async run({ ctx, args, handler }) {
        const { recorded } = await handler.setCurrentWork(ctx, {
          summary: args.summary,
          detail: args.detail,
        });
        return formatCurrentWork(recorded);
      },
    }),
  ],
};
