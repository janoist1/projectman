import {
  CardView,
  MAX_MESSAGE_ATTACHMENTS,
  MAX_MESSAGE_PLACES,
  MemberHandle,
  SettingsSection,
  TaskKey,
  UI_PLACE_PAGES,
} from '@projectman/shared';
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
        'Send a message to teammates (humans or AI members): to hand over work, report findings or reply to a ' +
        'team message. AI members receive it in their session for the task: an idle session at once, one in ' +
        'the middle of a turn when that turn ends; the result says, per recipient, what happens to it. ' +
        'Humans see it in the app. The PM starts work with start_task or start_member and uses this for ' +
        'information and replies. If the message would put a member to work on a card where a member of ' +
        'the same role already works, nothing is sent and the result names them; send again with ' +
        'despite_workers: true only if the parallel work is intended.',
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
            'action: an AI member has something to do (refused when a human is a recipient: use ask_human); info: status or result; starts nothing.',
          ),
        text: z
          .string()
          .trim()
          .min(1)
          .max(MAX_MESSAGE_CHARS)
          .describe(
            'The message: the facts the recipient needs to act on it (task, links, findings) and what you ' +
              'expect next and from whom.',
          ),
        task_key: TaskKey.optional().describe(
          'Task the message is about. Defaults to the task of your current session; in a general (no card) ' +
            'session, to the card of the latest card message delivered to you there (within 2 hours).',
        ),
        signal_id: z.string().optional().describe('PM only: the system signal to present to owners.'),
        signal_actionable: z
          .boolean()
          .optional()
          .describe('PM only: whether accepting the signal authorizes an action.'),
        signal_ids: z
          .array(z.string().min(1))
          .min(1)
          .max(20)
          .optional()
          .describe('PM only: signals awaiting owner decisions, presented in one message.'),
        actionable_signal_ids: z
          .array(z.string().min(1))
          .max(20)
          .optional()
          .describe('PM only: the signal_ids whose acceptance authorizes an action.'),
        attachments: z
          .array(z.string().trim().min(1).max(MAX_PATH_CHARS))
          .min(1)
          .max(MAX_MESSAGE_ATTACHMENTS)
          .optional()
          .describe(
            'Files to attach, as for attach_file (paths relative to your working directory or inside your ' +
              'session folder). A human sees an image in the conversation. Say in text what the file is. If ' +
              'any file cannot be read, nothing is sent.',
          ),
        places: z
          .array(
            z.strictObject({
              page: z.enum(UI_PLACE_PAGES),
              task_key: TaskKey.optional().describe('Required for page "card".'),
              view: CardView.optional().describe('Only for page "card".'),
              handle: MemberHandle.optional().describe('Required for page "member".'),
              section: SettingsSection.optional().describe('Only for page "settings".'),
            }),
          )
          .min(1)
          .max(MAX_MESSAGE_PLACES)
          .optional()
          .describe(
            "PM only: up to 3 places in the app offered to the person as 'go there' buttons under your message, " +
              'when they ask to be taken somewhere or to find something. Only places every recipient can see. ' +
              'The app writes the button text; a plain-text reply carries no buttons.',
          ),
      },
      external: {
        access: 'write',
        // The integrator has no session folder to attach from and is not the PM that presents signals or offers places.
        omit: [
          'attachments',
          'signal_id',
          'signal_actionable',
          'signal_ids',
          'actionable_signal_ids',
          'places',
        ],
        async run({ ctx, args, handler }) {
          const to = unique(args.to);
          const result = await handler.sendMessage(ctx, {
            to,
            kind: args.kind,
            text: args.text,
            ...(args.despite_workers !== undefined ? { despiteWorkers: args.despite_workers } : {}),
            ...(args.task_key ? { taskKey: args.task_key } : {}),
          });
          return formatSentMessage({ ...result, requested: to, taskKey: args.task_key ?? null });
        },
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
          ...(args.places ? { places: args.places } : {}),
          ...(taskKey ? { taskKey } : {}),
        });
        return formatSentMessage({ ...result, requested: to, taskKey });
      },
    }),
  ],
};
