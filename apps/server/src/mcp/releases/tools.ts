import { z } from 'zod';
import type { AppBuildResult, PublishedRelease, PublishReleaseArgs, ReleaseStatus } from '../../contracts';
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
      external: {
        access: 'read',
        modes: ['super', 'read'],
        async run({ ctx, handler }) {
          const status = await handler.getReleaseStatus(ctx);
          return { structured: { status }, text: formatStatus(status) };
        },
      },
      async run({ ctx, handler }) {
        return formatStatus(await handler.getReleaseStatus(ctx));
      },
    }),
    defineTool({
      name: 'publish_release',
      audience: { duties: ['deployment'] },
      title: 'Publish a repository release',
      readOnly: false,
      description:
        'Tag a merged commit, create its public GitHub release (`summary`: cards since the last one) and start ' +
        'its engine app build. `preview: true` is open to the deployment duty; publishing is only the owner’s ' +
        'or their connected Claude’s (release_owner_only). After release_publish_failed, call it again.',
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
      external: {
        access: 'write',
        modes: ['super'],
        hostOnly: true,
        async run({ ctx, args, handler }) {
          const result = await handler.publishRelease(ctx, publishArgs(args));
          return { structured: { release: result }, text: formatPublished(result) };
        },
      },
      async run({ ctx, args, handler }) {
        return formatPublished(await handler.publishRelease(ctx, publishArgs(args)));
      },
    }),
  ],
};

function publishArgs(args: {
  summary: string;
  repo?: string | undefined;
  commit?: string | undefined;
  tag?: string | undefined;
  preview?: boolean | undefined;
}): PublishReleaseArgs {
  return {
    summary: args.summary,
    ...(args.repo ? { repo: args.repo } : {}),
    ...(args.commit ? { commit: args.commit } : {}),
    ...(args.tag ? { tag: args.tag } : {}),
    preview: args.preview ?? false,
  };
}

function formatPublished(result: PublishedRelease): string {
  const cards = result.tasks.map((task) => `${task.key} ${task.title}`).join('\n');
  const head = `repo=${result.repo} tag=${result.tag} commit=${result.commit} baseCommit=${result.baseCommit ?? 'none'}`;
  if (!result.url) return `preview (nothing recorded)\n${head}\n${cards}`;
  const build = result.appBuild ? `\n${formatAppBuild(result.appBuild)}` : '';
  return `published tag=${result.tag} url=${result.url}\n${head}\n${cards}${build}`;
}

function formatAppBuild(build: AppBuildResult): string {
  switch (build.state) {
    case 'started':
    case 'reused':
      return `engine app build ${build.state}: job=${build.job} run=${build.runId}${build.url ? ` url=${build.url}` : ''}`;
    case 'failed':
      return `engine app build failed (the release stays published): job=${build.job} ${build.code}: ${build.message}. Run it by hand with run_compute_job.`;
    case 'not_configured':
      return 'engine app build not started: the repository registers no engine-release job (docs/DEPLOY.md, one-time setup step 2).';
  }
}

function formatStatus(status: ReleaseStatus): string {
  const engines = status.engines.map(
    (engine) =>
      `${engine.id} ${engine.name} connected=${engine.connected} version=${engine.version ?? 'unknown'} ` +
      `versionMismatch=${engine.versionMismatch} lastSeenAt=${engine.lastSeenAt ?? 'never'}`,
  );
  return [`hub version=${status.hub.version}`, ...engines].join('\n');
}
