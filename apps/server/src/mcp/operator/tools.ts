import { MemberHandle, OperatorOperation, TaskKey } from '@projectman/shared';
import { z } from 'zod';
import { TeamToolError } from '../../contracts';
import { formatMemberStart, formatProjectState } from '../format';
import { defineTool, type TeamToolGroup } from '../kit';

export const OPERATOR_TOOL_GROUP: TeamToolGroup = {
  module: 'services/operator',
  tools: [
    defineTool({
      name: 'get_project_state',
      title: 'Read project state',
      description:
        "Operator only, in the owners' conversation or a system-signal turn; unavailable in guest conversations. The source of every fact the Operator states about the running system: the running version and release, why a card is waiting, what became of a start or a message, or the project overview (stages, live and idle sessions, waiting starts, pauses and open owner inbox items). This read needs no open owner request. Explain the result to the owner in the project language.",
      readOnly: true,
      input: {
        task_key: TaskKey.optional().describe(
          'A card in this project; omit for the overview. Not together with message_id.',
        ),
        message_id: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe(
            'A team message of this project (the id send_message answered with): what became of it for each recipient. Not together with task_key.',
          ),
      },
      async run({ ctx, args, handler }) {
        if (args.task_key && args.message_id)
          throw new TeamToolError('invalid', 'Give either task_key or message_id, not both.');
        return formatProjectState(
          await handler.getProjectState(
            ctx,
            args.message_id
              ? { messageId: args.message_id }
              : args.task_key
                ? { taskKey: args.task_key }
                : {},
          ),
        );
      },
    }),

    defineTool({
      name: 'operate',
      title: 'Operate the project',
      readOnly: false,
      description:
        'Only the Operator, during an open owner request. Propose a configuration, member, session or project pause operation. The server executes immediate changes, requests owner approval for restricted changes, and refuses forbidden changes. Title describes the result in the project language (1–120 characters).',
      input: { title: z.string().trim().min(1).max(120), operation: OperatorOperation },
      async run({ ctx, args, handler }) {
        return JSON.stringify(await handler.operate(ctx, args));
      },
    }),

    defineTool({
      name: 'screen_question',
      title: 'Screen an AI member’s question',
      readOnly: false,
      description:
        'Only the Operator, not in a guest conversation; needs no owner request. Settle a question an AI member asked a person, which waits for you in the inbox state screening (the notice lists them). Always give note, the reason or background (the owner and the timeline see it). Outcomes: answered (a fact you found on the card, in the decision log, the roadmap, the code or an earlier owner answer; needs answer, name the source in note; the member is told the answer is yours and may ask a person again), forwarded (answering is another AI member’s part of the work; needs forward_to, an AI member other than the asker and you; that member is woken), moot (the question is obsolete; also works on a question that already went to the people), decision (a person must decide: it opens in the inbox as asked), todo (only a person can do it; needs todo with the exact step: what, where, expected; the inbox shows Done / Cannot do it). Other fields than the outcome needs are refused (invalid_outcome_fields). After the ten minutes are over the question belongs to the people: question_not_screening, except moot.',
      input: {
        item_id: z.string().min(1).max(100).describe('The question’s inbox item id from the notice.'),
        outcome: z.enum(['answered', 'forwarded', 'moot', 'decision', 'todo']),
        note: z
          .string()
          .trim()
          .min(1)
          .max(2000)
          .describe('Why, or the source of the answer. Always required.'),
        answer: z.string().trim().min(1).max(10000).optional().describe('The answer; only with answered.'),
        forward_to: MemberHandle.optional().describe(
          'The AI member to pass the question to; only with forwarded.',
        ),
        todo: z
          .strictObject({
            what: z.string().trim().min(1).max(2000).describe('What the person has to do.'),
            where: z.string().trim().min(1).max(500).describe('Where: the place, screen or system.'),
            expected: z.string().trim().min(1).max(1000).describe('What result is expected back.'),
          })
          .optional()
          .describe('The exact step for a person; only with todo.'),
      },
      check(args, issue) {
        if ((args.outcome === 'answered') !== (args.answer !== undefined))
          issue('answer', 'answer goes with the outcome answered, and only with it.');
        if ((args.outcome === 'forwarded') !== (args.forward_to !== undefined))
          issue('forward_to', 'forward_to goes with the outcome forwarded, and only with it.');
        if ((args.outcome === 'todo') !== (args.todo !== undefined))
          issue('todo', 'todo goes with the outcome todo, and only with it.');
      },
      async run({ ctx, args, handler }) {
        return JSON.stringify(
          await handler.screenQuestion(ctx, {
            itemId: args.item_id,
            outcome: args.outcome,
            note: args.note,
            ...(args.answer !== undefined ? { answer: args.answer } : {}),
            ...(args.forward_to !== undefined ? { forwardTo: args.forward_to } : {}),
            ...(args.todo ? { todo: args.todo } : {}),
          }),
        );
      },
    }),

    defineTool({
      name: 'start_task',
      title: 'Start work on a task',
      readOnly: false,
      description:
        "Only the Operator, during an open owner request. Use the same start as the Start button, choosing an optional assignee and starting gate setters. Also starts a stalled task already in its work stage without a running session. Gates and prerequisites still apply. A refused start waits for nothing; the error names why (for example member_on_leave, member_at_capacity, team_paused). With signal_id (an idle card the system signalled) and no owner request, and only when the project lets the Operator act on signals, it starts the card's own assignee; it takes no assignee or despite_prerequisites then.",
      input: {
        task_key: TaskKey,
        assignee: MemberHandle.optional(),
        despite_prerequisites: z.boolean().optional(),
        signal_id: z.string().min(1).max(64).optional(),
      },
      async run({ ctx, args, handler }) {
        return JSON.stringify(
          await handler.startTask(ctx, {
            taskKey: args.task_key,
            assignee: args.assignee,
            despitePrerequisites: args.despite_prerequisites,
            ...(args.signal_id !== undefined ? { signalId: args.signal_id } : {}),
          }),
        );
      },
    }),

    defineTool({
      name: 'start_member',
      title: 'Start a member on work without a card',
      readOnly: false,
      description:
        "Only the Operator, during an open owner request. Starts an AI member on work that has no card: the text is their task, given to their general conversation (a running one gets it when its turn ends). It waits up to 5 seconds and says what became of the start: started, already running, starting, waiting with the reason, held, or failed. For work on a card use start_task. With task_key the text is about that card and the member needs a role on it (a card's merger or the owner of its step). With signal_id (and no owner request) and only when the project lets the Operator act on signals, it starts the member the signal names.",
      input: {
        member: MemberHandle,
        text: z.string().min(1).max(20000),
        task_key: TaskKey.optional(),
        signal_id: z.string().min(1).max(64).optional(),
      },
      async run({ ctx, args, handler }) {
        return formatMemberStart(
          await handler.startMember(ctx, {
            member: args.member,
            text: args.text,
            ...(args.task_key !== undefined ? { taskKey: args.task_key } : {}),
            ...(args.signal_id !== undefined ? { signalId: args.signal_id } : {}),
          }),
        );
      },
    }),
  ],
};
