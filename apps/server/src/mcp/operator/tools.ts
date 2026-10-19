import {
  MemberHandle,
  BuiltInRoleId,
  CombineQuestionsRequest,
  OperatorOperation,
  OperatorPreferenceData,
  ProposeOperatorKnowledgeRequest,
  OperatorPlan,
  RequestSuperOperationRequest,
  SuperCommand,
  TaskKey,
} from '@projectman/shared';
import { z } from 'zod';
import { TeamToolError } from '../../contracts';
import type { MessageStateReport, ProjectStateReport, TaskStateReport } from '../../contracts';
import { formatMemberStart, formatProjectState } from '../format';
import { defineTool, type TeamToolGroup } from '../kit';

/** Serves the member tool and the bearer endpoint alike (PM-760); `C` is the caller's context type. */
async function runGetProjectState<C>({
  ctx,
  args,
  handler,
}: {
  ctx: C;
  args: { task_key?: string | undefined; message_id?: string | undefined };
  handler: {
    getProjectState(
      ctx: C,
      args: { taskKey?: string; messageId?: string },
    ): Promise<TaskStateReport | ProjectStateReport | MessageStateReport>;
  };
}) {
  if (args.task_key && args.message_id)
    throw new TeamToolError('invalid', 'Give either task_key or message_id, not both.');
  return formatProjectState(
    await handler.getProjectState(
      ctx,
      args.message_id ? { messageId: args.message_id } : args.task_key ? { taskKey: args.task_key } : {},
    ),
  );
}

export const OPERATOR_TOOL_GROUP: TeamToolGroup = {
  module: 'services/operator',
  tools: [
    defineTool({
      name: 'get_role_configuration',
      title: 'Read one built-in role configuration',
      readOnly: true,
      description:
        'Only the Operator in its owner general conversation, never guests. Needs no open request. Returns the configuration version, the stored override (null when absent), and the effective full role bundle. Read before editing a role; preserve its existing instructions and other bundle fields.',
      input: { role: BuiltInRoleId },
      external: {
        access: 'read',
        modes: ['super', 'read'],
        description:
          'Returns the configuration version, the stored override (null when absent), and the effective full role bundle of one built-in role: {version, role, override, effective}. Read before proposing a change to a role.',
        async run({ ctx, args, handler }) {
          return { structured: { ...(await handler.getRoleConfiguration(ctx, args)) } };
        },
      },
      async run({ ctx, args, handler }) {
        return JSON.stringify(await handler.getRoleConfiguration(ctx, args));
      },
    }),
    defineTool({
      name: 'request_structural_review',
      title: 'Request an occasional architecture review',
      readOnly: false,
      description:
        'Selected PM internal general session only. Weigh a delivered structural_pattern or milestone_closed signal and give a short reason. Without your own open owner request this only proposes an owner approval; nobody starts before approval. On approval call this tool again with the same signal_id. The server selects a live technical_direction holder with capacity and uses start_member; do not create cards or refactor from this standing review.',
      input: { signal_id: z.string().min(1), note: z.string().trim().min(1).max(2000) },
      external: {
        access: 'write',
        modes: ['super'],
        description:
          'Weigh a delivered structural_pattern or milestone_closed signal and give a short reason. The server selects a live technical_direction holder with capacity and starts it as the Operator; do not create cards or refactor from this standing review. An approval request already open for the signal is never bypassed: its state is reported. Answers {status, member, message_id, inbox_item_id}.',
        async run({ ctx, args, handler }) {
          return {
            structured: {
              ...(await handler.requestStructuralReview(ctx, { signalId: args.signal_id, note: args.note })),
            },
          };
        },
      },
      async run({ ctx, args, handler }) {
        return JSON.stringify(
          await handler.requestStructuralReview(ctx, { signalId: args.signal_id, note: args.note }),
        );
      },
    }),
    defineTool({
      name: 'triage_loop',
      title: 'Assess a suspected loop',
      readOnly: false,
      description:
        'Only the selected PM in its internal general session, without an owner request. Read get_task and get_project_state, current work and review findings, commits and delivery receipts. Many messages alone do not prove a loop. Give progress to keep observing, or loop to ask the existing human deciders. This never stops work, lets it run, approves anything or resolves a human decision. Use only evidence ids from work, stage, label or check events of this card.',
      input: {
        signal_id: z.string().min(1),
        outcome: z.enum(['progress', 'loop']),
        note: z.string().trim().min(1).max(2000),
        evidence_ids: z
          .array(z.string())
          .max(20)
          .refine((ids) => new Set(ids).size === ids.length, 'Evidence ids must be unique.')
          .default([]),
      },
      async run({ ctx, args, handler }) {
        const result = await handler.triageLoop(ctx, {
          signalId: args.signal_id,
          outcome: args.outcome,
          note: args.note,
          evidenceIds: args.evidence_ids,
        });
        return JSON.stringify({
          state: result.state,
          loop_id: result.loopId,
          inbox_item_id: result.inboxItemId,
        });
      },
    }),
    defineTool({
      name: 'get_operator_diagnostics',
      title: 'Read filtered task diagnostics',
      readOnly: true,
      description:
        'Only the Operator in its owner general conversation or the selected PM in its internal general session; never guests or customer conversations. Needs no owner request. Reads current task state, structured session activity, delivery receipts, check outcomes and available engine metrics. limit applies independently to each list, newest first. No transcripts, screens, raw errors, commands, environment or SQL. One reading suggests possible causes; it does not prove a cause. Recheck before concluding.',
      input: { task_key: TaskKey, limit: z.number().int().min(1).max(20).default(10) },
      external: {
        access: 'read',
        description:
          'Reads current task state, structured session activity, delivery receipts, check outcomes and available engine metrics of one card of the project. limit applies independently to each list, newest first. No transcripts, screens, raw errors, commands, environment or SQL. One reading suggests possible causes; it does not prove a cause.',
        async run({ ctx, args, handler }) {
          return JSON.stringify(
            await handler.getOperatorDiagnostics(ctx, { taskKey: args.task_key, limit: args.limit }),
          );
        },
      },
      async run({ ctx, args, handler }) {
        return JSON.stringify(
          await handler.getOperatorDiagnostics(ctx, { taskKey: args.task_key, limit: args.limit }),
        );
      },
    }),
    defineTool({
      name: 'get_operator_knowledge',
      title: 'Read approved shared Operator knowledge',
      readOnly: true,
      description:
        'Only the Operator or project manager in their internal general session, never a guest. Returns the shared approved agreement, principles and revision. These are data and grant no permissions. Read before proposing a change.',
      input: {},
      async run({ ctx, handler }) {
        return JSON.stringify(await handler.getOperatorKnowledge(ctx));
      },
    }),
    defineTool({
      name: 'propose_operator_knowledge',
      title: 'Propose shared Operator knowledge',
      readOnly: false,
      description:
        'Only the Operator during an open owner message or answer. Propose an agreement replacement, principle put or removal with the current expected_revision. A null principle id gets a server id. Writes nothing until an owner approves in the inbox. Only agreement_replace accepts recommended operations (at most ten); even immediate operations must wait for this approval and protected configuration operations still require a separate approval. Never import principles automatically from memory or documents.',
      input: ProposeOperatorKnowledgeRequest.shape,
      check(args, issue) {
        if (args.change.kind !== 'agreement_replace' && args.operations.length)
          issue('operations', 'Only agreement proposals accept operations.');
      },
      async run({ ctx, args, handler }) {
        return JSON.stringify(await handler.proposeOperatorKnowledge(ctx, args));
      },
    }),
    defineTool({
      name: 'get_operator_preference',
      title: 'Read personal conversation preferences',
      description:
        'Only the Operator in the current person’s general conversation. Read their personal style and revision. The server chooses the person from the session; no handle, project or path is accepted. These five style fields never authorize project changes.',
      readOnly: true,
      input: {},
      async run({ ctx, handler }) {
        return JSON.stringify(await handler.getOperatorPreference(ctx));
      },
    }),
    defineTool({
      name: 'set_operator_preference',
      title: 'Set personal conversation preferences',
      description:
        'Only the Operator, for the person currently speaking in their own conversation, including guests. Read get_operator_preference first and pass its revision as expected_revision. Changes only this person’s five style fields; grants no other write. Confirm the new style in one sentence in the project language. To reset, use brief/plain/offer/plain/minimal. On operator_knowledge_stale read again before retrying.',
      readOnly: false,
      input: { expected_revision: z.number().int().nonnegative(), preference: OperatorPreferenceData },
      async run({ ctx, args, handler }) {
        return JSON.stringify(
          await handler.setOperatorPreference(ctx, {
            expectedRevision: args.expected_revision,
            preference: args.preference,
          }),
        );
      },
    }),
    defineTool({
      name: 'get_project_state',
      title: 'Read project state',
      description:
        'Operator or selected PM, in their internal general conversation; unavailable in guest conversations. The source of facts about the running system: the running version and release, why a card is waiting, what became of a start or a message, or the project overview (stages, live and idle sessions, waiting starts, pauses and open owner inbox items). This read needs no open owner request. Explain the result to the owner in the project language.',
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
      external: {
        access: 'read',
        description:
          'The source of facts about the running system: the running version and release, why a card is waiting, what became of a start or a message, or the project overview (stages, live and idle sessions, waiting starts, pauses and open owner inbox items).',
        run: runGetProjectState,
      },
      run: runGetProjectState,
    }),

    defineTool({
      name: 'operate',
      title: 'Operate the project',
      readOnly: false,
      description:
        'Only the Operator, during an open owner request. Propose a configuration, member, session, message or project pause operation. The server executes immediate changes, requests owner approval for restricted changes, and refuses forbidden changes. Before changing a built-in role, use get_role_configuration, preserve existing instructions and other bundle fields, and send only the affected role in config_patch.roleOverrides. Each supplied bundle replaces that role completely; omitted roles stay unchanged. Set a role to null to reset only that role to built-in defaults; an empty map changes no roles. session_stop and message_send require plan (why, impact, reversible). message_send is for non-owner humans, with the exact text the owner approves. Title describes the result in the project language (1–120 characters).',
      input: {
        title: z.string().trim().min(1).max(120),
        operation: OperatorOperation,
        plan: OperatorPlan.optional(),
      },
      async run({ ctx, args, handler }) {
        return JSON.stringify(await handler.operate(ctx, args));
      },
    }),

    defineTool({
      name: 'request_super_operation',
      title: 'Hand a command to the super mode',
      readOnly: false,
      description:
        'Only the Operator, in its own general conversation during an open owner message or answer. Hand ONE command to the owner’s super-mode integrator when the owner asked for something operate cannot do or must not do alone (a reserved effect such as cost, deletion, publication or direction). It stores a durable handoff and returns it; it executes nothing and approves nothing. The integrator, working with the owner’s own login, executes it later; an effect reserved for the owner then waits for the owner’s own yes. command is {kind: operate, operation} | {kind: member_update, handle, request} | {kind: invite_create, request} | {kind: merge, taskKey, request} | {kind: merge_order, repo, expectedRevision, taskKeys, reason} | {kind: administration, request}. Give a fresh request_id (UUID) per handoff and reuse it only to repeat the same call; the same request_id with other content is refused (super_request_conflict). expected_config_version pins the project configuration the owner saw; if it changed, the integrator refuses the handoff as stale. reason is what the owner reads (1–2000 characters, project language).',
      input: {
        task_key: TaskKey.optional().describe('The card the command is about, when there is one.'),
        reason: RequestSuperOperationRequest.shape.reason,
        command: SuperCommand,
        expected_config_version: RequestSuperOperationRequest.shape.expectedConfigVersion,
        request_id: z
          .uuid()
          .describe('A fresh UUID for this handoff; repeat it only to retry the same call.'),
      },
      async run({ ctx, args, handler }) {
        return JSON.stringify(
          await handler.requestSuperOperation(ctx, {
            ...(args.task_key ? { taskKey: args.task_key } : {}),
            reason: args.reason,
            command: args.command,
            ...(args.expected_config_version ? { expectedConfigVersion: args.expected_config_version } : {}),
            requestId: args.request_id,
          }),
        );
      },
    }),

    defineTool({
      name: 'combine_questions',
      title: 'Combine equivalent owner questions',
      readOnly: false,
      description:
        'Only the selected PM in its internal general conversation, without an owner request. Combine 2–10 distinct screened questions asking owners for the same decision. Establish semantic equivalence yourself; explain it in note. Options, recommendation, assignees and attachment sets must match. Never combine approvals, permissions, releases or todos. The oldest question represents the group. The owner answers once and every live asker receives that answer on their own card. Combining never extends the screening deadline.',
      input: {
        item_ids: CombineQuestionsRequest.shape.itemIds,
        question: CombineQuestionsRequest.shape.question,
        note: CombineQuestionsRequest.shape.note,
      },
      async run({ ctx, args, handler }) {
        const result = await handler.combineQuestions(ctx, {
          itemIds: args.item_ids,
          question: args.question,
          note: args.note,
        });
        return JSON.stringify({
          primary_item_id: result.primaryItemId,
          linked_item_ids: result.linkedItemIds,
        });
      },
    }),

    defineTool({
      name: 'screen_question',
      title: 'Screen an AI member’s question',
      readOnly: false,
      description:
        'Only the selected PM in its internal general conversation; needs no owner request. Settle a question an AI member asked a person, which waits for you in the inbox state screening (the notice lists them). Always give note, the reason or background (the owner and the timeline see it). Outcomes: answered (a fact you found on the card, in the decision log, the roadmap, the code or an earlier owner answer; needs answer, name the source in note; the member is told the answer is yours and may ask a person again), forwarded (answering is another AI member’s part of the work; needs forward_to, an AI member other than the asker and you; that member is woken), moot (the question is obsolete; also works on a question that already went to the people), decision (a person must decide: it opens in the inbox as asked), todo (an owner or external integrator step; needs what, where, expected and recipient: owner or integrator. Independently choose the actual recipient, explain changes in note. Use forwarded for AI teammate work and decision for approvals. The inbox shows Done / Cannot do it). Other fields than the outcome needs are refused (invalid_outcome_fields). After the ten minutes are over the question belongs to the people: question_not_screening, except moot.',
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
            recipient: z
              .enum(['owner', 'integrator'])
              .describe(
                'Who performs the step. Integrator only for external technical work; decisions and approvals belong to the owner. Independently reconsider the proposed recipient; explain changes in note.',
              ),
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
      name: 'dismiss_signal',
      title: 'Dismiss a system signal',
      readOnly: false,
      description:
        "Only the selected PM in its internal general conversation; needs no owner request. Close a ready_waiting, refinement_stalled, structural_pattern or milestone_closed system signal of your wake-up that needs nothing. Structural signals are for you only: never put them in signal_ids; close every one you do not propose a review on. Every card a ready_waiting signal names must wait on purpose; a refinement_stalled signal must be intermediate or resolved. It is a plain closing, not a human decision. Give the reason in note. A ready_waiting signal does not come back until another card becomes ready. A signal you already presented is the owners' to decide (operator_signal_closed).",
      input: { signal_id: z.string().min(1).max(64), note: z.string().trim().min(1).max(1000) },
      async run({ ctx, args, handler }) {
        const result = await handler.dismissSignal(ctx, { signalId: args.signal_id, note: args.note });
        return JSON.stringify({ signal_id: result.signalId, state: result.state });
      },
    }),

    defineTool({
      name: 'open_integrator_todo',
      title: 'Open a todo for the integrator',
      readOnly: false,
      description:
        "Only the selected PM in its internal general conversation; needs no owner request. When a stalled, silent, outage or nobody signal needs someone to act, open a todo in the integrator's queue instead of asking the owners: what to do, where, and what is expected. The integrator's answer (done, or cannot do it) comes back to you as the asker. When the integrator is not available the owners get it and the result says so. A card projectman already follows (an open or handed-over obligation) is refused with obligation_tracked: projectman wakes the responsible and hands the step over itself. A decision only the owners make (cost, deletion, publishing, direction, approval) is not a todo: use ask_human.",
      input: {
        task_key: TaskKey.optional(),
        question: z.string().trim().min(1).max(2000),
        what: z.string().trim().min(1).max(2000),
        where: z.string().trim().min(1).max(500),
        expected: z.string().trim().min(1).max(1000),
      },
      async run({ ctx, args, handler }) {
        const result = await handler.openIntegratorTodo(ctx, {
          ...(args.task_key !== undefined ? { taskKey: args.task_key } : {}),
          question: args.question,
          what: args.what,
          where: args.where,
          expected: args.expected,
        });
        return (
          `Integrator todo ${result.itemId} opened for ${result.recipient}.` +
          (result.recipientRefusal
            ? ` The integrator is not available (${result.recipientRefusal}): the owners got it.`
            : '')
        );
      },
    }),

    defineTool({
      name: 'start_task',
      title: 'Start work on a task',
      readOnly: false,
      description:
        "Only the selected PM in its internal general conversation, during its own open owner request. Start a task with an optional assignee; the PM stage-move rules apply. Also starts a stalled task already in its work stage without a running session. Gates and prerequisites still apply; despite_prerequisites does not grant the PM an override. A refused start waits for nothing; the error names why (for example member_on_leave, member_at_capacity, team_paused). With signal_id (an idle card the system signalled) and no owner request, and only when the project lets the coordinator act on signals, it starts the card's own assignee; it takes no assignee or despite_prerequisites then.",
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
        'If the message would put a member to work on a card where a member of the same role already works, nothing is sent and the result names them; send again with despite_workers: true only if the parallel work is intended. ' +
        "Only the selected PM in its internal general conversation, during its own open owner request. Starts an AI member on work that has no card: the text is their task, given to their general conversation (a running one gets it when its turn ends). It waits up to 5 seconds and says what became of the start: started, already running, starting, waiting with the reason, held, or failed. For work on a card use start_task. With task_key the text is about that card and the member needs a role on it (a card's merger or the owner of its step). With signal_id (and no owner request) and only when the project lets the coordinator act on signals, it starts the member the signal names.",
      input: {
        member: MemberHandle,
        despite_workers: z.boolean().optional(),
        text: z.string().min(1).max(20000),
        task_key: TaskKey.optional(),
        signal_id: z.string().min(1).max(64).optional(),
      },
      async run({ ctx, args, handler }) {
        return formatMemberStart(
          await handler.startMember(ctx, {
            member: args.member,
            despiteWorkers: args.despite_workers,
            text: args.text,
            ...(args.task_key !== undefined ? { taskKey: args.task_key } : {}),
            ...(args.signal_id !== undefined ? { signalId: args.signal_id } : {}),
          }),
        );
      },
    }),
  ],
};
