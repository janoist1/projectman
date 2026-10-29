import { SYSTEM_FEEDBACK_TEXT_MAX, SYSTEM_FEEDBACK_TITLE_MAX } from '@projectman/shared';
import { z } from 'zod';
import { defineTool, type TeamToolGroup } from '../kit';

export const SYSTEM_FEEDBACK_TOOL_GROUP: TeamToolGroup = {
  module: 'services/feedback/system',
  tools: [
    defineTool({
      name: 'list_system_feedback',
      audience: { roles: ['project_manager'] },
      title: 'List the recorded system feedback',
      readOnly: true,
      description:
        "The gaps in projectman itself that this project's team recorded, the latest 50 in any state (id, " +
        'state, title, occurrences, last seen). Look here before record_system_feedback so a gap is not ' +
        'recorded twice. Your internal coordination session only, never an approval continuation.',
      input: {},
      async run({ ctx, handler }) {
        return JSON.stringify(await handler.listSystemFeedback(ctx));
      },
    }),
    defineTool({
      name: 'record_system_feedback',
      audience: { roles: ['project_manager'] },
      title: 'Record a gap in projectman',
      readOnly: false,
      description:
        'Record ONE gap in projectman itself you had to work around (a missing tool, a senseless refusal, a ' +
        'flow that could not do what was asked); the owner decides on it. English, general terms: no secrets, ' +
        'paths, e-mail addresses or names of people, projects or clients. At most 10 new per project a day.',
      input: {
        title: z
          .string()
          .trim()
          .min(1)
          .max(SYSTEM_FEEDBACK_TITLE_MAX)
          .describe('A short title naming the gap, not the symptom.'),
        what: z
          .string()
          .trim()
          .min(1)
          .max(SYSTEM_FEEDBACK_TEXT_MAX)
          .describe('What happened and what projectman could not do.'),
        workaround: z
          .string()
          .trim()
          .min(1)
          .max(SYSTEM_FEEDBACK_TEXT_MAX)
          .describe('How you worked around it.'),
        fix: z
          .string()
          .trim()
          .min(1)
          .max(SYSTEM_FEEDBACK_TEXT_MAX)
          .describe('What change in projectman would remove the need for the workaround.'),
        same_as: z
          .string()
          .trim()
          .min(1)
          .max(64)
          .optional()
          .describe(
            'The id (fb_…) of the same gap in list_system_feedback: it only adds an occurrence, the other ' +
              'fields are ignored.',
          ),
      },
      async run({ ctx, args, handler }) {
        const result = await handler.recordSystemFeedback(ctx, {
          title: args.title,
          what: args.what,
          workaround: args.workaround,
          fix: args.fix,
          ...(args.same_as ? { sameAs: args.same_as } : {}),
        });
        return result.created
          ? `recorded ${result.id} (${result.state})`
          : `occurrence ${result.occurrences} added to ${result.id}`;
      },
    }),
  ],
};
