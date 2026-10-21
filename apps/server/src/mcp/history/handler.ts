import { canSeeHistorySearchStats, isOperator, memberOf } from '@projectman/shared';
import type {
  HistorySearchResult,
  HistorySearchStats,
  HistorySourceRead,
  HistoryStatsInput,
  HistoryViewer,
  InboxItem,
  TeamMessage,
} from '@projectman/shared';
import { TeamToolError } from '../../contracts';
import type {
  HistoryService,
  HistorySourceReadArgs,
  HistoryToolsHandler,
  ToolContext,
} from '../../contracts';
import type { DomainContext } from '../../core/base';
import type { ProjectService } from '../../core/projects';
import { DomainError } from '../../kernel';
import type { CallerWithRequest, ToolCaller } from '../caller';

const STATS_FORBIDDEN = 'history_stats_forbidden';

/** A refusal of the history tools in words the agent reads: the error code first (`code: message`). */
function historyToolError(err: unknown): unknown {
  if (err instanceof DomainError)
    return new TeamToolError(
      err.status === 403 ? 'forbidden' : err.status === 404 ? 'not_found' : 'invalid',
      `${err.code}: ${err.message}`,
    );
  return err;
}

const statsForbidden = (why: string) => new TeamToolError('forbidden', `${STATS_FORBIDDEN}: ${why}`);

export class HistoryTools implements HistoryToolsHandler {
  private readonly calls: ToolCaller;
  private readonly ctx: Pick<DomainContext, 'repos'>;
  private readonly projects: Pick<ProjectService, 'config'>;
  private readonly history: Pick<HistoryService, 'search' | 'read' | 'stats'>;

  constructor(deps: {
    calls: ToolCaller;
    ctx: Pick<DomainContext, 'repos'>;
    projects: Pick<ProjectService, 'config'>;
    history: Pick<HistoryService, 'search' | 'read' | 'stats'>;
  }) {
    this.calls = deps.calls;
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.history = deps.history;
  }

  /**
   * Who searches, and in which project. A native AI session is bound to its project and handle: another project
   * is refused, even for the same handle. The Operator in a conversation with someone who is not an owner reads
   * with that person's own view; a person who left the team sees nothing (the facade refuses them).
   */
  private async viewerOf(
    ctx: ToolContext,
    tool: string,
    projectKey: string | undefined,
  ): Promise<{ projectKey: string; viewer: HistoryViewer }> {
    const caller = await this.calls.callerWithRequest(ctx, tool);
    if (projectKey !== undefined && projectKey !== ctx.projectKey)
      throw new TeamToolError(
        'forbidden',
        'insufficient_access: this session works in another project, so only that one can be searched.',
      );
    const viewer: HistoryViewer = caller.guest
      ? { handle: caller.guest.handle, access: caller.guest.viewer.access }
      : { handle: ctx.member, access: 'ai' };
    return { projectKey: ctx.projectKey, viewer };
  }

  async searchHistory(
    ctx: ToolContext,
    args: Parameters<HistoryToolsHandler['searchHistory']>[1],
  ): Promise<HistorySearchResult> {
    const { projectKey: requested, ...input } = args;
    const { projectKey, viewer } = await this.viewerOf(ctx, 'search_history', requested);
    try {
      return await this.history.search(projectKey, viewer, input);
    } catch (err) {
      throw historyToolError(err);
    }
  }

  async readHistorySource(
    ctx: ToolContext,
    args: HistorySourceReadArgs & { projectKey?: string },
  ): Promise<HistorySourceRead> {
    const { projectKey: requested, ...input } = args;
    const { projectKey, viewer } = await this.viewerOf(ctx, 'read_history_source', requested);
    try {
      return this.history.read(projectKey, viewer, input);
    } catch (err) {
      throw historyToolError(err);
    }
  }

  /**
   * The private statistics (PM-787): only the Operator, in the general conversation of a human owner or admin,
   * tied to that person's own open request, whose message or answer is re-read from its original rows. Every
   * other call, a missing or an expired request included, is the same `history_stats_forbidden`.
   */
  async getHistorySearchStats(ctx: ToolContext, args: HistoryStatsInput): Promise<HistorySearchStats> {
    let caller: CallerWithRequest;
    try {
      caller = await this.calls.callerWithRequest(ctx, 'get_history_search_stats');
    } catch (err) {
      if (err instanceof TeamToolError && err.code === 'forbidden')
        throw statsForbidden('this request may not read the search statistics');
      throw err;
    }
    const config = await this.projects.config(ctx.projectKey);
    const viewer = this.statsViewer(ctx, caller, config);
    try {
      return this.history.stats(ctx.projectKey, viewer, args);
    } catch (err) {
      throw historyToolError(err);
    }
  }

  private statsViewer(
    ctx: ToolContext,
    caller: CallerWithRequest,
    config: Awaited<ReturnType<ProjectService['config']>>,
  ): HistoryViewer {
    const refused = () => statsForbidden('this request may not read the search statistics');
    const request = caller.request;
    if (!request || !isOperator(memberOf(config, ctx.member))) throw refused();
    if (
      request.sessionId !== ctx.sessionId ||
      request.projectKey !== ctx.projectKey ||
      (request.source !== 'message' && request.source !== 'answer')
    )
      throw refused();
    // The person's own general conversation with the Operator, not a card or a conversation about someone else.
    const session = this.ctx.repos.sessions.get(ctx.sessionId);
    const workItem = session?.workItem;
    if (
      !session ||
      session.projectKey !== ctx.projectKey ||
      session.member !== ctx.member ||
      workItem?.type !== 'general' ||
      (workItem.with !== undefined && workItem.with !== request.fromHandle) ||
      (caller.guest && caller.guest.handle !== request.fromHandle)
    )
      throw refused();
    const person = memberOf(config, request.fromHandle);
    if (person?.kind !== 'human') throw refused();
    const viewer: HistoryViewer = { handle: person.handle, access: person.access };
    if (!canSeeHistorySearchStats(viewer)) throw refused();
    if (!this.requestIsTheirOwn(ctx, request, config)) throw refused();
    return viewer;
  }

  /**
   * The request must come from the person's own words: re-read from the stored message (and, for an answer, from
   * the question's resolution), never from the request record alone. An integrator relay, a signal, an approval
   * continuation or a generated message is no such origin.
   */
  private requestIsTheirOwn(
    ctx: ToolContext,
    request: NonNullable<CallerWithRequest['request']>,
    config: Parameters<typeof memberOf>[0],
  ): boolean {
    if (!request.messageId) return false;
    const message = this.ctx.repos.messages.get(request.messageId);
    if (
      !message ||
      message.id !== request.messageId ||
      message.projectKey !== ctx.projectKey ||
      message.from !== request.fromHandle ||
      !message.to.includes(ctx.member) ||
      message.via !== undefined ||
      message.actor !== undefined ||
      message.operatorRequest !== undefined ||
      message.operatorSignal !== undefined ||
      message.relayed !== undefined ||
      memberOf(config, message.from)?.kind !== 'human'
    )
      return false;
    if (request.source === 'message') return message.origin === undefined && message.answer === undefined;
    return this.answerIsTheirOwn(ctx, request, message);
  }

  private answerIsTheirOwn(
    ctx: ToolContext,
    request: NonNullable<CallerWithRequest['request']>,
    message: TeamMessage,
  ): boolean {
    if (
      message.origin?.kind !== 'answer' ||
      message.origin.ownerAnswerRelayed !== undefined ||
      !request.inboxItemId ||
      message.origin.inboxItemId !== request.inboxItemId ||
      message.answer?.inboxItemId !== request.inboxItemId
    )
      return false;
    const item: InboxItem | null = this.ctx.repos.inbox.get(request.inboxItemId);
    const resolution = item?.resolution;
    if (
      !item ||
      !resolution ||
      item.projectKey !== ctx.projectKey ||
      item.source !== ctx.member ||
      resolution.by !== request.fromHandle ||
      resolution.via !== undefined ||
      resolution.ownerAnswerRelayed !== undefined ||
      resolution.rule !== undefined
    )
      return false;
    const actor = resolution.actor;
    return actor === undefined || (!actor.via && !actor.operatorMode && !actor.credential);
  }
}
