import { WORK_DOING_DETAIL_MAX, WORK_DOING_SUMMARY_MAX, WorkDoing } from '@projectman/shared';
import { z } from 'zod';
import { GUIDE_TOPICS } from '../../contracts';
import { formatCurrentWork } from '../format';
import { defineTool, type TeamToolGroup } from '../kit';

export const SESSION_TOOL_GROUP: TeamToolGroup = {
  module: 'runtime/sessions',
  tools: [
    defineTool({
      name: 'get_guide',
      title: 'Read a guide topic',
      readOnly: true,
      description:
        'Read the full guide topic indexed in your prompt. Use only when the short index is not enough.',
      input: { topic: z.enum(GUIDE_TOPICS) },
      async run({ ctx, args, handler }) {
        return handler.getGuide(ctx, args);
      },
    }),
    defineTool({
      name: 'set_current_work',
      title: 'Say what you are doing',
      readOnly: false,
      description:
        "Say what you are doing on your task's card now; the card shows it next to your name. Call it at the " +
        'start of a multi-step stretch, in the same response as your next step; not at every step or for a ' +
        'short reply. Only the latest is kept, until your round ends.',
      input: {
        summary: WorkDoing.shape.summary.describe(
          `One declarative line in the project language, without your name, at most ${WORK_DOING_SUMMARY_MAX} ` +
            'characters, e.g. "The gateway tests are being written".',
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
