import { z } from 'zod';
import { formatLinkedPullRequest } from '../format';
import { defineTool, type TeamToolGroup, taskKeyInput } from '../kit';

export const GITHUB_TOOL_GROUP: TeamToolGroup = {
  module: 'services/github',
  tools: [
    defineTool({
      name: 'link_pull_request',
      title: 'Link a pull request',
      readOnly: false,
      description:
        'Attach a GitHub pull request to a task, so its checks, reviews and merge are tracked on the task. ' +
        'Call it right after opening the pull request.',
      input: {
        task_key: taskKeyInput,
        repo: z
          .string()
          .regex(/^[\w.-]+\/[\w.-]+$/, 'expected "owner/name"')
          .describe('GitHub repository as "owner/name".'),
        number: z.number().int().positive().describe('Pull request number.'),
      },
      async run({ ctx, args, handler }) {
        const { task } = await handler.linkPullRequest(ctx, {
          taskKey: args.task_key,
          repo: args.repo,
          number: args.number,
        });
        return formatLinkedPullRequest(task, args.repo, args.number);
      },
    }),
  ],
};
