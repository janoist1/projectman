import {
  GetAdministrationLogsArgs,
  GetAdministrationStatusArgs,
  GetProjectDocWriteInput,
  GetSuperOperationArgs,
  GetSuperQuestionInput,
  ListSuperHandoffsQuery,
  QuerySuperDiagnosticsArgs,
  RelayOwnerAnswerRequest,
  ResolveIntegratorFixLimitRequest,
  ResolveIntegratorTodoRequest,
  SuperOperateArgs,
} from '@projectman/shared';
import { z } from 'zod';
import { defineExternalTool, defineProjectlessTool, type ExternalRegisteredTool } from '../kit';

/** The shared argument shapes of the super routes, without the `project_key` the adapter adds itself. */
const withoutProject = <Shape extends { project_key: z.ZodType }>(schema: { shape: Shape }) => {
  const { project_key: _project, ...rest } = schema.shape;
  return rest;
};

/**
 * What only the bearer endpoint offers (PM-760): the project list and the super mode's tools. They answer
 * structured JSON, so the domain's `errorCode` stays visible to the integrator, and only the super mode sees
 * them: a read or legacy key is neither offered them nor allowed to call them.
 */
export const EXTERNAL_ONLY_TOOLS: readonly ExternalRegisteredTool[] = [
  defineProjectlessTool({
    name: 'list_projects',
    title: 'List the projects of this key',
    description:
      'The projects whose owner the key’s holder is now, as {projects: [{key, name}]}. Every other tool takes one of these keys as project_key; there is no current project, so a call names its project each time.',
    access: 'read',
    input: {},
    async run({ principal, requestId, handler }) {
      return { structured: await handler.listProjects(principal, requestId) };
    },
  }),
  defineExternalTool({
    name: 'list_super_handoffs',
    title: 'List the handoffs to the super mode',
    description:
      'The commands the Operator handed to the owner’s super-mode integrator, newest first: {handoffs: [...]}. Filter by state; limit is at most 100.',
    access: 'read',
    modes: ['super'],
    input: ListSuperHandoffsQuery.shape,
    async run({ ctx, args, handler }) {
      return { structured: await handler.listSuperHandoffs(ctx, args) };
    },
  }),
  defineExternalTool({
    name: 'execute_super_handoff',
    title: 'Execute a handoff',
    description:
      'Starts, or after the owner’s own yes resumes, the operation of one handoff: {operation}. An effect reserved for the owner waits for the owner’s own yes (owner_approval_required); give a fresh request_id (UUID) and repeat it only to retry the same call.',
    access: 'write',
    modes: ['super'],
    input: {
      handoff_id: z.string().min(1).max(100),
      request_id: z.uuid(),
    },
    async run({ ctx, args, handler }) {
      return {
        structured: await handler.executeSuperHandoff(ctx, {
          handoffId: args.handoff_id,
          requestId: args.request_id,
        }),
      };
    },
  }),
  defineExternalTool({
    name: 'super_operate',
    title: 'Start a super command',
    description:
      'Starts one command directly, without a handoff: {operation}. command is {kind: operate, operation} | {kind: member_update, handle, request} | {kind: invite_create, request} | {kind: merge, taskKey, request} | {kind: merge_order, repo, expectedRevision, taskKeys, reason} | {kind: administration, request}. Give a fresh request_id (UUID) and repeat it only to retry the same call. Follow it with get_super_operation.',
    access: 'write',
    modes: ['super'],
    input: withoutProject(SuperOperateArgs),
    async run({ ctx, args, handler }) {
      return {
        structured: await handler.superOperate(ctx, {
          requestId: args.request_id,
          command: args.command,
          ...(args.task_key ? { taskKey: args.task_key } : {}),
        }),
      };
    },
  }),
  defineExternalTool({
    name: 'get_super_operation',
    title: 'Read a super operation',
    description:
      'One operation of this project and, once the adapter recorded it, its result: {operation, result}. A running operation is settled first, so ask again until its state is final.',
    access: 'read',
    modes: ['super'],
    input: withoutProject(GetSuperOperationArgs),
    async run({ ctx, args, handler }) {
      return { structured: await handler.getSuperOperation(ctx, args.operation_id) };
    },
  }),
  defineExternalTool({
    name: 'query_super_diagnostics',
    title: 'Query filtered diagnostics',
    description:
      'A closed catalogue of the project’s own records by name (tasks, sessions, merges, operations): {columns, rows, truncated}. No SQL, path or free-text filter.',
    access: 'read',
    modes: ['super'],
    input: withoutProject(QuerySuperDiagnosticsArgs),
    async run({ ctx, args, handler }) {
      return {
        structured: await handler.querySuperDiagnostics(ctx, {
          query: args.query,
          limit: args.limit ?? 50,
          ...(args.task_key ? { taskKey: args.task_key } : {}),
        }),
      };
    },
  }),
  defineExternalTool({
    name: 'get_administration_status',
    title: 'Read the administration status',
    description:
      'The status of the hub (target "hub") or of an engine linked to this project (target: the engine id): {status}.',
    access: 'read',
    modes: ['super'],
    input: withoutProject(GetAdministrationStatusArgs),
    async run({ ctx, args, handler }) {
      return { structured: await handler.getAdministrationStatus(ctx, args.target) };
    },
  }),
  defineExternalTool({
    name: 'get_administration_logs',
    title: 'Read the administration log',
    description:
      'The diagnostic log of the hub (target "hub") or of an engine linked to this project (target: the engine id), newest first: {entries}. limit is at most 200.',
    access: 'read',
    modes: ['super'],
    input: withoutProject(GetAdministrationLogsArgs),
    async run({ ctx, args, handler }) {
      return {
        structured: await handler.getAdministrationLogs(ctx, {
          target: args.target,
          limit: args.limit ?? 50,
        }),
      };
    },
  }),
  defineExternalTool({
    name: 'resolve_integrator_todo',
    title: 'Resolve the integrator’s own todo',
    description:
      'Report the result of an open integrator-addressed todo: {item}. This is your own work, never an owner answer or approval. Cannot do it requires a reason in note. After 24 hours only the owner may resolve it. This endpoint grants no execution authority.',
    access: 'write',
    modes: ['super'],
    input: {
      item_id: z.string().min(1).max(100),
      option_id: ResolveIntegratorTodoRequest.shape.optionId,
      note: ResolveIntegratorTodoRequest.shape.note,
    },
    async run({ ctx, args, handler }) {
      return {
        structured: await handler.resolveIntegratorTodo(ctx, {
          itemId: args.item_id,
          optionId: args.option_id,
          ...(args.note !== undefined ? { note: args.note } : {}),
        }),
      };
    },
  }),
  defineExternalTool({
    name: 'resolve_integrator_fix_limit',
    title: 'Decide a fix round limit item addressed to you',
    description:
      'Decide the fix round limit item that is addressed to you (list_integrator_inbox shows it with its full text): {item}. option_id is replan (a more exact plan first), reassign (another implementer) or another_round (one more round for the same implementer; it counts as an extra round); or to_owner, which hands the same item to the owners and requires why in note. This is your own work, not an owner approval, and it works on that item only: any other item is refused (super_relay_refused). After 24 hours the item belongs to the owners.',
    access: 'write',
    modes: ['super'],
    input: {
      item_id: z.string().min(1).max(100),
      option_id: ResolveIntegratorFixLimitRequest.shape.optionId,
      note: ResolveIntegratorFixLimitRequest.shape.note,
    },
    async run({ ctx, args, handler }) {
      return {
        structured: await handler.resolveIntegratorFixLimit(ctx, {
          itemId: args.item_id,
          optionId: args.option_id,
          ...(args.note !== undefined ? { note: args.note } : {}),
        }),
      };
    },
  }),
  defineExternalTool({
    name: 'list_integrator_inbox',
    title: 'List what is addressed to the integrator',
    description:
      'The items addressed to you: your todos and the fix round limit decisions, each with its full text (the summary, the extra rounds, the lead’s assessment, every round, and per option its id, label and consequence), newest first: {items}. state is open (default) or all (every item that was ever opened to you, at most 500).',
    access: 'read',
    modes: ['super'],
    input: { state: z.enum(['open', 'all']).optional() },
    async run({ ctx, args, handler }) {
      const result = await handler.listIntegratorInbox(ctx, { state: args.state ?? 'open' });
      const text =
        result.items.length === 0
          ? 'Nothing is addressed to you.'
          : result.items
              .map((item) =>
                [
                  `## ${item.id} · ${item.kind} · ${item.state}${item.taskKey ? ` · ${item.taskKey}` : ''}`,
                  item.title,
                  item.body ?? '',
                  `Options: ${item.options.map((option) => option.id).join(', ')}`,
                ]
                  .filter((line) => line !== '')
                  .join('\n'),
              )
              .join('\n\n');
      return { structured: { ...result }, text };
    },
  }),
  defineExternalTool({
    name: 'get_super_question',
    title: 'Read your own question and its answer',
    description:
      'A question you asked with ask_human through this owner’s keys in this project: {item, answer, answer_attachments}. answer is null while it is open and after it was withdrawn or closed. answer_attachments lists the files the answer carries (a deleted one stays, marked); their content comes through the protected message-attachment download. Any other question is not_found.',
    access: 'read',
    modes: ['super', 'read'],
    input: GetSuperQuestionInput.shape,
    async run({ ctx, args, handler }) {
      return { structured: { ...(await handler.getSuperQuestion(ctx, { itemId: args.item_id })) } };
    },
  }),
  defineExternalTool({
    name: 'get_project_doc_write',
    title: 'Read the state of a document write',
    description:
      'One write_project_docs write the keys of this owner made in this project: {write_id, state: queued|running|published|stale|failed, commit, paths, warning, failure}. Ask again until the state is final. Any other write is not_found.',
    access: 'read',
    modes: ['super', 'read'],
    input: GetProjectDocWriteInput.shape,
    async run({ ctx, args, handler }) {
      return { structured: { ...(await handler.getProjectDocWrite(ctx, { writeId: args.write_id })) } };
    },
  }),
  defineExternalTool({
    name: 'relay_owner_answer',
    title: 'Relay the owner’s answer to an information question',
    description:
      'Answers an open, plain information question of this project with the owner’s own words: {item}. It is not an owner decision: a question that is not an explicit information question is refused (super_relay_refused).',
    access: 'write',
    modes: ['super'],
    input: {
      item_id: z.string().min(1).max(100),
      answer: RelayOwnerAnswerRequest.shape.answer,
    },
    async run({ ctx, args, handler }) {
      return {
        structured: await handler.relayOwnerAnswer(ctx, { itemId: args.item_id, answer: args.answer }),
      };
    },
  }),
];
