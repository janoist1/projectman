import { memberOf, memberStorageHandle } from '@projectman/shared';
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
      const config = await this.calls.caller(ctx, 'save_memory');
      const note = args.note.trim();
      if (!note) throw new TeamToolError('invalid', 'The memory note is empty.');
      // The memory file is kept under the storage handle, so a renamed member keeps its notes.
      const member = memberOf(config, ctx.member);
      const handle = member?.kind === 'ai' ? memberStorageHandle(member) : ctx.member;
      await this.memory.append(ctx.projectKey, handle, note);
      return { ok: true as const };
    });
  }
}
