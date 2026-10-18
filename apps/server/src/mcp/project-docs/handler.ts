import { ERROR_CODES, isOperator, memberOf } from '@projectman/shared';
import type { ProjectDoc } from '@projectman/shared';
import { TeamToolError } from '../../contracts';
import type { ProjectDocToolsHandler, ProjectDocRead, ProjectDocWrite, ToolContext } from '../../contracts';
import type { DomainContext } from '../../core/base';
import { DomainError } from '../../kernel';
import type { ProjectService } from '../../core/projects';
import type { OperatorSteps } from '../../services/operator';
import { docWindow, type DocWrites, type DecisionCandidates } from '../../services/project-docs';
import {
  refusalOf,
  toToolError,
  isOwner,
  OWNER_ONLY,
  type ToolCaller,
  type CallerWithRequest,
} from '../caller';

/** A refusal of the document tools in words the agent reads: the error code first (`code: message`). */
function docToolError(err: unknown): unknown {
  if (err instanceof TeamToolError) return err;
  if (err instanceof DomainError)
    return new TeamToolError(
      err.status === 403 ? 'forbidden' : 'invalid',
      (ERROR_CODES as readonly string[]).includes(err.code) ? `${err.code}: ${err.message}` : err.message,
    );
  return err;
}

export class ProjectDocTools implements ProjectDocToolsHandler {
  private readonly calls: ToolCaller;
  private readonly ctx: Pick<DomainContext, 'repos'>;
  private readonly projects: Pick<ProjectService, 'config'>;
  private readonly operatorSteps: Pick<OperatorSteps, 'record'>;
  private readonly docWrites: Pick<DocWrites, 'read' | 'request'>;
  private readonly decisionCandidates: Pick<DecisionCandidates, 'list' | 'mark'>;

  constructor(deps: {
    calls: ToolCaller;
    ctx: Pick<DomainContext, 'repos'>;
    projects: Pick<ProjectService, 'config'>;
    operatorSteps: Pick<OperatorSteps, 'record'>;
    docWrites: Pick<DocWrites, 'read' | 'request'>;
    decisionCandidates: Pick<DecisionCandidates, 'list' | 'mark'>;
  }) {
    this.calls = deps.calls;
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.operatorSteps = deps.operatorSteps;
    this.docWrites = deps.docWrites;
    this.decisionCandidates = deps.decisionCandidates;
  }

  async readProjectDoc(
    ctx: ToolContext,
    args: { doc: ProjectDoc; fromLine?: number; lineCount?: number },
  ): Promise<ProjectDocRead> {
    const config = await this.projects.config(ctx.projectKey);
    if (!isOperator(memberOf(config, ctx.member)))
      throw new TeamToolError(
        'forbidden',
        'operator_only: only the Operator may read the project documents.',
      );
    await this.calls.callerWithRequest(ctx, 'read_project_doc');
    try {
      const read = await this.docWrites.read(ctx.projectKey, ctx.member, args.doc);
      return docWindow(args.doc, read, args.fromLine, args.lineCount);
    } catch (err) {
      throw docToolError(err);
    }
  }

  async writeProjectDocs(
    ctx: ToolContext,
    args: {
      baseCommit: string;
      message: string;
      edits: { doc: ProjectDoc; old_text: string; new_text: string }[];
    },
  ): Promise<ProjectDocWrite> {
    const config = await this.projects.config(ctx.projectKey);
    if (!isOperator(memberOf(config, ctx.member)))
      throw new TeamToolError(
        'forbidden',
        'operator_only: only the Operator may write the project documents.',
      );
    const caller = await this.calls.callerWithRequest(ctx, 'write_project_docs');
    const request = this.inOwnerConversation(ctx, caller, 'write_project_docs');
    let outcome: Awaited<ReturnType<DocWrites['request']>>;
    try {
      outcome = await this.docWrites.request({
        projectKey: ctx.projectKey,
        author: ctx.member,
        requestedBy: request.fromHandle,
        requestId: request.id,
        baseCommit: args.baseCommit,
        message: args.message,
        edits: args.edits,
      });
    } catch (err) {
      // A write that was never queued has no step of its own: the refusal is the step.
      this.operatorSteps.record({
        requestId: request.id,
        action: 'docs_write',
        taskKey: null,
        member: null,
        status: 'refused',
        refusal: refusalOf(err),
      });
      throw docToolError(err);
    }
    switch (outcome.state) {
      case 'published':
        return {
          write_id: outcome.id,
          state: 'published',
          commit: outcome.commit,
          paths: outcome.paths,
          ...(outcome.warning
            ? {
                warning:
                  'The default branch is up, but the local checkout could not follow it; tell the owner.',
              }
            : {}),
        };
      case 'queued':
        return { write_id: outcome.id, state: 'queued', waiting_for: outcome.waitingFor };
      case 'running':
        return { write_id: outcome.id, state: 'running' };
      case 'stale':
        throw new TeamToolError(
          'invalid',
          'docs_stale: a file changed since the commit you read. Read it again with read_project_doc and show the owner the new text.',
        );
      case 'failed':
        throw new TeamToolError('invalid', `docs_write_failed: ${outcome.failure}: ${outcome.message}`);
    }
  }

  /**
   * The documents are the owners' business: the request the call runs for, when it is in the owner's own
   * conversation (no `with`, no card); otherwise the call is refused and logged as a refused step.
   */
  private inOwnerConversation(
    ctx: ToolContext,
    caller: CallerWithRequest,
    tool: string,
  ): NonNullable<CallerWithRequest['request']> {
    const request = caller.request!;
    const workItem = this.ctx.repos.sessions.get(ctx.sessionId)?.workItem;
    if (
      workItem?.type !== 'general' ||
      workItem.with !== undefined ||
      !isOwner(caller.config, request.fromHandle)
    ) {
      this.calls.recordRefusedWrite(caller, tool);
      throw new TeamToolError(
        'forbidden',
        `${OWNER_ONLY}: ${tool} is for the owner's own conversation with you.`,
      );
    }
    return request;
  }

  async listDecisionCandidates(ctx: ToolContext, args: { limit?: number }) {
    const config = await this.projects.config(ctx.projectKey);
    if (!isOperator(memberOf(config, ctx.member)))
      throw new TeamToolError(
        'forbidden',
        'operator_only: only the Operator may list the decision candidates.',
      );
    await this.calls.callerWithRequest(ctx, 'list_decision_candidates');
    try {
      return this.decisionCandidates.list(ctx.projectKey, config, args.limit);
    } catch (err) {
      throw docToolError(err);
    }
  }

  async markDecisionCandidates(
    ctx: ToolContext,
    args: { items: { item_id: string; verdict: 'recorded' | 'declined' | 'skipped'; decision?: string }[] },
  ) {
    const config = await this.projects.config(ctx.projectKey);
    if (!isOperator(memberOf(config, ctx.member)))
      throw new TeamToolError(
        'forbidden',
        'operator_only: only the Operator may mark the decision candidates.',
      );
    const caller = await this.calls.callerWithRequest(ctx, 'mark_decision_candidates');
    const request = this.inOwnerConversation(ctx, caller, 'mark_decision_candidates');
    return this.calls
      .recorded<{ marked: number }>(caller, { action: 'decision_offer' }, async () => ({
        marked: this.decisionCandidates.mark(ctx.projectKey, config, request.id, args.items),
      }))
      .catch((err: unknown) => {
        throw toToolError(err);
      });
  }
}
