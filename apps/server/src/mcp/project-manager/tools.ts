import {
  MemberHandle,
  BuiltInRoleId,
  CHECKLIST_ITEM_STATES,
  ChecklistCondition,
  CONVERSATION_REFRESH_NOTE_MAX,
  coordinatorOnlySignalKindsText,
  CombineQuestionsRequest,
  ProjectManagerOperation,
  ProjectManagerPreferenceData,
  ProposeProjectManagerKnowledgeRequest,
  ProjectManagerPlan,
  GetSuperOperationArgs,
  NewSuperCommand,
  TaskKey,
} from '@projectman/shared';
import { z } from 'zod';
import { TeamToolError } from '../../contracts';
import type { MessageStateReport, ProjectStateReport, TaskStateReport } from '../../contracts';
import { formatInvolvement, formatMemberStart, formatProjectState } from '../format';
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

export const PROJECT_MANAGER_TOOL_GROUP: TeamToolGroup = {
  module: 'services/coordination',
  tools: [
    defineTool({
      name: 'get_role_configuration',
      audience: { roles: ['project_manager'] },
      title: 'Read one built-in role configuration',
      readOnly: true,
      description:
        "Read one built-in role's configuration version, stored override (null when absent) and effective full " +
        'bundle, in your own general conversation (no owner request needed). Read it before editing a ' +
        'role; preserve its existing instructions and other bundle fields.',
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
        'Request an occasional architecture review on a delivered structural_pattern or milestone_closed ' +
        'signal; the server starts a technical_direction holder. Without your own open owner request it only ' +
        'proposes an owner approval: on approval call again with the same signal_id. Steps: role guide.',
      input: {
        signal_id: z.string().min(1),
        note: z.string().trim().min(1).max(2000).describe('Your short reason, after weighing the signal.'),
      },
      external: {
        access: 'write',
        modes: ['super'],
        description:
          'Weigh a delivered structural_pattern or milestone_closed signal and give a short reason. The server selects a live technical_direction holder with capacity and starts it as the project manager; do not create cards or refactor from this standing review. An approval request already open for the signal is never bypassed: its state is reported. Answers {status, member, message_id, inbox_item_id}.',
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
        'Assess a loop_suspected signal after reading the evidence (role guide): progress keeps observing, ' +
        'loop asks the existing human deciders. Many messages alone do not prove a loop. It never stops ' +
        'work, lets it run, approves anything or resolves a human decision.',
      input: {
        signal_id: z.string().min(1),
        outcome: z.enum(['progress', 'loop']),
        note: z.string().trim().min(1).max(2000),
        evidence_ids: z
          .array(z.string())
          .max(20)
          .refine((ids) => new Set(ids).size === ids.length, 'Evidence ids must be unique.')
          .default([])
          .describe('Only ids of work, stage, label or check events of this card.'),
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
      name: 'save_handover',
      audience: { roles: ['project_manager'] },
      title: 'Save a note for the next conversation',
      readOnly: false,
      description:
        'Answer the system message that asks for a handover note before your long general conversation continues ' +
        'in a fresh one: what you are doing, promised, must watch. Call it once, nothing else in that turn. ' +
        'Only while a note is asked for (saved: false otherwise).',
      input: {
        note: z.string().trim().min(1).max(CONVERSATION_REFRESH_NOTE_MAX),
      },
      async run({ ctx, args, handler }) {
        return JSON.stringify(await handler.saveHandover(ctx, { note: args.note }));
      },
    }),
    defineTool({
      name: 'get_operator_diagnostics',
      audience: { roles: ['project_manager'] },
      title: 'Read filtered task diagnostics',
      readOnly: true,
      description:
        "Read one card's current state, structured session activity, delivery receipts, check outcomes and " +
        'engine metrics; no transcripts, screens, raw errors, commands, environment or SQL. One reading ' +
        'suggests possible causes but proves none: recheck before concluding.',
      input: {
        task_key: TaskKey,
        limit: z.number().int().min(1).max(20).default(10).describe('Per list, newest first.'),
      },
      external: {
        access: 'read',
        description:
          'Reads current task state, structured session activity, delivery receipts, check outcomes and available engine metrics of one card of the project. limit applies independently to each list, newest first. No transcripts, screens, raw errors, commands, environment or SQL. One reading suggests possible causes; it does not prove a cause.',
        async run({ ctx, args, handler }) {
          return JSON.stringify(
            await handler.getProjectManagerDiagnostics(ctx, { taskKey: args.task_key, limit: args.limit }),
          );
        },
      },
      async run({ ctx, args, handler }) {
        return JSON.stringify(
          await handler.getProjectManagerDiagnostics(ctx, { taskKey: args.task_key, limit: args.limit }),
        );
      },
    }),
    defineTool({
      name: 'get_checklist',
      audience: { roles: ['project_manager'] },
      title: 'Read the project startup checklist',
      readOnly: true,
      description:
        'Read the startup checklist (items with state, reason, condition and whether it holds now; progress; ' +
        'the base template) and the item ids each template would add. Without a list the answer says so: ' +
        'create it with update_checklist op init. Needs no owner request.',
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
        'Change the startup checklist, one op per call; your own tool, so no owner request is needed. Nothing ' +
        'is deleted: to override the owner, apply another template or set items to not_needed with a reason. ' +
        'The system keeps a conditional item done only while its condition holds.',
      input: {
        op: z
          .enum(['init', 'add', 'edit', 'set_condition', 'set_state', 'apply_template'])
          .describe(
            'init: the base list of a project that has none. add: a new item (title, optional hint and ' +
              'condition; its id is custom_<n>). edit: item_id with a new title and/or hint. set_condition: ' +
              'item_id and condition. set_state: item_id and state. apply_template: template_id adds the ' +
              'template items the list lacks and sets the base template; it overwrites nothing.',
          ),
        item_id: z
          .string()
          .regex(/^[a-z][a-z0-9_]{0,39}$/)
          .optional(),
        title: z.string().trim().min(1).max(120).optional(),
        hint: z.string().max(500).nullable().optional(),
        condition: ChecklistCondition.nullable()
          .optional()
          .describe('null takes it off; a done item can get only a condition that holds.'),
        state: z
          .enum(CHECKLIST_ITEM_STATES)
          .optional()
          .describe('done is refused while the item condition does not hold (checklist_condition_unmet).'),
        reason: z.string().trim().min(1).max(500).optional().describe('Required with state not_needed.'),
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
        return JSON.stringify(await handler.getProjectManagerKnowledge(ctx));
      },
    }),
    defineTool({
      name: 'propose_operator_knowledge',
      audience: { roles: ['project_manager'] },
      title: 'Propose shared Operator knowledge',
      readOnly: false,
      description:
        'During an open owner message or answer, propose an agreement replacement or a principle put or ' +
        'removal with the current expected_revision. Writes nothing until an owner approves in the inbox. ' +
        'What a setting can express (gate, label, permission, priority, limit) goes to operate instead.',
      input: {
        expected_revision: ProposeProjectManagerKnowledgeRequest.shape.expected_revision,
        title: ProposeProjectManagerKnowledgeRequest.shape.title,
        change: ProposeProjectManagerKnowledgeRequest.shape.change.describe(
          'A null principle id gets a server id. Propose a rule only after a repeated failure and name the ' +
            'cards in its reason; refer to a duty or role, not a member name. Never import principles ' +
            'automatically from memory or documents.',
        ),
      },
      async run({ ctx, args, handler }) {
        return JSON.stringify(await handler.proposeProjectManagerKnowledge(ctx, { ...args, operations: [] }));
      },
    }),
    defineTool({
      name: 'get_operator_preference',
      audience: { roles: ['project_manager'] },
      title: 'Read personal conversation preferences',
      description:
        'Read the current person’s five personal style fields and revision (the Operator in their ' +
        'conversation, or the PM on an open direct owner message or answer). The server chooses the person; ' +
        'no handle, project or path is accepted. The fields never authorize project changes.',
      readOnly: true,
      input: {},
      async run({ ctx, handler }) {
        return JSON.stringify(await handler.getProjectManagerPreference(ctx));
      },
    }),
    defineTool({
      name: 'set_operator_preference',
      audience: { roles: ['project_manager'] },
      title: 'Set personal conversation preferences',
      description:
        'Change only the current person’s five style fields, learned only from their explicit style requests ' +
        'or corrections; grants no other write. Confirm the new style in one sentence in the project ' +
        'language. To reset, use brief/plain/offer/plain/minimal.',
      readOnly: false,
      input: {
        expected_revision: z
          .number()
          .int()
          .nonnegative()
          .describe(
            'The revision get_operator_preference returned; on operator_knowledge_stale read it again.',
          ),
        preference: ProjectManagerPreferenceData,
      },
      async run({ ctx, args, handler }) {
        return JSON.stringify(
          await handler.setProjectManagerPreference(ctx, {
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
        'The source of facts about the running system: running version and release, why a card waits, what ' +
        'became of a start or a message, or the overview (stages, sessions, waiting starts, pauses, open owner ' +
        'inbox items). Needs no owner request; explain the result in the project language.',
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
        'Propose a configuration, member, session, message or pause operation on your own authority (an owner ' +
        'request only under owner_request). Immediate changes run, restricted ones ask the owner, forbidden ' +
        `ones are refused. Rules and fields: ${OPERATIONS_GUIDE}.`,
      input: {
        title: z.string().trim().min(1).max(120).describe('The result, in the project language.'),
        operation: kindInput('op', ProjectManagerOperation.options, 'The operation'),
        plan: ProjectManagerPlan.optional().describe('Required for session_stop and message_send.'),
      },
      async run({ ctx, args, handler }) {
        const operation = parseFull(ProjectManagerOperation, args.operation, 'operation');
        return JSON.stringify(await handler.operate(ctx, { ...args, operation }));
      },
    }),

    defineTool({
      name: 'execute_operation',
      audience: { roles: ['project_manager'] },
      title: 'Execute one command as the Operator or PM',
      readOnly: false,
      description:
        'Start ONE command on the shared operation path, as you, on your own authority (merge and ' +
        'other owner commands need an owner request); follow it with get_operation until final. A K3 effect ' +
        `waits for the owner, then runs by itself: do not repeat it. Kinds, fields: ${OPERATIONS_GUIDE}.`,
      input: {
        request_key: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[A-Za-z0-9._-]+$/)
          .describe(
            'Names this call within the open request: the same key is the same operation and never runs ' +
              'twice; repeat it only to retry the same call (with another command: super_request_conflict).',
          ),
        task_key: TaskKey.optional().describe('The card the command is about, when there is one.'),
        command: kindInput('kind', NewSuperCommand.options, 'The command'),
      },
      async run({ ctx, args, handler }) {
        const command = parseFull(NewSuperCommand, args.command, 'command');
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
        'Only the Operator or selected PM, in its own general conversation (no owner request needed). One operation of this project and, once the adapter recorded it, its result: {operation, result}. A running operation is settled first, so ask again until its state is final.',
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
        'Combine 2–10 screened questions that ask the owners for the same decision; explain the equivalence ' +
        'in note. Never combine approvals, permissions, releases or todos. The oldest represents the group: ' +
        'the owner answers once and every live asker gets the answer. Rules: role guide.',
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
        'Settle a question an AI member asked a person that waits for you in screening (the notice lists ' +
        'them). When to choose which outcome: role guide. After the ten minutes the question belongs to the ' +
        'people (question_not_screening), except for moot.',
      input: {
        item_id: z.string().min(1).max(100).describe('The question’s inbox item id from the notice.'),
        outcome: z
          .enum(['answered', 'forwarded', 'moot', 'decision', 'todo'])
          .describe(
            'answered: a fact you found (needs answer; the member may ask a person again). forwarded: another ' +
              'AI member’s work, a technical choice to the notice’s technicalDecider (needs forward_to). moot: ' +
              'obsolete, also after it went to the people. decision: only an owner decision under an owner ' +
              "topic, as asked (needs owner_topic). todo: a machine or manual step, the integrator's when there is one (needs todo). Fields " +
              'another outcome needs are refused (invalid_outcome_fields).',
          ),
        note: z
          .string()
          .trim()
          .min(1)
          .max(2000)
          .describe('Why, or the source of the answer; the owner and the timeline see it. Always required.'),
        answer: z.string().trim().min(1).max(10000).optional().describe('The answer; only with answered.'),
        forward_to: MemberHandle.optional().describe(
          'The AI member to pass the question to, not the asker or you; it is woken. Only with forwarded.',
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
                'Optional and not decisive: a todo goes to the integrator whenever there is one (machine or manual step alike). Only when none can take it does it fall back to the technical decider or the owner.',
              )
              .optional(),
          })
          .optional()
          .describe('The exact step for a person; only with todo.'),
        owner_topic: z
          .string()
          .trim()
          .min(1)
          .max(40)
          .optional()
          .describe(
            "The id of the project's owner topic (role guide) the decision falls under; " +
              'an approval question needs none. Only with decision; with todo it is accepted but not recorded.',
          ),
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
        // A todo accepts owner_topic and ignores it (PM-1243), so an older call does not fail.
        if (args.owner_topic !== undefined && args.outcome !== 'decision' && args.outcome !== 'todo')
          issue(
            'owner_topic',
            'invalid_outcome_fields: owner_topic goes only with decision (todo ignores it).',
          );
      },
      async run({ ctx, args, handler }) {
        const result = await handler.screenQuestion(ctx, {
          itemId: args.item_id,
          outcome: args.outcome,
          note: args.note,
          ...(args.answer !== undefined ? { answer: args.answer } : {}),
          ...(args.forward_to !== undefined ? { forwardTo: args.forward_to } : {}),
          ...(args.todo ? { todo: { ...args.todo, recipient: args.todo.recipient ?? 'integrator' } } : {}),
          ...(args.feedback_id !== undefined ? { feedbackId: args.feedback_id } : {}),
          ...(args.owner_topic !== undefined ? { ownerTopic: args.owner_topic } : {}),
        });
        return JSON.stringify(
          result.forwardedTo
            ? {
                ...result,
                message: `The asker has no machine access to put a todo in the integrator's queue: it went to \`${result.forwardedTo}\`, who decides whether it is needed and asks the owners if they must act.`,
              }
            : result,
        );
      },
    }),

    defineTool({
      name: 'dismiss_signal',
      audience: { roles: ['project_manager'] },
      title: 'Dismiss a system signal',
      readOnly: false,
      description:
        `Close an obligation_overdue or relation_check signal, or one of ${coordinatorOnlySignalKindsText()}, ` +
        'of your wake-up with the reason in note: a plain closing, not a human decision. When: role guide. ' +
        "A signal you already presented is the owners' to decide.",
      input: { signal_id: z.string().min(1).max(64), note: z.string().trim().min(1).max(1000) },
      async run({ ctx, args, handler }) {
        const result = await handler.dismissSignal(ctx, { signalId: args.signal_id, note: args.note });
        return JSON.stringify({ signal_id: result.signalId, state: result.state });
      },
    }),

    defineTool({
      name: 'decide_senior_wait',
      audience: { roles: ['project_manager'] },
      title: 'Decide how a card that waits for a Senior goes on',
      readOnly: false,
      description:
        'Decide a card a senior_wait signal names: wait keeps waiting for the Senior, any lets a free ' +
        'developer take it. The reason goes to the card. Only the project manager may call it; if the ' +
        'choice costs money, ask the owners first (topic cost).',
      input: {
        task_key: TaskKey,
        decision: z.enum(['wait', 'any']),
        reason: z.string().trim().min(1).max(2000),
      },
      async run({ ctx, args, handler }) {
        const result = await handler.decideSeniorWait(ctx, {
          taskKey: args.task_key,
          decision: args.decision,
          reason: args.reason,
        });
        return JSON.stringify({ task_key: result.taskKey, decision: result.decision });
      },
    }),

    defineTool({
      name: 'open_integrator_todo',
      audience: { capabilities: ['machine_access'] },
      title: 'Open a todo for the integrator',
      readOnly: false,
      description:
        "Queue a todo for the owner's connected client: anything it can do on the owner's machine or with " +
        "the owner's accounts (an install, a setting, an email, a calendar). The question field holds why " +
        'it is needed. The answer comes back to you. A decision is not a todo: use ask_human.',
      input: {
        task_key: TaskKey.optional().describe(
          'A card projectman already follows (an open or handed-over obligation) is refused with ' +
            'obligation_tracked: projectman hands that step over itself.',
        ),
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
        return `Integrator todo ${result.itemId} opened in the integrator's queue.`;
      },
    }),

    defineTool({
      name: 'start_task',
      audience: { roles: ['project_manager'] },
      title: 'Start work on a task',
      readOnly: false,
      description:
        'Start a task on your own authority (an owner request only under owner_request) or on a signal_id; ' +
        'also restarts a stalled card in its work stage. Gates, prerequisites and the PM stage-move rules ' +
        'apply. A refused start waits for nothing; the error names why (e.g. member_at_capacity, assignee_unfit).',
      input: {
        task_key: TaskKey,
        assignee: MemberHandle.optional().describe(
          "Name one only when you must: the system's choice keeps the member's complexity limit, and with " +
            'team.assigneeFit an assignee beyond the limit or specialty is refused (assignee_unfit). Score a ' +
            'hard card first, or ask the scorer.',
        ),
        despite_prerequisites: z
          .boolean()
          .optional()
          .describe('Honored only when the project settings let the PM override prerequisites.'),
        signal_id: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe(
            "An overdue-obligation signal on a card, when the project lets you act on signals: starts the card's " +
              'own assignee, without an owner request; no assignee or despite_prerequisites then.',
          ),
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
        "Change a card's assignee (null clears it), with a reason on its timeline under your name; on a " +
        'started card the old assignee hands over first. Closed cards, themes and members on leave are refused. ' +
        'Starts no work (start_task). Only if the project settings let the PM reassign cards.',
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
        'Close a card as cancelled (sessions stop; assignee, stage and files stay), with a reason on its ' +
        'timeline under your name. Closed cards and themes are refused; deleting stays with the owners. Only ' +
        'if the project settings let the PM cancel cards; that also allows marking a duplicate (duplicate_of).',
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
        'Reopen a cancelled card in its stage with no assignee; the reason is on the timeline under your name. ' +
        'Themes and open cards are refused; start work explicitly with start_task. Only if the project ' +
        'settings let the PM reopen cards (otherwise project_manager_lifecycle_refused).',
      input: { task_key: TaskKey, reason: z.string().trim().min(1).max(500) },
      async run({ ctx, args, handler }) {
        return JSON.stringify(await handler.reopenTask(ctx, { taskKey: args.task_key, reason: args.reason }));
      },
    }),

    defineTool({
      name: 'involve_member',
      audience: { roles: ['project_manager'] },
      title: 'Involve a member on a card',
      readOnly: false,
      description:
        'Give an AI member a role on a card: messages to them about it start their session, and one that ' +
        'waited for lack of a role starts at once. Needs the project setting (else member_involvement_refused). ' +
        'No label or approval right. Reason goes on the timeline.',
      input: { task_key: TaskKey, member: MemberHandle, reason: z.string().trim().min(1).max(500) },
      async run({ ctx, args, handler }) {
        return formatInvolvement(
          await handler.involveMember(ctx, {
            taskKey: args.task_key,
            member: args.member,
            reason: args.reason,
          }),
          args.member,
          args.task_key,
        );
      },
    }),

    defineTool({
      name: 'start_member',
      audience: { roles: ['project_manager'] },
      title: 'Start a member on work without a card',
      readOnly: false,
      description:
        'Start an AI member on work without a card, on your own authority (an owner request only under ' +
        'owner_request) or on a signal_id: the text goes to their general conversation (a running one gets it ' +
        'when its turn ends). Waits up to 5 seconds and says what became of the start. For a card use start_task.',
      input: {
        member: MemberHandle,
        despite_workers: z
          .boolean()
          .optional()
          .describe(
            'A start on a card where a member of the same role already works is not sent (the result names ' +
              'them); true sends it anyway, only for intended parallel work.',
          ),
        text: z.string().min(1).max(20000),
        task_key: TaskKey.optional().describe(
          "The card the text is about; the member needs a role on it (the card's merger or its step owner).",
        ),
        signal_id: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe(
            'Without an owner request, when the project lets you act on signals: starts the member the signal names.',
          ),
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
