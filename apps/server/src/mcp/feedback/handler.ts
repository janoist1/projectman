import { canProcessFeedback, LOCAL_ENGINE_ID, memberOf } from '@projectman/shared';
import type { Actor, FeedbackMarkDetail, ProjectConfig } from '@projectman/shared';
import { TeamToolError } from '../../contracts';
import type {
  FeedbackToolsHandler,
  FeedbackToolList,
  FeedbackToolMark,
  FeedbackToolResult,
  ToolContext,
} from '../../contracts';
import type { DomainContext } from '../../core/base';
import { engineIdOf } from '../../runtime/sessions';
import { DomainError } from '../../kernel';
import type { ProjectService } from '../../core/projects';
import { aiActor } from '../../kernel';
import type { FeedbackService } from '../../services/feedback';
import { toToolError, type ToolCaller } from '../caller';

/** The refusals of the feedback tools in words the agent reads: the mark's error code first (`code: message`). */
function feedbackToolError(err: unknown): unknown {
  if (err instanceof TeamToolError || !(err instanceof DomainError)) return toToolError(err);
  if (err.code === 'feedback_mark_not_found')
    return new TeamToolError('not_found', `${err.code}: ${err.message}`);
  if (err.code.startsWith('feedback_'))
    return new TeamToolError(err.status === 403 ? 'forbidden' : 'invalid', `${err.code}: ${err.message}`);
  return toToolError(err);
}

/** The access of a team member as a processor sees it next to their mark: a person's access, or `ai`. */
function feedbackAccessOf(config: ProjectConfig, handle: string): string | null {
  const member = memberOf(config, handle);
  if (!member) return null;
  return member.kind === 'human' ? member.access : 'ai';
}

/** The state of a mark after a step, as the feedback tools answer. */
function feedbackResult(mark: Pick<FeedbackMarkDetail, 'id' | 'status' | 'outcome'>): FeedbackToolResult {
  return { markId: mark.id, status: mark.status, outcome: mark.outcome };
}

/** What the feedback tools use of the feedback service. */
type FeedbackOperations = Pick<
  FeedbackService,
  | 'listForProcessor'
  | 'detailForProcessor'
  | 'screenshotPath'
  | 'comment'
  | 'createTask'
  | 'link'
  | 'forward'
  | 'close'
>;

export class FeedbackTools implements FeedbackToolsHandler {
  private readonly calls: ToolCaller;
  private readonly ctx: DomainContext;
  private readonly projects: Pick<ProjectService, 'config'>;
  private readonly feedback: FeedbackOperations;

  constructor(deps: {
    calls: ToolCaller;
    ctx: DomainContext;
    projects: Pick<ProjectService, 'config'>;
    feedback: FeedbackOperations;
  }) {
    this.calls = deps.calls;
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.feedback = deps.feedback;
  }

  async getFeedbackList(
    ctx: ToolContext,
    args: { status: 'todo' | 'open' | 'all'; limit: number },
  ): Promise<FeedbackToolList> {
    return this.feedbackStep(ctx, async (actor, config) => {
      const { marks, total } = await this.feedback.listForProcessor(ctx.projectKey, actor, args);
      const authorAccess: Record<string, string> = {};
      for (const { author } of marks) {
        const access = feedbackAccessOf(config, author.handle);
        if (access) authorAccess[author.handle] = access;
      }
      return { status: args.status, total, marks, authorAccess };
    });
  }

  async getFeedbackMark(ctx: ToolContext, args: { markId: string }): Promise<FeedbackToolMark> {
    return this.feedbackStep(ctx, async (actor, config) => {
      const mark = await this.feedback.detailForProcessor(ctx.projectKey, args.markId, actor);
      const authorAccess = feedbackAccessOf(config, mark.author.handle);
      if (!mark.screenshot) return { mark, authorAccess, screenshot: { kind: 'none' } as const };
      // The stored file is on the server's machine: only a session that runs there can open it.
      const session = this.ctx.repos.sessions.get(ctx.sessionId);
      if (!session || engineIdOf(session) !== LOCAL_ENGINE_ID)
        return { mark, authorAccess, screenshot: { kind: 'remote' } as const };
      const path = await this.feedback.screenshotPath(ctx.projectKey, args.markId, actor);
      return {
        mark,
        authorAccess,
        screenshot: path ? ({ kind: 'local', path } as const) : ({ kind: 'none' } as const),
      };
    });
  }

  async replyFeedback(ctx: ToolContext, args: { markId: string; body: string }): Promise<FeedbackToolResult> {
    return this.feedbackStep(ctx, async (actor) =>
      feedbackResult(await this.feedback.comment(ctx.projectKey, args.markId, actor, args.body)),
    );
  }

  async createTaskFromFeedback(
    ctx: ToolContext,
    args: { markId: string; title: string; description: string; reply?: string },
  ): Promise<FeedbackToolResult> {
    return this.feedbackStep(ctx, async (actor) => {
      const created = await this.feedback.createTask(ctx.projectKey, args.markId, actor, {
        title: args.title,
        description: args.description,
        ...(args.reply ? { reply: args.reply } : {}),
      });
      return { ...feedbackResult(created.mark), task: created.task };
    });
  }

  async linkFeedback(
    ctx: ToolContext,
    args: { markId: string; taskKey: string; reply?: string },
  ): Promise<FeedbackToolResult> {
    return this.feedbackStep(ctx, async (actor) =>
      feedbackResult(
        await this.feedback.link(ctx.projectKey, args.markId, actor, {
          taskKey: this.calls.validTaskKey(ctx, args.taskKey),
          ...(args.reply ? { reply: args.reply } : {}),
        }),
      ),
    );
  }

  async forwardFeedback(
    ctx: ToolContext,
    args: { markId: string; reason: string; reply: string },
  ): Promise<FeedbackToolResult> {
    return this.feedbackStep(ctx, async (actor) =>
      feedbackResult(
        await this.feedback.forward(ctx.projectKey, args.markId, actor, {
          reason: args.reason,
          reply: args.reply,
        }),
      ),
    );
  }

  async closeFeedback(
    ctx: ToolContext,
    args: { markId: string; reply?: string },
  ): Promise<FeedbackToolResult> {
    return this.feedbackStep(ctx, async (actor) =>
      feedbackResult(await this.feedback.close(ctx.projectKey, args.markId, actor, args.reply)),
    );
  }

  /**
   * A feedback tool: only an AI member that processes feedback calls it (the Operator and the other roles
   * get `feedback_processor_only`), and the refusals of the mark's rules come with their code in the message.
   */
  private async feedbackStep<T>(
    ctx: ToolContext,
    run: (actor: Actor, config: ProjectConfig) => Promise<T>,
  ): Promise<T> {
    try {
      const config = await this.projects.config(ctx.projectKey);
      const member = memberOf(config, ctx.member);
      if (member?.kind !== 'ai')
        throw new TeamToolError(
          'forbidden',
          `${ctx.member} is not an active AI member of this team, so the team tools are not available.`,
        );
      if (!canProcessFeedback(config, member))
        throw new TeamToolError(
          'forbidden',
          'feedback_processor_only: only a member with the feedback processing duty may use the feedback tools.',
        );
      return await run(aiActor(ctx.member), config);
    } catch (err) {
      throw feedbackToolError(err);
    }
  }
}
