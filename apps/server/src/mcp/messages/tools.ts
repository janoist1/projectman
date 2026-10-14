import { MAX_MESSAGE_ATTACHMENTS, MemberHandle, TaskKey } from '@projectman/shared';
import { z } from 'zod';
import { TeamToolError } from '../../contracts';
import { formatSentMessage } from '../format';
import { defineTool, type TeamToolGroup, MAX_PATH_CHARS, unique } from '../kit';
const MAX_MESSAGE_CHARS = 20_000;

export const MESSAGE_TOOL_GROUP: TeamToolGroup = {
  module: 'core/messages',
  tools: [
    defineTool({
      name: 'send_message',
      title: 'Send a team message',
      readOnly: false,
      description:
        'Send a message to teammates (humans or AI members). AI members receive it in their session for ' +
        'the task: an idle session at once, one in the middle of a turn when that turn ends; the result says, ' +
        'per recipient, what happens to it. Humans see it in the app. Use it to hand over work, report findings or reply to a team ' +
        'message. The Operator starts work with start_task or start_member and uses this for information and replies. ' +
        'If the message would put a member to work on a card where a member of the same role already works, nothing is sent and the result names them; send again with despite_workers: true only if the parallel work is intended. ' +
        "Specify action for a request, review or retest request, or question to an AI member; info for status, acknowledgement or a result (review and QA results live in labels). A plain acknowledgement needs no message; an out-of-date or fulfilled request needs no reply. Before acting, compare the message time and version with the current card; do not carry out a request its sender has superseded or closed with a result label. Never reset or force-rewrite an approved branch without asking its approving reviewer first. A human's decision or action is asked with ask_human, never with send_message: a message to a human carries information only (kind info), and an action message that has a human among its recipients is refused as a whole.",
      input: {
        despite_workers: z.boolean().optional(),
        to: z
          .array(MemberHandle)
          .min(1)
          .max(20)
          .describe('Recipient handles, e.g. ["qa"] or ["fe-1", "owner"]. Handles only, without "@".'),
        kind: z
          .enum(['action', 'info'])
          .describe(
            'action: an AI member has something to do (refused when a human is a recipient: use ask_human); info: status, acknowledgement or result; starts nothing.',
          ),
        text: z
          .string()
          .trim()
          .min(1)
          .max(MAX_MESSAGE_CHARS)
          .describe(
            'The message. Give the recipient what they need to act on it: the facts (task, links, what ' +
              'changed, findings) and what you expect next and from whom.',
          ),
        task_key: TaskKey.optional().describe(
          'Task the message is about, e.g. "AR-21". Defaults to the task of your current session. In a general ' +
            '(no card) session it defaults to the card of the latest card message delivered to you there ' +
            '(within 2 hours), so a reply stays on that card; give task_key for any other card.',
        ),
        signal_id: z
          .string()
          .optional()
          .describe('Operator only: the delivered system signal to present to owners.'),
        signal_actionable: z
          .boolean()
          .optional()
          .describe('Operator only: whether accepting this signal authorizes a proposed action.'),
        signal_ids: z
          .array(z.string().min(1))
          .min(1)
          .max(20)
          .optional()
          .describe('Operator only: delivered signals awaiting owner decisions, presented in one message.'),
        actionable_signal_ids: z
          .array(z.string().min(1))
          .max(20)
          .optional()
          .describe('Operator only: the subset of signal_ids whose acceptance authorizes an action.'),
        attachments: z
          .array(z.string().trim().min(1).max(MAX_PATH_CHARS))
          .min(1)
          .max(MAX_MESSAGE_ATTACHMENTS)
          .optional()
          .describe(
            'Files to attach: paths relative to your working directory or inside your session folder, as for ' +
              'attach_file. The recipients see them with the message (a human sees an image in the conversation); ' +
              'this is how to show a screenshot to a person. Say in text what the file is. If any file cannot be ' +
              'read, nothing is sent.',
          ),
      },
      async run({ ctx, args, handler }) {
        // A message to oneself would be typed back into the caller's own session.
        const to = unique(args.to).filter((handle) => handle !== ctx.member);
        if (to.length === 0) {
          throw new TeamToolError(
            'invalid',
            'You cannot send a message to yourself; address teammates by handle (see list_members).',
          );
        }
        const taskKey = args.task_key ?? ctx.taskKey;
        const result = await handler.sendMessage(ctx, {
          to,
          kind: args.kind,
          despiteWorkers: args.despite_workers,
          text: args.text,
          signalId: args.signal_id,
          signalActionable: args.signal_actionable,
          signalIds: args.signal_ids,
          actionableSignalIds: args.actionable_signal_ids,
          ...(args.attachments ? { attachments: unique(args.attachments) } : {}),
          ...(taskKey ? { taskKey } : {}),
        });
        return formatSentMessage({ ...result, requested: to, taskKey });
      },
    }),
  ],
};
