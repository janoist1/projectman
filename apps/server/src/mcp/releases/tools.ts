import { z } from 'zod';
import { defineTool, type TeamToolGroup } from '../kit';

export const RELEASE_TOOL_GROUP: TeamToolGroup = {
  module: 'services/releases',
  tools: [
    defineTool({
      name: 'get_release_status',
      audience: { duties: ['deployment'] },
      title: 'Read the version of the hub and the engines',
      readOnly: true,
      description:
        'Which version the hub runs and, per engine, whether it is connected, which version it reports, ' +
        'whether that differs from the hub and when it was last seen. Reads only. Use it in a release to check ' +
        'that the hub is on the new version and that every engine has followed.',
      input: {},
      async run({ ctx, handler }) {
        const status = await handler.getReleaseStatus(ctx);
        const engines = status.engines.map(
          (engine) =>
            `${engine.id} ${engine.name} connected=${engine.connected} version=${engine.version ?? 'unknown'} ` +
            `versionMismatch=${engine.versionMismatch} lastSeenAt=${engine.lastSeenAt ?? 'never'}`,
        );
        return [`hub version=${status.hub.version}`, ...engines].join('\n');
      },
    }),
    defineTool({
      name: 'publish_release',
      audience: { duties: ['deployment'] },
      title: 'Publish a repository release',
      readOnly: false,
      description:
        'Tag a merged commit and create its public GitHub release (your `summary` and the cards merged since ' +
        'the previous release). Deploys nothing, needs no approval, cannot be taken back quietly: only when ' +
        'someone asked for a release, first with `preview: true`. After release_publish_failed, call it again.',
      input: {
        summary: z
          .string()
          .min(1)
          .max(4000)
          .describe(
            'English markdown: what the release changes, as short bullets with the card keys. It starts the text of the GitHub release; the card list is added.',
          ),
        repo: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe(
            'The repository name in the project; default: the only repository (required with several).',
          ),
        commit: z
          .string()
          .regex(/^[0-9a-f]{40}$/)
          .optional()
          .describe('A merge commit of a merged card; default: the head of the default branch.'),
        tag: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
          .optional()
          .describe(
            'The tag name; default: vYYYY.M.D of today, with .2, .3 … when the day has more releases.',
          ),
        preview: z
          .boolean()
          .optional()
          .describe(
            'Only show the tag, the commit and the cards, to write the summary; record and send nothing (default false).',
          ),
      },
      async run({ ctx, args, handler }) {
        const result = await handler.publishRelease(ctx, {
          summary: args.summary,
          ...(args.repo ? { repo: args.repo } : {}),
          ...(args.commit ? { commit: args.commit } : {}),
          ...(args.tag ? { tag: args.tag } : {}),
          preview: args.preview ?? false,
        });
        const cards = result.tasks.map((task) => `${task.key} ${task.title}`).join('\n');
        const head = `repo=${result.repo} tag=${result.tag} commit=${result.commit} baseCommit=${result.baseCommit ?? 'none'}`;
        if (!result.url) return `preview (nothing recorded)\n${head}\n${cards}`;
        return `published tag=${result.tag} url=${result.url}\n${head}\n${cards}`;
      },
    }),
  ],
};
