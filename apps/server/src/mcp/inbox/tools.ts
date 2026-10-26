import {
  AttachmentId,
  BoundaryId,
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
        'Ask a human for a decision or information you cannot find or decide yourself (requirements, ' +
        'priorities, access, trade-offs). Never ask for an approval label with it: an answer puts no label ' +
        'on, the app asks the label holders itself. The answer arrives later in this session as a team ' +
        'message. Do not wait or poll for it: continue with work that does not depend on the answer, or end ' +
        'your turn. Ask one clear question. The human who answers is usually not a specialist and often ' +
        'reads on a phone: start with one plain sentence that names the decision in everyday words, describe ' +
        'each option by what happens if it is picked, and always recommend one option with a one-sentence ' +
        'reason. Put code, file names and technical reasoning into details; the inbox shows it folded. Name ' +
        'a file of the card or its parent in attachments instead of describing where to find it. The ' +
        'Operator screens your question first (within 10 minutes) and tells you in a team message whether it ' +
        'answered it, passed it to a member, closed it or sent it on to the people.',
      input: {
        question: z
          .string()
          .trim()
          .min(1)
          .max(MAX_QUESTION_CHARS)
          .describe('The decision in one plain sentence, then only the context needed to choose.'),
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
              'accepted too). Offer them whenever the decision has alternatives; omit for a free-text answer.',
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
            'Technical background as markdown, shown folded: the question must make sense without it.',
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
              'needs to look at to answer. At most 6.',
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
        recipient: QuestionRecipient.optional().describe(
          'Suggested todo recipient (default owner); screening decides.',
        ),
        response_purpose: QuestionResponsePurpose.optional().describe(
          'information: a plain factual question, no decision; the integrator may relay the answer. ' +
            'owner_decision (default): a choice or anything with cost, deletion or security; only the owner answers.',
        ),
      },
      check(args, issue) {
        if ((args.reask_of === undefined) !== (args.reask_reason === undefined))
          issue('reask_of', 'reask_of and reask_reason go together: give both or neither.');
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
        omit: ['reask_of', 'reask_reason', 'recipient'],
        description:
          'Ask the owners a question you cannot decide yourself. It goes to their inbox, unscreened: {inbox_item_id, state: "open", approval_label?, attachments}. Only an owner answers it, with their own login; you cannot answer it yourself, and no one wakes you when it is answered. Read the answer with get_super_question, and withdraw a moot question with withdraw_question. Write for a non-specialist who often reads on a phone: one plain sentence that names the decision, the options by what happens if one is picked, one recommended option with a one-sentence reason, technical background in details. response_purpose information marks a plain factual question whose answer is no decision; owner_decision (default) is a choice, an approval or anything with cost, deletion or security. `to` names existing humans (owners only for an owner decision); omit it to ask the current owners. task_key and attachments name a card and files of that card or its parent; there is no default card.',
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
        "Answer a member's permission request that a team message handed to you as its decider: the tool call its CLI asks about, with its exact input. Read it completely first. allow only a routine step that plainly belongs to the task; deny what plainly does not; escalate everything else, which hands it to a person. Always escalate spending, new accounts, tokens or secrets, a lasting widening of what the host reaches, the live system, a release, publishing or main, a request that is cut off or unclear, and your own requests. The reason is required, short and without secrets: it is shown to the owner and the member. Only the decider of that request may answer, before its deadline; late answers are refused and never mean permission.",
      input: {
        request_id: BoundaryId,
        decision: z.enum(['allow', 'deny', 'escalate']),
        reason: z.string().trim().min(1).max(MAX_REASON_CHARS),
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
