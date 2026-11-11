import { TeamToolError } from '../../contracts';
import type {
  ToolContext,
  ReleaseToolsHandler,
  PublishedRelease,
  PublishReleaseArgs,
  ReleaseStatus,
} from '../../contracts';
import { DomainError } from '../../kernel';
import type { ReleasePublishService } from '../../services/releases';
import type { ToolCaller } from '../caller';

/** The agent reads the code: it says what to do (the tag is taken, publish again to finish, the owner steps in). */
export function asReleaseToolError(err: unknown): unknown {
  if (err instanceof DomainError && (err.code.startsWith('release_') || err.code === 'engine_offline'))
    return new TeamToolError(err.status === 403 ? 'forbidden' : 'invalid', `${err.code}: ${err.message}`);
  return err;
}

export class ReleaseTools implements ReleaseToolsHandler {
  private readonly calls: ToolCaller;
  private readonly publications: Pick<ReleasePublishService, 'preview' | 'publish'>;
  private readonly status: () => ReleaseStatus;

  constructor(deps: {
    calls: ToolCaller;
    publications: Pick<ReleasePublishService, 'preview' | 'publish'>;
    /** The hub's version and the engines' view of it (PM-1201); reads only. */
    status: () => ReleaseStatus;
  }) {
    this.calls = deps.calls;
    this.publications = deps.publications;
    this.status = deps.status;
  }

  async publishRelease(ctx: ToolContext, args: PublishReleaseArgs): Promise<PublishedRelease> {
    return this.calls.guard(async () => {
      await this.calls.caller(ctx, 'publish_release');
      const input = { summary: args.summary, repo: args.repo, commit: args.commit, tag: args.tag };
      const actor = { kind: 'ai', handle: ctx.member } as const;
      try {
        return args.preview
          ? await this.publications.preview(ctx.projectKey, actor, input)
          : await this.publications.publish(ctx.projectKey, actor, input);
      } catch (err) {
        throw asReleaseToolError(err);
      }
    });
  }

  async getReleaseStatus(ctx: ToolContext): Promise<ReleaseStatus> {
    return this.calls.guard(async () => {
      await this.calls.caller(ctx, 'get_release_status');
      return this.status();
    });
  }
}
