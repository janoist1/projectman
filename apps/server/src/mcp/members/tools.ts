import { formatMembers } from '../format';

import { defineTool, type TeamToolGroup } from '../kit';

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
      async run({ ctx, handler }) {
        return formatMembers(await handler.listMembers(ctx), ctx.member);
      },
    }),
  ],
};
