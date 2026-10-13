import type { MemberView } from '@projectman/shared';
import type { ToolContext } from '../../contracts';
import type { MemberService } from '../../domain/members';

import type { ToolCaller } from '../caller';
import type { MemberToolsHandler } from '../../contracts';

export class MemberTools implements MemberToolsHandler {
  private readonly calls: ToolCaller;
  private readonly members: Pick<MemberService, 'rosterFor' | 'rosterForViewer'>;
  constructor(deps: { calls: ToolCaller; members: Pick<MemberService, 'rosterFor' | 'rosterForViewer'> }) {
    this.calls = deps.calls;
    this.members = deps.members;
  }
  async listMembers(ctx: ToolContext): Promise<MemberView[]> {
    return this.calls.guard(async () => {
      const { config, guest } = await this.calls.callerWithRequest(ctx, 'list_members');
      return guest ? this.members.rosterForViewer(config, guest.viewer) : this.members.rosterFor(config);
    });
  }
}
