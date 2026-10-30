import type { HistorySearchResult, HistorySourceRead, HistoryViewer } from '@projectman/shared';
import { TeamToolError } from '../../contracts';
import type {
  HistoryService,
  HistorySourceReadArgs,
  HistoryToolsHandler,
  ToolContext,
} from '../../contracts';
import { DomainError } from '../../kernel';
import type { ToolCaller } from '../caller';

/** A refusal of the history tools in words the agent reads: the error code first (`code: message`). */
function historyToolError(err: unknown): unknown {
  if (err instanceof DomainError)
    return new TeamToolError(
      err.status === 403 ? 'forbidden' : err.status === 404 ? 'not_found' : 'invalid',
      `${err.code}: ${err.message}`,
    );
  return err;
}

export class HistoryTools implements HistoryToolsHandler {
  private readonly calls: ToolCaller;
  private readonly history: Pick<HistoryService, 'search' | 'read'>;

  constructor(deps: { calls: ToolCaller; history: Pick<HistoryService, 'search' | 'read'> }) {
    this.calls = deps.calls;
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
}
