import { z } from 'zod';
import { formatReleaseCheck } from '../format';
import { defineTool, type TeamToolGroup } from '../kit';

export const RELEASE_TOOL_GROUP: TeamToolGroup = {
  module: 'services/releases',
  tools: [
    defineTool({
      name: 'propose_release',
      title: 'Propose a release',
      readOnly: false,
      description:
        "Propose releasing this instance's default branch (or the merge commit `commit`) to the owners. Only a member " +
        "with the deployment duty may call it. It makes a release card and an approval request in the owners' " +
        'inbox; nothing is deployed until an owner approves, and the release watcher deploys it. The release has ' +
        'the merged cards between the last release and the commit. Only one release is open at a time. With ' +
        '`preview: true` nothing is recorded: the result lists the commit and the cards, so you can write the ' +
        'summary. Without it your session ends after the call: the owner decides and the watcher continues, so ' +
        'do nothing more afterwards.',
      input: {
        title: z.string().min(1).max(200).describe('The release card title, e.g. "Release 2026.10.11".'),
        summary: z
          .string()
          .min(1)
          .max(4000)
          .describe(
            'English markdown: what the release changes, as short bullets with the card keys. It becomes the text of the GitHub release.',
          ),
        commit: z
          .string()
          .regex(/^[0-9a-f]{40}$/)
          .optional()
          .describe('A merge commit of a merged card; default: the head of the default branch.'),
        preview: z
          .boolean()
          .optional()
          .describe('Only list the commit and the cards of the release; record nothing (default false).'),
      },
      async run({ ctx, args, handler }) {
        const result = await handler.proposeRelease(ctx, {
          title: args.title,
          summary: args.summary,
          commit: args.commit,
          preview: args.preview ?? false,
        });
        const cards = result.tasks.map((task) => `${task.key} ${task.title}`).join('\n');
        const head = `commit=${result.commit} baseCommit=${result.baseCommit ?? 'none'}\n${cards}`;
        if (!result.releaseId) return `preview (nothing recorded)\n${head}`;
        return `releaseId=${result.releaseId} taskKey=${result.taskKey}\n${head}\nThe owners were asked. End your turn: your session ends now.`;
      },
    }),
    defineTool({
      name: 'check_release',
      title: 'Check a release',
      readOnly: true,
      description:
        'Only the Operator; it only reads. The preview of propose_release: it runs the same checks (a release already ' +
        'in progress, the merged cards between the last release and the commit) and answers either the commit and ' +
        'the cards a release would have, or the refusal propose_release would give now, with the same code and ' +
        'message. It records nothing. The release is proposed by the member with the deployment duty, not by the ' +
        'Operator: the result lists who that is. `commit` is a merge commit of a merged card; default: the head of ' +
        'the default branch. Explain the result to the owner in the project language.',
      input: {
        commit: z
          .string()
          .regex(/^[0-9a-f]{40}$/)
          .optional()
          .describe('A merge commit of a merged card; default: the head of the default branch.'),
      },
      async run({ ctx, args, handler }) {
        return formatReleaseCheck(
          await handler.checkRelease(ctx, args.commit ? { commit: args.commit } : {}),
        );
      },
    }),
  ],
};
