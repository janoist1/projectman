import type {
  SubmitBoundaryRequest,
  DecideBoundaryRequest,
  BoundaryRequest,
  BoundaryGrant,
} from '@projectman/shared';
import type { BoundaryToolsHandler, ToolContext } from '../../contracts';
import type { BoundaryService } from '../../services/boundary';
import { type ToolCaller, toToolError } from '../caller';

/** What the boundary tools use of the boundary service. */
type BoundaryOperations = Pick<BoundaryService, 'submit' | 'read' | 'decide'>;

export class BoundaryTools implements BoundaryToolsHandler {
  private readonly calls: ToolCaller;
  private readonly boundary: BoundaryOperations;

  constructor(deps: { calls: ToolCaller; boundary: BoundaryOperations }) {
    this.calls = deps.calls;
    this.boundary = deps.boundary;
  }

  async submitBoundaryRequest(ctx: ToolContext, args: SubmitBoundaryRequest): Promise<BoundaryRequest> {
    try {
      await this.calls.caller(ctx, 'submit_boundary_request');
      return await this.boundary.submit(
        { projectKey: ctx.projectKey, member: ctx.member, sessionId: ctx.sessionId, taskKey: ctx.taskKey },
        args,
      );
    } catch (err) {
      throw toToolError(err);
    }
  }
  async getBoundaryRequest(
    ctx: ToolContext,
    args: { requestId: string },
  ): Promise<{ request: BoundaryRequest; grant: BoundaryGrant | null }> {
    try {
      await this.calls.caller(ctx, 'get_boundary_request');
      return await this.boundary.read(ctx.projectKey, args.requestId, ctx.member);
    } catch (err) {
      throw toToolError(err);
    }
  }
  async decideBoundaryRequest(
    ctx: ToolContext,
    args: DecideBoundaryRequest & { requestId: string },
  ): Promise<BoundaryRequest> {
    try {
      await this.calls.caller(ctx, 'decide_boundary_request');
      return await this.boundary.decide(
        ctx.projectKey,
        args.requestId,
        ctx.member,
        { decision: args.decision, reason: args.reason },
        { delegatedOnly: true },
      );
    } catch (err) {
      throw toToolError(err);
    }
  }
}
