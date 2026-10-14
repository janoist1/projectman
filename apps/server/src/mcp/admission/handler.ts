import type { ToolContext } from '../../contracts';
import { type ToolCaller, toToolError } from '../caller';
import type { AdmissionToolsHandler } from '../../contracts/team-tools';
import type { HandoffService } from '../../runtime/admission';

export class AdmissionTools implements AdmissionToolsHandler {
  private readonly calls: ToolCaller;
  private readonly handoffs: Pick<HandoffService, 'recordNote'>;
  constructor(deps: { calls: ToolCaller; handoffs: Pick<HandoffService, 'recordNote'> }) {
    this.calls = deps.calls;
    this.handoffs = deps.handoffs;
  }

  async handOff(ctx: ToolContext, args: { taskKey: string; note: string }): Promise<{ recorded: true }> {
    try {
      await this.calls.caller(ctx, 'hand_off');
      await this.handoffs.recordNote(ctx, this.calls.validTaskKey(ctx, args.taskKey), args.note);
      return { recorded: true };
    } catch (err) {
      throw toToolError(err);
    }
  }
}
