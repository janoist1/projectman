import { BoundaryId, BoundaryReason } from '@projectman/shared';
import { z } from 'zod';
import { defineTool, type TeamToolGroup } from '../kit';

export const BOUNDARY_TOOL_GROUP: TeamToolGroup = {
  module: 'services/boundary',
  tools: [
    defineTool({
      name: 'submit_boundary_request',
      title: 'Submit a boundary request',
      readOnly: false,
      description:
        'Request one external operation registered by the protected operation adapter. Supply its opaque operation id and a stable retry key. The server derives the exact target, category, scope and expiry. This returns immediately; inspect later with get_boundary_request. Never include commands, credentials or secrets. This does not approve CLI permissions, gates or releases.',
      input: { operation_id: BoundaryId, deduplication_key: BoundaryId },
      async run({ ctx, args, handler }) {
        return JSON.stringify(
          await handler.submitBoundaryRequest(ctx, {
            operationId: args.operation_id,
            deduplicationKey: args.deduplication_key,
          }),
        );
      },
    }),
    defineTool({
      name: 'get_boundary_request',
      title: 'Inspect a boundary request',
      readOnly: true,
      description:
        'Inspect a boundary request you raised or may decide. Pending requests require a later retry; expiry or escalation never automatically permits execution.',
      input: { request_id: BoundaryId },
      async run({ ctx, args, handler }) {
        return JSON.stringify(await handler.getBoundaryRequest(ctx, { requestId: args.request_id }));
      },
    }),
    defineTool({
      name: 'decide_boundary_request',
      title: 'Decide a delegated boundary request',
      readOnly: false,
      description:
        'Independent live holders of boundary_authorization may allow or deny a delegable request before its lead deadline. Inspect its exact target first. Cost, production/release/main publication, accounts/secrets and host expansion always require the owner. Late or self decisions are refused. Use a structured reason; never include credentials.',
      input: { request_id: BoundaryId, decision: z.enum(['allow', 'deny']), reason: BoundaryReason },
      async run({ ctx, args, handler }) {
        return JSON.stringify(
          await handler.decideBoundaryRequest(ctx, {
            requestId: args.request_id,
            decision: args.decision,
            reason: args.reason,
          }),
        );
      },
    }),
  ],
};
