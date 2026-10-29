import {
  AttachmentId,
  MAX_QUESTION_ATTACHMENTS,
  MemberHandle,
  questionChoices,
  QuestionResponsePurpose,
  QuestionRecipient,
  TaskKey,
} from '@projectman/shared';
import { formatQuestionAsked } from '../format';
import { z } from 'zod';
import { defineTool, type TeamToolGroup, unique } from '../kit';
const MAX_QUESTION_CHARS = 4_000;

const MAX_OPTION_CHARS = 200;

const MAX_CONSEQUENCE_CHARS = 400;

const MAX_REASON_CHARS = 400;

const MAX_WITHDRAW_REASON_CHARS = 1_000;

const MAX_DETAILS_CHARS = 10_000;

export const INBOX_TOOL_GROUP: TeamToolGroup = {
  module: 'core/inbox',
  tools: [
    defineTool({
      name: 'ask_human',
      title: 'Ask a human',
      readOnly: false,
      description:
        'Ask a human for a decision or information you cannot find or decide yourself. The answer arrives ' +
        'later as a team message: do not wait or poll; continue with independent work or end your turn. The ' +
        'Operator screens it first (within 10 minutes) and tells you what became of it.',
      input: {
        question: z
          .string()
          .trim()
          .min(1)
          .max(MAX_QUESTION_CHARS)
          .describe(
            'One clear question. The answerer is usually no specialist and often on a phone: name the ' +
              'decision in one plain sentence in everyday words, then only the context needed to choose. ' +
              'Never ask for an approval label: an answer sets none, the app asks the label holders itself.',
          ),
        options: z
          .array(
            z.union([
              z.string().trim().min(1).max(MAX_OPTION_CHARS),
              z.strictObject({
                label: z.string().trim().min(1).max(MAX_OPTION_CHARS).describe('Short button text.'),
                consequence: z
                  .string()
                  .trim()
                  .min(1)
                  .max(MAX_CONSEQUENCE_CHARS)
                  .optional()
                  .describe('What happens if the human picks this option, in everyday words.'),
              }),
            ]),
          )
          .min(1)
          .max(10)
          .optional()
          .describe(
            'Suggested answers shown as buttons: a short label and its consequence (a plain label string is ' +
              'accepted too). Required for a decision, a yes/no question too; omit only with ' +
              'response_purpose information. The answerer can always write another answer.',
          ),
        recommended: z
          .string()
          .trim()
          .min(1)
          .max(MAX_OPTION_CHARS)
          .optional()
          .describe(
            'The label of the option you recommend, written exactly the same way. Always give it, with ' +
              'recommendation_reason.',
          ),
        recommendation_reason: z
          .string()
          .trim()
          .min(1)
          .max(MAX_REASON_CHARS)
          .optional()
          .describe('Why you recommend it, in one plain sentence. Needs recommended.'),
        details: z
          .string()
          .trim()
          .min(1)
          .max(MAX_DETAILS_CHARS)
          .optional()
          .describe(
            'Code, file names and technical reasoning as markdown, shown folded: the question must make sense without it.',
          ),
        task_key: TaskKey.optional().describe(
          'Task the question is about. Defaults to the task of your current session.',
        ),
        to: z
          .array(MemberHandle)
          .min(1)
          .max(10)
          .optional()
          .describe(
            'Handles of the humans to ask. Omit to ask the humans responsible for the task or project.',
          ),
        attachments: z
          .array(AttachmentId)
          .min(1)
          .max(MAX_QUESTION_ATTACHMENTS)
          .optional()
          .describe(
            "Ids (att_…) of the files, on the question's card or its parent (list_attachments), the human " +
              'needs to look at to answer, instead of describing where to find them. At most 6.',
          ),
        reask_of: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .optional()
          .describe(
            'Only when the Operator answered, forwarded or closed your earlier question and you still need a ' +
              "person's answer: its id. The new one goes to the people unscreened; needs reask_reason.",
          ),
        reask_reason: z
          .string()
          .trim()
          .min(1)
          .max(1000)
          .optional()
          .describe('Why a person must see it after all. Needs reask_of.'),
        signal_id: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .optional()
          .describe(
            'Only the project manager: the open system signal delivered to you that this question is about. ' +
              "The question closes by itself when the signal's case ends; task_key defaults to the signal's card.",
          ),
        recipient: QuestionRecipient.optional().describe(
          'Suggested todo recipient (default owner); screening decides. integrator reaches the machine queue only from a member with machine access.',
        ),
        response_purpose: QuestionResponsePurpose.optional().describe(
          'information: a plain factual question, no decision; the integrator may relay the answer; needs no options. ' +
            'owner_decision (default): a choice or anything with cost, deletion or security; only the owner answers.',
        ),
      },
      check(args, issue) {
        if ((args.reask_of === undefined) !== (args.reask_reason === undefined))
          issue('reask_of', 'reask_of and reask_reason go together: give both or neither.');
        if (args.options === undefined && (args.response_purpose ?? 'owner_decision') === 'owner_decision') {
          issue(
            'options',
            'A decision needs its choices as options, a yes/no question too (for example Yes / No in the ' +
              "project's language, each with its consequence). The answerer can always write another answer, " +
              'so do not add an "other" option. For a plain factual question that is no decision, set ' +
              'response_purpose to information.',
          );
        }
        const labels = questionChoices(args.options).map((choice) => choice.label);
        if (args.recommended !== undefined && !labels.includes(args.recommended)) {
          issue(
            'recommended',
            labels.length > 0
              ? `recommended must be exactly one of the options: ${labels.map((label) => JSON.stringify(label)).join(', ')}.`
              : 'recommended must name one of the options, but there are none: offer your suggestion as an option.',
          );
        }
        if (args.recommendation_reason !== undefined && args.recommended === undefined) {
          issue(
            'recommendation_reason',
            'recommendation_reason needs recommended: name the option you recommend.',
          );
        }
      },
      external: {
        access: 'write',
        modes: ['super'],
        omit: ['reask_of', 'reask_reason', 'recipient', 'signal_id'],
        description:
          'Ask the owners a question you cannot decide yourself. It goes to their inbox, unscreened: {inbox_item_id, state: "open", approval_label?, attachments}. Only an owner answers it, with their own login; you cannot answer it yourself, and no one wakes you when it is answered. Read the answer with get_super_question, and withdraw a moot question with withdraw_question. Write for a non-specialist who often reads on a phone: one plain sentence that names the decision, the options by what happens if one is picked, one recommended option with a one-sentence reason, technical background in details. response_purpose information marks a plain factual question whose answer is no decision; owner_decision (default) is a choice, an approval or anything with cost, deletion or security. options are required for an owner decision. `to` names existing humans (owners only for an owner decision); omit it to ask the current owners. task_key and attachments name a card and files of that card or its parent; there is no default card.',
        async run({ ctx, args, handler }) {
          const asked = await handler.askHuman(ctx, {
            question: args.question,
            ...(args.options ? { options: args.options } : {}),
            ...(args.recommended ? { recommended: args.recommended } : {}),
            ...(args.recommendation_reason ? { recommendationReason: args.recommendation_reason } : {}),
            ...(args.details ? { details: args.details } : {}),
            ...(args.task_key ? { taskKey: args.task_key } : {}),
            ...(args.to ? { to: args.to } : {}),
            ...(args.attachments ? { attachmentIds: args.attachments } : {}),
            ...(args.response_purpose ? { responsePurpose: args.response_purpose } : {}),
          });
          return {
            structured: {
              inbox_item_id: asked.inboxItemId,
              state: asked.state,
              ...(asked.approvalLabel ? { approval_label: asked.approvalLabel } : {}),
              attachments: asked.attachments ?? [],
            },
          };
        },
      },
      async run({ ctx, args, handler }) {
        const taskKey = args.task_key ?? ctx.taskKey;
        const to = args.to ? unique(args.to) : undefined;
        const { inboxItemId, approvalLabel, attachments, screening } = await handler.askHuman(ctx, {
          question: args.question,
          ...(args.signal_id ? { signalId: args.signal_id } : {}),
          ...(args.recipient ? { recipient: args.recipient } : {}),
          ...(args.options ? { options: args.options } : {}),
          ...(args.recommended ? { recommended: args.recommended } : {}),
          ...(args.recommendation_reason ? { recommendationReason: args.recommendation_reason } : {}),
          ...(args.details ? { details: args.details } : {}),
          ...(taskKey ? { taskKey } : {}),
          ...(to ? { to } : {}),
          ...(args.attachments ? { attachmentIds: unique(args.attachments) } : {}),
          ...(args.reask_of !== undefined ? { reaskOf: args.reask_of } : {}),
          ...(args.reask_reason !== undefined ? { reaskReason: args.reask_reason } : {}),
          ...(args.response_purpose ? { responsePurpose: args.response_purpose } : {}),
        });
        return (
          (args.recipient
            ? `Suggested recipient: ${args.recipient}; screening decides the actual recipient.\n`
            : '') +
          formatQuestionAsked(
            inboxItemId,
            to,
            {
              question: args.question,
              recommended: args.recommended,
            },
            approvalLabel,
            attachments,
            screening === true,
          )
        );
      },
    }),
    defineTool({
      name: 'withdraw_question',
      title: 'Withdraw a question',
      readOnly: false,
      description:
        'Withdraw your own ask_human question that still waits and became moot. Give a short reason; it ' +
        'is recorded on the card.',
      input: {
        item_id: z.string().trim().min(1).describe('Id of the question, as ask_human gave it.'),
        reason: z.string().trim().min(1).max(MAX_WITHDRAW_REASON_CHARS).describe('Why it is moot, briefly.'),
      },
      external: {
        access: 'write',
        modes: ['super'],
        description:
          'Withdraw a question you asked with ask_human while it still waits, because it became moot: {item_id, state: "cancelled"}. Only a question asked through this owner’s keys in this project can be withdrawn; a question that is already answered or closed is refused (inbox_item_closed). Give a short reason; it is recorded.',
        async run({ ctx, args, handler }) {
          const withdrawn = await handler.withdrawQuestion(ctx, {
            itemId: args.item_id,
            reason: args.reason,
          });
          return { structured: { item_id: withdrawn.itemId, state: withdrawn.state } };
        },
      },
      async run({ ctx, args, handler }) {
        const { itemId } = await handler.withdrawQuestion(ctx, { itemId: args.item_id, reason: args.reason });
        return `Question ${itemId} withdrawn.`;
      },
    }),
    defineTool({
      name: 'decide_permission_request',
      title: 'Decide a delegated permission request',
      audience: { duties: ['boundary_authorization'] },
      readOnly: false,
      description:
        "Answer a member's permission request a team message handed to you as its decider (a tool call with " +
        'its exact input; read it completely). Your duty instructions say what to allow, deny or escalate. ' +
        'Only the decider, before the deadline: late answers are refused and never mean permission.',
      input: {
        request_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
        decision: z
          .enum(['allow', 'deny', 'escalate'])
          .describe('escalate hands it to a person; always for anything not plainly routine or plainly out.'),
        reason: z
          .string()
          .trim()
          .min(1)
          .max(MAX_REASON_CHARS)
          .describe('Short, without secrets: the owner and the member see it.'),
      },
      async run({ ctx, args, handler }) {
        return JSON.stringify(
          await handler.decidePermissionRequest(ctx, {
            requestId: args.request_id,
            decision: args.decision,
            reason: args.reason,
          }),
        );
      },
    }),
  ],
};
