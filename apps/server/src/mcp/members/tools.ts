import { z } from 'zod';
import { formatMembers } from '../format';

import { defineTool, type TeamToolGroup } from '../kit';

const MAX_MEMORY_CHARS = 2_000;

export const MEMBER_TOOL_GROUP: TeamToolGroup = {
  module: 'core/members',
  tools: [
    defineTool({
      name: 'list_members',
      title: 'List team members',
      readOnly: true,
      description:
        'List the team: handle, name, human or AI, role, status and current tasks. Use it to find the right ' +
        'teammate to address (by handle) and to see who is busy with what.',
      input: {},
      // The integrator is no member: nobody is marked "(you)".
      external: {
        access: 'read',
        async run({ ctx, handler }) {
          return formatMembers(await handler.listMembers(ctx), '');
        },
      },
      async run({ ctx, handler }) {
        return formatMembers(await handler.listMembers(ctx), ctx.member);
      },
    }),
    defineTool({
      name: 'save_memory',
      title: 'Save to memory',
      readOnly: false,
      description:
        'Save a durable learning to your own memory; it is included in all your future sessions. Use it for ' +
        'lasting knowledge about the project, codebase, conventions, pitfalls, where things are or people, ' +
        'not for task progress or temporary state (record those with update_task).',
      input: {
        note: z
          .string()
          .trim()
          .min(1)
          .max(MAX_MEMORY_CHARS)
          .describe('The learning: one or two self-contained sentences.'),
      },
      async run({ ctx, args, handler }) {
        await handler.saveMemory(ctx, { note: args.note });
        return 'Saved to your memory.';
      },
    }),
  ],
};
