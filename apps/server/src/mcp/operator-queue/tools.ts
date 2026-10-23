import { z } from 'zod';
import { defineTool, type TeamToolGroup } from '../kit';

export const OPERATOR_QUEUE_TOOL_GROUP: TeamToolGroup = {
  module: 'core/member-queue',
  tools: [
    defineTool({
      name: 'finish_queue_item',
      audience: { roles: ['operator'] },
      title: 'End an item of your work queue',
      readOnly: false,
      description:
        'The Operator ends the work queue item it was given (the message names its id). outcome "done": you did what it asked; summary says what you did, and operation_ids names the operations you ran (execute_operation). A held fix round decision also needs fix_limit_option (replan, reassign or another_round); a todo is closed as done with your summary. outcome "handed_off": the owner has to do it; handoff.reason is owner_reserved (the action is reserved to the owner; with operation_id when the operation already asks the owner), no_typed_operation (no typed operation does this) or no_grant (you have no grant for it), handoff.action is the imperative step the owner takes (one sentence), handoff.detail the context. Nothing waits for the owner here: the item ends at once and the owner gets a todo. Only the item your session is working on can be ended (409 queue_item_not_processing otherwise).',
      input: {
        item_id: z.string().min(1).max(100),
        outcome: z.enum(['done', 'handed_off']),
        summary: z.string().trim().min(1).max(2000),
        operation_ids: z.array(z.string().max(100)).max(20).optional(),
        fix_limit_option: z.enum(['replan', 'reassign', 'another_round']).optional(),
        handoff: z
          .object({
            reason: z.enum(['owner_reserved', 'no_typed_operation', 'no_grant']),
            action: z.string().trim().min(1).max(300),
            detail: z.string().max(2000).optional(),
            operation_id: z.string().max(100).optional(),
          })
          .optional(),
      },
      async run({ ctx, args, handler }) {
        const handoff = args.handoff;
        return JSON.stringify(
          await handler.finishQueueItem(ctx, {
            itemId: args.item_id,
            outcome: args.outcome,
            summary: args.summary,
            operationIds: args.operation_ids ?? [],
            ...(args.fix_limit_option ? { fixLimitOption: args.fix_limit_option } : {}),
            ...(handoff
              ? {
                  handoff: {
                    reason: handoff.reason,
                    action: handoff.action,
                    ...(handoff.detail ? { detail: handoff.detail } : {}),
                    ...(handoff.operation_id ? { operationId: handoff.operation_id } : {}),
                  },
                }
              : {}),
          }),
        );
      },
    }),
  ],
};
