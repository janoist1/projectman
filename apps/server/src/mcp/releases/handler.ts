import { isOperator, memberOf } from '@projectman/shared';
import { TeamToolError } from '../../contracts';
import type {
  ToolContext,
  ReleaseToolsHandler,
  ProposedRelease,
  PublishedRelease,
  PublishReleaseArgs,
  ReleaseCheckResult,
} from '../../contracts';
import { DomainError } from '../../kernel';
import type { ReleasePublishService, ReleaseService } from '../../services/releases';
import type { ToolCaller } from '../caller';

export class ReleaseTools implements ReleaseToolsHandler {
  private readonly calls: ToolCaller;
  private readonly releases: Pick<ReleaseService, 'preview' | 'propose' | 'check'>;
  private readonly publications: Pick<ReleasePublishService, 'preview' | 'publish'>;

  constructor(deps: {
    calls: ToolCaller;
    releases: Pick<ReleaseService, 'preview' | 'propose' | 'check'>;
    publications: Pick<ReleasePublishService, 'preview' | 'publish'>;
  }) {
    this.calls = deps.calls;
    this.releases = deps.releases;
    this.publications = deps.publications;
  }

  async publishRelease(ctx: ToolContext, args: PublishReleaseArgs): Promise<PublishedRelease> {
    return this.calls.guard(async () => {
      await this.calls.caller(ctx, 'publish_release');
      const input = { summary: args.summary, repo: args.repo, commit: args.commit, tag: args.tag };
      try {
        return args.preview
          ? await this.publications.preview(ctx.projectKey, ctx.member, input)
          : await this.publications.publish(ctx.projectKey, ctx.member, input);
      } catch (err) {
        // The agent reads the code: it says what to do (the tag is taken, publish again to finish).
        if (err instanceof DomainError && (err.code.startsWith('release_') || err.code === 'engine_offline'))
          throw new TeamToolError(
            err.status === 403 ? 'forbidden' : 'invalid',
            `${err.code}: ${err.message}`,
          );
        throw err;
      }
    });
  }

  async proposeRelease(
    ctx: ToolContext,
    args: { title: string; summary: string; commit?: string; preview?: boolean },
  ): Promise<ProposedRelease> {
    return this.calls.guard(async () => {
      await this.calls.caller(ctx, 'propose_release');
      try {
        if (args.preview) {
          const candidate = await this.releases.preview(ctx.projectKey, ctx.member, args.commit);
          return { commit: candidate.commit, baseCommit: candidate.baseCommit, tasks: candidate.tasks };
        }
        const { release, candidate } = await this.releases.propose(ctx.projectKey, ctx.member, {
          title: args.title,
          summary: args.summary,
          commit: args.commit,
        });
        return {
          releaseId: release.id,
          taskKey: release.taskKey,
          commit: release.commit,
          baseCommit: release.baseCommit,
          tasks: candidate.tasks,
        };
      } catch (err) {
        // The agent reads the code: it says what to do (wait for the open release, nothing to release).
        if (err instanceof DomainError && err.code.startsWith('release_'))
          throw new TeamToolError(
            err.status === 403 ? 'forbidden' : 'invalid',
            `${err.code}: ${err.message}`,
          );
        throw err;
      }
    });
  }

  async checkRelease(ctx: ToolContext, args: { commit?: string }): Promise<ReleaseCheckResult> {
    return this.calls.guard(async () => {
      const config = await this.calls.caller(ctx, 'check_release');
      const member = memberOf(config, ctx.member);
      if (!member || !isOperator(member))
        throw new TeamToolError('forbidden', 'operator_only: only the Operator may check a release.');
      return this.releases.check(ctx.projectKey, args.commit);
    });
  }
}
