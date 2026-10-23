import { SYSTEM_FEEDBACK_TEXT_MAX, SYSTEM_FEEDBACK_TITLE_MAX } from '@projectman/shared';
import { z } from 'zod';
import { defineTool, type TeamToolGroup } from '../kit';

export const SYSTEM_FEEDBACK_TOOL_GROUP: TeamToolGroup = {
  module: 'services/feedback/system',
  tools: [
    defineTool({
      name: 'list_system_feedback',
      audience: { roles: ['operator', 'project_manager'] },
      title: 'List the recorded system feedback',
      readOnly: true,
      description:
        "Only the Operator or the selected PM in its internal coordination session, never an approval continuation; needs no open owner request. The gaps in projectman itself that this project's team " +
        'recorded earlier, in any state, the latest 50: id, state (new, forwarded, dismissed), title, how many times ' +
        'it occurred and when it was last seen. Look here before record_system_feedback, so the same gap is not ' +
        'recorded twice.',
      input: {},
      async run({ ctx, handler }) {
        return JSON.stringify(await handler.listSystemFeedback(ctx));
      },
    }),
    defineTool({
      name: 'record_system_feedback',
      audience: { roles: ['operator', 'project_manager'] },
      title: 'Record a gap in projectman',
      readOnly: false,
      description:
        'Only the Operator or the selected PM in its internal coordination session, never an approval continuation; needs no open owner request. Record ONE gap in projectman itself (a missing tool, a ' +
        'refusal that made no sense, a flow that could not do what the owner asked) that you had to work around. ' +
        'The owner decides what happens to it. Write it in English, without secrets, passwords, tokens, file ' +
        'paths, e-mail addresses or the names of people, projects or clients: describe the gap in general terms ' +
        '(what is covered is replaced by a marker, and the owner reads the text before anything leaves the ' +
        'installation). If list_system_feedback shows the same gap, pass its id as same_as instead: it only adds ' +
        'an occurrence and the other fields are ignored. At most 10 new items per project in 24 hours.',
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
          .describe('The id (fb_…) of an item of this project that this is another occurrence of.'),
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
