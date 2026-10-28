import type { HostRequestState } from '@projectman/shared';
import type { ToolContext } from '../../contracts';
import type { HostRequestsService } from '../../services/host-requests';
import type { ToolCaller } from '../caller';
import { toToolError } from '../caller';

export class HostRequestTools {
  private readonly calls: ToolCaller;
  private readonly hostRequests: Pick<HostRequestsService, 'open' | 'listForProject' | 'withdraw'>;

  constructor(deps: {
    calls: ToolCaller;
    hostRequests: Pick<HostRequestsService, 'open' | 'listForProject' | 'withdraw'>;
  }) {
    this.calls = deps.calls;
    this.hostRequests = deps.hostRequests;
  }

  async askHost(ctx: ToolContext, args: { title: string; body: string; taskKey: string | null }) {
    try {
      await this.calls.caller(ctx, 'ask_host');
      return await this.hostRequests.open(ctx.projectKey, ctx.member, {
        title: args.title,
        body: args.body,
        taskKey: args.taskKey ?? undefined,
      });
    } catch (err) {
      throw toToolError(err);
    }
  }

  async listHostRequests(ctx: ToolContext, args: { state?: HostRequestState }) {
    try {
      await this.calls.caller(ctx, 'list_host_requests');
      return this.hostRequests.listForProject(ctx.projectKey, args.state);
    } catch (err) {
      throw toToolError(err);
    }
  }

  async withdrawHostRequest(ctx: ToolContext, args: { id: string }) {
    try {
      await this.calls.caller(ctx, 'withdraw_host_request');
      return await this.hostRequests.withdraw(ctx.projectKey, ctx.member, args.id);
    } catch (err) {
      throw toToolError(err);
    }
  }
}
