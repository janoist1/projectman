import {
  MemberHandle,
  BuiltInRoleId,
  CHECKLIST_ITEM_STATES,
  ChecklistCondition,
  CombineQuestionsRequest,
  OperatorOperation,
  OperatorPreferenceData,
  ProposeOperatorKnowledgeRequest,
  OperatorPlan,
  GetSuperOperationArgs,
  SuperCommand,
  TaskKey,
} from '@projectman/shared';
import { z } from 'zod';
import { TeamToolError } from '../../contracts';
import type { MessageStateReport, ProjectStateReport, TaskStateReport } from '../../contracts';
import { formatMemberStart, formatProjectState } from '../format';
import { defineTool, type TeamToolGroup } from '../kit';

/** The guide topic that lists the fields of every operation and command kind (generated from the schemas). */
const OPERATIONS_GUIDE = 'get_guide with topic "operations"';

/**
 * The MCP input of a discriminated union keeps only its tag, so the tool description stays short (PM-1034);
 * the fields pass through and `parseFull` checks them against the whole schema in `run`.
 */
function kindInput(key: string, options: readonly z.ZodObject[], what: string) {
  const kinds = options.map((option) => (option.shape[key] as z.ZodLiteral<string>).value);
  return z
    .looseObject({
      [key]: z.enum(kinds as [string, ...string[]]),
    })
    .describe(`${what}: ${key} plus its fields; the fields of each ${key} are in ${OPERATIONS_GUIDE}.`);
}

/** The full check behind `kindInput`: a refusal names the zod path of each faulty field and the guide topic. */
function parseFull<T>(schema: z.ZodType<T>, value: unknown, parameter: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const faults = parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${[parameter, ...issue.path].map(String).join('.')}: ${issue.message}`);
  throw new TeamToolError('invalid', `${faults.join('; ')}. The fields of each kind: ${OPERATIONS_GUIDE}.`);
}

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
      audience: { roles: ['project_manager'] },
      title: 'Read one built-in role configuration',
      readOnly: true,
      description:
        'Only the Operator or selected PM in its own general conversation during an open owner request, never guests. Returns the configuration version, the stored override (null when absent), and the effective full role bundle. Read before editing a role; preserve its existing instructions and other bundle fields.',
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
      audience: { roles: ['project_manager'] },
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
      audience: { roles: ['project_manager'] },
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
      audience: { roles: ['project_manager'] },
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
      name: 'get_checklist',
      audience: { roles: ['project_manager'] },
      title: 'Read the project startup checklist',
      readOnly: true,
      description:
        'Only the Operator or the project manager in their internal general session, never a guest. Needs no owner request. Returns the startup checklist (items with state, reason, condition and whether the condition holds now; progress; the base template) and, for each template, the item ids it would add. When there is no list yet, the answer says so; create it with update_checklist op init.',
      input: {},
      async run({ ctx, handler }) {
        const view = await handler.getChecklist(ctx);
        return view.checklist
          ? JSON.stringify(view)
          : `There is no checklist for this project yet. Templates and the item ids they add: ${JSON.stringify(view.templates)}`;
      },
    }),
    defineTool({
      name: 'update_checklist',
      audience: { roles: ['project_manager'] },
      title: 'Change the project startup checklist',
      readOnly: false,
      description:
        'Only the Operator or the selected project manager in their internal general session, never a guest; it is your own tool, so it needs no owner request. One operation per call. init: create the base list for a project that has none. add: a new item (title, optional hint and condition); the server gives it a custom_<n> id. edit: item_id with a new title and/or hint. set_condition: item_id and condition (null takes it off); a done item can get only a condition that holds. set_state: item_id and state open, done or not_needed; not_needed always needs a reason, and done is refused while the item condition does not hold (checklist_condition_unmet). apply_template: template_id adds the template items the list does not have yet and sets the base template; it deletes and overwrites nothing. Nothing is deleted: to override the owner, apply another template or set items to not_needed with a reason. The system, not you, keeps the rule that a conditional item is done only while its condition holds.',
      input: {
        op: z.enum(['init', 'add', 'edit', 'set_condition', 'set_state', 'apply_template']),
        item_id: z
          .string()
          .regex(/^[a-z][a-z0-9_]{0,39}$/)
          .optional(),
        title: z.string().trim().min(1).max(120).optional(),
        hint: z.string().max(500).nullable().optional(),
        condition: ChecklistCondition.nullable().optional(),
        state: z.enum(CHECKLIST_ITEM_STATES).optional(),
        reason: z.string().trim().min(1).max(500).optional(),
        template_id: z.string().min(1).max(64).optional(),
      },
      check(args, issue) {
        const need = (field: keyof typeof args, name: string) => {
          if (args[field] === undefined) issue(name, `${name} is required for op ${args.op}.`);
        };
        if (args.op === 'add') need('title', 'title');
        if (args.op === 'edit') {
          need('item_id', 'item_id');
          if (args.title === undefined && args.hint === undefined)
            issue('title', 'edit needs a title and/or a hint.');
        }
        if (args.op === 'set_condition') {
          need('item_id', 'item_id');
          need('condition', 'condition');
        }
        if (args.op === 'set_state') {
          need('item_id', 'item_id');
          need('state', 'state');
          if (args.state === 'not_needed') need('reason', 'reason');
        }
        if (args.op === 'apply_template') need('template_id', 'template_id');
      },
      async run({ ctx, args, handler }) {
        return JSON.stringify(
          await handler.updateChecklist(ctx, {
            op: args.op,
            ...(args.item_id !== undefined ? { itemId: args.item_id } : {}),
            ...(args.title !== undefined ? { title: args.title } : {}),
            ...(args.hint !== undefined ? { hint: args.hint } : {}),
            ...(args.condition !== undefined ? { condition: args.condition } : {}),
            ...(args.state !== undefined ? { state: args.state } : {}),
            ...(args.reason !== undefined ? { reason: args.reason } : {}),
            ...(args.template_id !== undefined ? { templateId: args.template_id } : {}),
          }),
        );
      },
    }),
    defineTool({
      name: 'get_operator_knowledge',
      audience: { roles: ['project_manager'] },
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
      audience: { roles: ['project_manager'] },
      title: 'Propose shared Operator knowledge',
      readOnly: false,
      description:
        'The Operator, or the selected project manager in its internal general session, during an open owner message or answer. Propose an agreement replacement, principle put or removal with the current expected_revision. A null principle id gets a server id. Writes nothing until an owner approves in the inbox. Only the Operator’s agreement_replace accepts recommended operations (at most ten); even immediate operations must wait for this approval and protected configuration operations still require a separate approval. Never import principles automatically from memory or documents.',
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
      audience: { roles: ['project_manager'] },
      title: 'Read personal conversation preferences',
      description:
        'The Operator in the current person’s general conversation, or the selected active PM with an open direct owner message/answer in its internal general session. Read their personal style and revision. The server chooses the person; no handle, project or path is accepted. These five style fields never authorize project changes.',
      readOnly: true,
      input: {},
      async run({ ctx, handler }) {
        return JSON.stringify(await handler.getOperatorPreference(ctx));
      },
    }),
    defineTool({
      name: 'set_operator_preference',
      audience: { roles: ['project_manager'] },
      title: 'Set personal conversation preferences',
      description:
        'The Operator for the person currently speaking in their own conversation, including guests, or the selected active PM with an open direct owner message/answer in its internal general session. Learn only from explicit style requests or corrections. Read get_operator_preference first and pass its revision as expected_revision. Changes only this person’s five style fields; grants no other write. Confirm the new style in one sentence in the project language. To reset, use brief/plain/offer/plain/minimal. On operator_knowledge_stale read again before retrying.',
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
      audience: { roles: ['project_manager'] },
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
      audience: { roles: ['project_manager'] },
      title: 'Operate the project',
      readOnly: false,
      description:
        'Only the Operator or selected PM, in its own general conversation during an open owner request. The PM uses the shared operation path in its own name; K3 effects wait for the owner. Propose a configuration, member, session, message or project pause operation. The server executes immediate changes, requests owner approval for restricted changes, and refuses forbidden changes. Before changing a built-in role, use get_role_configuration, preserve existing instructions and other bundle fields, and send only the affected role in config_patch.roleOverrides. Each supplied bundle replaces that role completely; omitted roles stay unchanged. Set a role to null to reset only that role to built-in defaults; an empty map changes no roles. To add or change one pipeline label (name, color, meaning) send only that label in config_patch.labels, keyed by label id, e.g. {"bug": {"color": "red"}}; omitted fields and all other labels, stages and columns stay unchanged, and null removes the color or meaning. session_stop and message_send require plan (why, impact, reversible). message_send is for non-owner humans, with the exact text the owner approves. Title describes the result in the project language (1–120 characters).',
      input: {
        title: z.string().trim().min(1).max(120),
        operation: kindInput('op', OperatorOperation.options, 'The operation'),
        plan: OperatorPlan.optional(),
      },
      async run({ ctx, args, handler }) {
        const operation = parseFull(OperatorOperation, args.operation, 'operation');
        return JSON.stringify(await handler.operate(ctx, { ...args, operation }));
      },
    }),

    defineTool({
      name: 'execute_operation',
      audience: { roles: ['project_manager'] },
      title: 'Execute one command as the Operator or PM',
      readOnly: false,
      description:
        'Only the Operator or selected PM, in its own general conversation during an open owner message or answer. The PM may use task_create, task_update, task_labels, task_start, task_cancel, member_update, merge_order and operate. Every other kind, including administration, is refused with command_not_for_project_manager; with machine access enabled use open_integrator_todo for the integrator, otherwise ask the owners with ask_human. Starts ONE command on the shared operation path, logged as you: {operation}. command is {kind, ...fields of that kind}. workspace_release frees the workspace an unresolved process cleanup keeps reserved without proof that the processes stopped: only on the owner’s explicit request in that conversation, never on a signal by itself; reason is the owner’s stated reason. workspace_release, inbox_resolve, merge, merge_order and invite_create run only when the open request is an owner’s own message or answer; for a queue item or another member’s message the server refuses them (operator_owner_only), so ask the owners with ask_human. On a member’s request task_labels runs with your own label rights: approval and human-only labels are refused. Use operate for configuration, member, session, message and project-pause changes. For the Operator, kinds operate and member_update are refused here with super_operation_unsupported. A K3 effect (deletion, security, cost and permission decisions) is not run: the operation waits in waiting_owner and the owner answers with their own login; after the owner’s yes the server runs it by itself, so do not repeat the call. Only the Operator may request machine operations (administration), which need the owner’s grant: without one the call fails with operator_grant_inactive, and you hand the matter over to the owner. request_key (1–100 characters of A-Z a-z 0-9 . _ -) names this call within the request: the same key is the same operation and never runs twice; the same key with another command is refused (super_request_conflict). Follow it with get_operation until the state is final.',
      input: {
        request_key: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[A-Za-z0-9._-]+$/)
          .describe('Names this call within the open request; repeat it only to retry the same call.'),
        task_key: TaskKey.optional().describe('The card the command is about, when there is one.'),
        command: kindInput('kind', SuperCommand.options, 'The command'),
      },
      async run({ ctx, args, handler }) {
        const command = parseFull(SuperCommand, args.command, 'command');
        return JSON.stringify(
          await handler.executeOperation(ctx, {
            requestKey: args.request_key,
            ...(args.task_key ? { taskKey: args.task_key } : {}),
            command,
          }),
        );
      },
    }),

    defineTool({
      name: 'get_operation',
      audience: { roles: ['project_manager'] },
      title: 'Read an operation',
      readOnly: true,
      description:
        'Only the Operator or selected PM, in its own general conversation during an open owner request. One operation of this project and, once the adapter recorded it, its result: {operation, result}. A running operation is settled first, so ask again until its state is final.',
      input: { operation_id: GetSuperOperationArgs.shape.operation_id },
      async run({ ctx, args, handler }) {
        return JSON.stringify(await handler.getOperation(ctx, { operationId: args.operation_id }));
      },
    }),

    defineTool({
      name: 'combine_questions',
      audience: { roles: ['project_manager'] },
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
      audience: { roles: ['project_manager'] },
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
        feedback_id: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('The system feedback id returned by record_system_feedback; only with todo.'),
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
        if (args.feedback_id !== undefined && args.outcome !== 'todo')
          issue('feedback_id', 'invalid_outcome_fields: feedback_id goes only with todo.');
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
            ...(args.feedback_id !== undefined ? { feedbackId: args.feedback_id } : {}),
          }),
        );
      },
    }),

    defineTool({
      name: 'dismiss_signal',
      audience: { roles: ['project_manager'] },
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
      audience: { capabilities: ['machine_access'] },
      title: 'Open a todo for the integrator',
      readOnly: false,
      description:
        "Only for a member with machine access (an owner switches it on); needs no owner request. Put machine work (an installation, a setting) in the owners' queue: what to do, where, and what is expected. The owner's connected Claude takes the todos from the queue one at a time; use this tool, not a message, for a step that needs its hands. Its answer (done, or handed to the owners with the reason) comes back to you as the asker. When the integrator is not available the owners get it and the result says so. For the project manager: when a stalled, silent, outage or nobody signal needs someone to act, open a todo instead of asking the owners; a card projectman already follows (an open or handed-over obligation) is refused with obligation_tracked, because projectman wakes the responsible and hands the step over itself. A decision only the owners make (cost, deletion, publishing, direction, approval) is not a todo: use ask_human.",
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
      audience: { roles: ['project_manager'] },
      title: 'Start work on a task',
      readOnly: false,
      description:
        "Only the selected PM in its internal general conversation, during its own open owner request. Start a task with an optional assignee; the PM stage-move rules apply. Also starts a stalled task already in its work stage without a running session. Gates and prerequisites still apply; despite_prerequisites is honored only when the project settings let the PM override prerequisites (team.prerequisiteOverride). A refused start waits for nothing; the error names why (for example member_on_leave, member_at_capacity, team_paused). With signal_id (an idle card the system signalled) and no owner request, and only when the project lets the coordinator act on signals, it starts the card's own assignee; it takes no assignee or despite_prerequisites then.",
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
      name: 'reassign_task',
      audience: { roles: ['project_manager'] },
      title: 'Reassign a task',
      readOnly: false,
      description:
        "Only the selected PM in its internal general conversation; needs no owner request. Change a card's assignee (null clears it) and give the reason: it is on the card's timeline under your name. On a started card the old assignee hands its work over (a note first), as for a person's reassignment. The member must exist and not be on leave; a closed card or a theme is refused. This does not start work: use start_task for that. Only when the project settings let the PM reassign cards (otherwise project_manager_lifecycle_refused).",
      input: {
        task_key: TaskKey,
        assignee: MemberHandle.nullable(),
        reason: z.string().trim().min(1).max(500),
      },
      async run({ ctx, args, handler }) {
        return JSON.stringify(
          await handler.reassignTask(ctx, {
            taskKey: args.task_key,
            assignee: args.assignee,
            reason: args.reason,
          }),
        );
      },
    }),

    defineTool({
      name: 'cancel_task',
      audience: { roles: ['project_manager'] },
      title: 'Cancel a task',
      readOnly: false,
      description:
        "Only the selected PM in its internal general conversation; needs no owner request. Close a card as cancelled (its sessions stop; assignee, stage and files stay) and give the reason: it is on the card's timeline under your name. A closed card or a theme is refused. Deleting a card stays with the owners. Only when the project settings let the PM cancel cards (otherwise project_manager_lifecycle_refused); the same right lets you mark a started card as a duplicate (duplicate_of).",
      input: { task_key: TaskKey, reason: z.string().trim().min(1).max(500) },
      async run({ ctx, args, handler }) {
        return JSON.stringify(await handler.cancelTask(ctx, { taskKey: args.task_key, reason: args.reason }));
      },
    }),

    defineTool({
      name: 'reopen_task',
      audience: { roles: ['project_manager'] },
      title: 'Reopen a cancelled task',
      readOnly: false,
      description:
        'Only the selected PM in its internal general conversation, and only when the project settings let it reopen cards (otherwise project_manager_lifecycle_refused). Reopens a cancelled card in its stage with no assignee; the reason is on the timeline under your name. A theme or an open card is refused. Starting work stays explicit: start_task.',
      input: { task_key: TaskKey, reason: z.string().trim().min(1).max(500) },
      async run({ ctx, args, handler }) {
        return JSON.stringify(await handler.reopenTask(ctx, { taskKey: args.task_key, reason: args.reason }));
      },
    }),

    defineTool({
      name: 'start_member',
      audience: { roles: ['project_manager'] },
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
