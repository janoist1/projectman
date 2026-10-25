import type { MemberView } from '@projectman/shared';
import { TeamToolError } from '../../contracts';
import type { MemberMemoryStore, ToolContext } from '../../contracts';
import type { MemberService } from '../../core/members';

import type { ToolCaller } from '../caller';
import type { MemberToolsHandler } from '../../contracts';

export class MemberTools implements MemberToolsHandler {
  private readonly calls: ToolCaller;
  private readonly members: Pick<MemberService, 'rosterFor'>;
  private readonly memory: MemberMemoryStore;
  constructor(deps: {
    memory: MemberMemoryStore;
    calls: ToolCaller;
    members: Pick<MemberService, 'rosterFor'>;
  }) {
    this.memory = deps.memory;
    this.calls = deps.calls;
    this.members = deps.members;
  }
  async listMembers(ctx: ToolContext): Promise<MemberView[]> {
    return this.calls.guard(async () => {
      const { config } = await this.calls.callerWithRequest(ctx, 'list_members');
      return this.members.rosterFor(config);
    });
  }
  async saveMemory(ctx: ToolContext, args: { note: string }): Promise<{ ok: true }> {
    return this.calls.guard(async () => {
      await this.calls.caller(ctx, 'save_memory');
      const note = args.note.trim();
      if (!note) throw new TeamToolError('invalid', 'The memory note is empty.');
      await this.memory.append(ctx.projectKey, ctx.member, note);
      return { ok: true as const };
    });
  }
}
