import {
  ChangeTaskLabelsRequest,
  CreateTaskRequest,
  InboxItem,
  InboxState,
  InboxView,
  InstancePauseView,
  LabelId,
  MemberHandle,
  MemberQueueView,
  MemberQueueQuery,
  OperatorConfigPatch,
  HireMemberRequest,
  UpdateMemberRequest,
  UpdateTaskRequest,
  SuperCommand,
  MergeQueueOrder,
  PauseRequest,
  RelayOwnerAnswerRequest,
  ResolveIntegratorFixLimitRequest,
  fixLimitDecisionOf,
  routes,
  StartTaskRequest,
  SuperOperateResponse,
  SuperOperationDetail,
  TaskKey,
} from '@projectman/shared';
import { z } from 'zod';
import { ApiError } from './http';
import { type CommandContext, UsageError } from './context';
import { ClientFileError, readInputFile, readStream } from './files';
import { followEvents } from './events';

export interface CommandSpec {
  name: string;
  usage: string;
  summary: string;
  options: Record<string, { type: 'string' | 'boolean'; multiple?: boolean }>;
  /** Number of positional arguments, or `rest` for one or more. */
  positionals: number | 'rest';
  /** Changes something: gets a request id and is never repeated by itself. */
  write: boolean;
  run(ctx: CommandContext): Promise<number>;
}

const PROJECT_KEY = /^[A-Z][A-Z0-9]{0,9}$/;

function text(ctx: CommandContext, name: string): string | undefined {
  const value = ctx.values[name];
  if (Array.isArray(value)) throw new UsageError(`--${name} can be given only once`);
  return typeof value === 'string' ? value : undefined;
}

function required(ctx: CommandContext, name: string): string {
  const value = text(ctx, name);
  if (value === undefined || value === '') throw new UsageError(`--${name} is required`);
  return value;
}

function projectOf(ctx: CommandContext): string {
  const key = required(ctx, 'project');
  if (!PROJECT_KEY.test(key)) throw new UsageError('--project must be a project key such as PM');
  return key;
}

function taskKeyOf(value: string | undefined): string {
  const parsed = TaskKey.safeParse(value);
  if (!parsed.success) throw new UsageError('a task key such as PM-12 is required');
  return parsed.data;
}

/** The project of a task key (`PM-12` is in `PM`); `--project` may repeat it, and must then agree. */
function projectOfTask(ctx: CommandContext, taskKey: string): string {
  const fromKey = taskKey.slice(0, taskKey.lastIndexOf('-'));
  const given = text(ctx, 'project');
  if (given !== undefined && given !== fromKey)
    throw new UsageError(`${taskKey} is not a card of project ${given}`);
  return fromKey;
}

/** The text of `--file`: `-` reads standard input, any other value a regular file that is not a credential file. */
async function contentOf(ctx: CommandContext, name = 'file'): Promise<string> {
  const file = required(ctx, name);
  try {
    if (file === '-') return await readStream(ctx.io.stdin, ctx.io.signal);
    return readInputFile(file, [...ctx.credentials.credentialFiles, ...ctx.credentials.protectedDirectories]);
  } catch (error) {
    if (error instanceof ClientFileError) throw new UsageError(error.message);
    throw error;
  }
}

function jsonOf(source: string, what: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    throw new UsageError(`${what} is not valid JSON`);
  }
}

function requestIdOf(ctx: CommandContext): string {
  const given = text(ctx, 'request-id');
  if (given === undefined) return ctx.io.newRequestId();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(given))
    throw new UsageError('--request-id must be a UUID');
  return given.toLowerCase();
}

/**
 * Shows the typed answer. A write that the server accepted stays a success when its answer has another shape
 * than this client knows: it is shown raw, with a note on the error stream.
 */
async function show<S extends z.ZodType>(
  ctx: CommandContext,
  schema: S,
  json: unknown,
  human: (data: z.infer<S>) => string,
  write: boolean,
): Promise<number> {
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    if (!write)
      throw new ApiError('protocol', 'unexpected_response', 'the server answered in an unexpected shape');
    ctx.note('the change was accepted, but the answer has a shape this client does not know');
    await ctx.print(`${JSON.stringify(json)}\n`);
    return 0;
  }
  await ctx.print(ctx.json ? `${JSON.stringify(parsed.data)}\n` : `${human(parsed.data)}\n`);
  return 0;
}

const query = (params: Record<string, string | undefined>): string => {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) if (value !== undefined) search.set(name, value);
  const encoded = search.toString();
  return encoded === '' ? '' : `?${encoded}`;
};

const COMMON = {
  json: { type: 'boolean' },
  config: { type: 'string' },
  verbose: { type: 'boolean' },
  help: { type: 'boolean' },
} as const;
const WRITE = { ...COMMON, 'request-id': { type: 'string' } } as const;

async function operate(
  ctx: CommandContext,
  project: string,
  command: SuperCommand,
  taskKey?: string,
): Promise<number> {
  const parsed = SuperCommand.safeParse(command);
  if (!parsed.success)
    throw new UsageError(
      `invalid command: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    );
  const requestId = requestIdOf(ctx);
  const response = await ctx.api.send({
    method: 'POST',
    path: routes.superOperations(project),
    body: { requestId, ...(taskKey === undefined ? {} : { taskKey }), command: parsed.data },
    write: true,
    requestId,
  });
  return show(ctx, SuperOperateResponse, response.json, operationLine, true);
}

function labelsCommand(action: 'add' | 'remove'): CommandSpec {
  return {
    name: `labels ${action}`,
    usage: `labels ${action} TASK LABEL [--note TEXT]`,
    summary: `${action === 'add' ? 'Adds' : 'Removes'} a label of a card (the project's label rules apply)`,
    options: { ...WRITE, note: { type: 'string' }, project: { type: 'string' } },
    positionals: 2,
    write: true,
    async run(ctx) {
      const taskKey = taskKeyOf(ctx.positionals[0]);
      const label = LabelId.safeParse(ctx.positionals[1]);
      if (!label.success) throw new UsageError('a label id is required');
      const note = text(ctx, 'note');
      const body = ChangeTaskLabelsRequest.safeParse({
        [action]: [label.data],
        ...(note === undefined ? {} : { comment: note }),
      });
      if (!body.success) throw new UsageError('the label change is not valid (is --note empty?)');
      return operate(
        ctx,
        projectOfTask(ctx, taskKey),
        { kind: 'task_labels', taskKey, request: body.data },
        taskKey,
      );
    },
  };
}

function pauseCommand(action: 'pause' | 'resume'): CommandSpec {
  return {
    name: action,
    usage: `${action} (--project KEY | --instance)${action === 'pause' ? ' [--reason TEXT]' : ''}`,
    summary: `${action === 'pause' ? 'Pauses' : 'Resumes'} a project or the instance`,
    options: {
      ...WRITE,
      project: { type: 'string' },
      instance: { type: 'boolean' },
      reason: { type: 'string' },
    },
    positionals: 0,
    write: true,
    async run(ctx) {
      const instance = ctx.values.instance === true;
      if (instance === (text(ctx, 'project') !== undefined))
        throw new UsageError('give --project KEY or --instance, not both');
      const reason = text(ctx, 'reason');
      if (action === 'resume' && reason !== undefined) throw new UsageError('resume takes no --reason');
      const body = PauseRequest.safeParse(reason === undefined ? {} : { reason });
      if (!body.success) throw new UsageError('--reason must be 1 to 200 characters');
      if (!instance)
        return operate(ctx, projectOf(ctx), {
          kind: 'operate',
          operation: action === 'pause' ? { op: 'project_pause', ...body.data } : { op: 'project_resume' },
        });
      const target = action === 'pause' ? routes.instancePause() : routes.instancePauseResume();
      const response = await ctx.api.send({
        method: 'POST',
        path: target,
        body: body.data,
        write: true,
        requestId: requestIdOf(ctx),
      });
      return show(
        ctx,
        InstancePauseView,
        response.json,
        (view) => `${action}: ${JSON.stringify(view)}`,
        true,
      );
    },
  };
}

const operationLine = (response: z.infer<typeof SuperOperateResponse>): string =>
  `operation ${response.operation.id} ${response.operation.state} (request ${response.operation.requestId})${response.operation.taskKey ? ` <${response.operation.taskKey}>` : ''}${response.operation.state === 'waiting_owner' ? ' waiting for the owner’s approval' : ''}`;

export const COMMANDS: CommandSpec[] = [
  {
    name: 'tasks update',
    usage:
      'tasks update TASK [--title TEXT] [--description-file FILE] [--priority urgent|high|normal|low|none] [--stage ID] [--assignee HANDLE|none] [--theme KEY|none] [--parent KEY|none] [--visibility internal|shared] [--add-relation KIND:KEY]… [--remove-relation KIND:KEY]…',
    summary: 'Updates card fields and relations as the Operator',
    options: {
      ...WRITE,
      project: { type: 'string' },
      title: { type: 'string' },
      'description-file': { type: 'string' },
      priority: { type: 'string' },
      stage: { type: 'string' },
      assignee: { type: 'string' },
      theme: { type: 'string' },
      parent: { type: 'string' },
      visibility: { type: 'string' },
      'add-relation': { type: 'string', multiple: true },
      'remove-relation': { type: 'string', multiple: true },
    },
    positionals: 1,
    write: true,
    async run(ctx) {
      const taskKey = taskKeyOf(ctx.positionals[0]);
      const fields: Record<string, unknown> = {};
      for (const [flag, field] of Object.entries({
        title: 'title',
        priority: 'priority',
        stage: 'stageId',
        assignee: 'assignee',
        theme: 'themeKey',
        parent: 'parentKey',
        visibility: 'visibility',
      })) {
        const value = text(ctx, flag);
        if (value !== undefined)
          fields[field] =
            value === 'none' && ['priority', 'assignee', 'theme', 'parent'].includes(flag) ? null : value;
      }
      if (text(ctx, 'description-file') !== undefined)
        fields.description = await contentOf(ctx, 'description-file');
      const relations: Record<string, unknown> = {};
      for (const action of ['add', 'remove']) {
        const values = ctx.values[`${action}-relation`];
        if (Array.isArray(values))
          relations[action] = values.map((value) => {
            const parts = value.split(':');
            if (parts.length !== 2) throw new UsageError('relations must be KIND:KEY');
            return { kind: parts[0], key: parts[1] };
          });
      }
      if (Object.keys(relations).length) fields.relations = relations;
      if (!Object.keys(fields).length) throw new UsageError('give at least one field to update');
      const request = UpdateTaskRequest.safeParse(fields);
      if (!request.success)
        throw new UsageError(
          `invalid task fields: ${request.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
        );
      return operate(
        ctx,
        projectOfTask(ctx, taskKey),
        { kind: 'task_update', taskKey, request: request.data },
        taskKey,
      );
    },
  },
  {
    name: 'inbox decide',
    usage: 'inbox decide ITEM --option ID [--note TEXT] --project KEY',
    summary: 'Resolves an inbox item as the Operator; owner decisions wait for approval',
    options: { ...WRITE, project: { type: 'string' }, option: { type: 'string' }, note: { type: 'string' } },
    positionals: 1,
    write: true,
    async run(ctx) {
      const note = text(ctx, 'note');
      return operate(ctx, projectOf(ctx), {
        kind: 'inbox_resolve',
        itemId: ctx.positionals[0]!,
        request: { optionId: required(ctx, 'option'), ...(note === undefined ? {} : { note }) },
      });
    },
  },
  {
    name: 'config set',
    usage: 'config set --project KEY PATH VALUE',
    summary: 'Sets a patchable dotted configuration path to a JSON value',
    options: { ...WRITE, project: { type: 'string' } },
    positionals: 2,
    write: true,
    async run(ctx) {
      const parts = ctx.positionals[0]!.split('.');
      const roots = Object.keys(OperatorConfigPatch.shape);
      if (
        !roots.includes(parts[0]!) ||
        parts.some((part) => !part || ['__proto__', 'prototype', 'constructor'].includes(part))
      )
        throw new UsageError(`patchable roots: ${roots.join(', ')}`);
      let patch: unknown = jsonOf(ctx.positionals[1]!, 'VALUE');
      for (const part of parts.reverse()) patch = { [part]: patch };
      const parsed = OperatorConfigPatch.safeParse(patch);
      if (!parsed.success)
        throw new UsageError(`invalid configuration patch; patchable roots: ${roots.join(', ')}`);
      return operate(ctx, projectOf(ctx), {
        kind: 'operate',
        operation: { op: 'config_patch', patch: parsed.data },
      });
    },
  },
  {
    name: 'config revert',
    usage: 'config revert --project KEY VERSION',
    summary: 'Reverts configuration to a recorded version',
    options: { ...WRITE, project: { type: 'string' } },
    positionals: 1,
    write: true,
    async run(ctx) {
      return operate(ctx, projectOf(ctx), {
        kind: 'operate',
        operation: { op: 'config_revert', version: ctx.positionals[0]! },
      });
    },
  },
  {
    name: 'members hire',
    usage: 'members hire --project KEY --file FILE',
    summary: 'Hires a member from a HireMemberRequest JSON file',
    options: { ...WRITE, project: { type: 'string' }, file: { type: 'string' } },
    positionals: 0,
    write: true,
    async run(ctx) {
      const request = HireMemberRequest.safeParse(jsonOf(await contentOf(ctx), 'the file'));
      if (!request.success) throw new UsageError('the file is not a HireMemberRequest');
      return operate(ctx, projectOf(ctx), {
        kind: 'operate',
        operation: { op: 'member_hire', request: request.data },
      });
    },
  },
  {
    name: 'members update',
    usage: 'members update HANDLE --project KEY --file FILE',
    summary: 'Updates a member from an UpdateMemberRequest JSON file',
    options: { ...WRITE, project: { type: 'string' }, file: { type: 'string' } },
    positionals: 1,
    write: true,
    async run(ctx) {
      const request = UpdateMemberRequest.safeParse(jsonOf(await contentOf(ctx), 'the file'));
      if (!request.success) throw new UsageError('the file is not an UpdateMemberRequest');
      return operate(ctx, projectOf(ctx), {
        kind: 'member_update',
        handle: ctx.positionals[0]!,
        request: request.data,
      });
    },
  },
  {
    name: 'members retire',
    usage: 'members retire HANDLE --project KEY',
    summary: 'Retires a member after the owner approves (K3)',
    options: { ...WRITE, project: { type: 'string' } },
    positionals: 1,
    write: true,
    async run(ctx) {
      return operate(ctx, projectOf(ctx), {
        kind: 'operate',
        operation: { op: 'member_retire', handle: ctx.positionals[0]! },
      });
    },
  },
  {
    name: 'keys revoke',
    usage: 'keys revoke KEY_ID --project KEY',
    summary: 'Revokes a credential after the owner approves (K3)',
    options: { ...WRITE, project: { type: 'string' } },
    positionals: 1,
    write: true,
    async run(ctx) {
      return operate(ctx, projectOf(ctx), { kind: 'credential_revoke', keyId: ctx.positionals[0]! });
    },
  },
  {
    name: 'queue',
    usage: 'queue --project KEY [--closed-since ISO]',
    summary: 'Lists the Operator queue, followed by recently closed items',
    options: { ...COMMON, project: { type: 'string' }, 'closed-since': { type: 'string' } },
    positionals: 0,
    write: false,
    async run(ctx) {
      const closedSince = text(ctx, 'closed-since');
      if (!MemberQueueQuery.safeParse(closedSince === undefined ? {} : { closedSince }).success)
        throw new UsageError('--closed-since must be an ISO timestamp');
      const response = await ctx.api.send({
        method: 'GET',
        path: `${routes.operatorQueue(projectOf(ctx))}${query({ closedSince })}`,
        write: false,
      });
      return show(
        ctx,
        MemberQueueView,
        response.json,
        (view) => {
          const line = (item: z.infer<typeof MemberQueueView>['items'][number]) =>
            `${item.state} ${item.kind} ${item.title} ${item.taskKey ?? '-'} ${Math.max(0, Math.floor((Date.now() - Date.parse(item.queuedAt)) / 60000))}m`;
          return [...view.items.map(line), 'closed:', ...view.closed.map(line)].join('\n');
        },
        false,
      );
    },
  },
  {
    name: 'tasks create',
    usage: 'tasks create --project KEY --file FILE',
    summary: 'Creates a card from a JSON file (CreateTaskRequest); FILE - reads standard input',
    options: { ...WRITE, project: { type: 'string' }, file: { type: 'string' } },
    positionals: 0,
    write: true,
    async run(ctx) {
      const project = projectOf(ctx);
      const body = CreateTaskRequest.safeParse(jsonOf(await contentOf(ctx), 'the file'));
      if (!body.success)
        throw new UsageError(
          `the file is not a card: ${body.error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ')}`,
        );
      return operate(ctx, project, { kind: 'task_create', request: body.data });
    },
  },
  {
    name: 'tasks start',
    usage: 'tasks start TASK [--assignee HANDLE]',
    summary: 'Starts a card (the usual rules of starting apply)',
    options: { ...WRITE, project: { type: 'string' }, assignee: { type: 'string' } },
    positionals: 1,
    write: true,
    async run(ctx) {
      const taskKey = taskKeyOf(ctx.positionals[0]);
      const assignee = text(ctx, 'assignee');
      if (assignee !== undefined && !MemberHandle.safeParse(assignee).success)
        throw new UsageError('--assignee is not a member handle');
      const body = StartTaskRequest.parse(assignee === undefined ? {} : { assignee });
      return operate(
        ctx,
        projectOfTask(ctx, taskKey),
        { kind: 'task_start', taskKey, request: body },
        taskKey,
      );
    },
  },
  {
    name: 'messages send',
    usage: 'messages send --project KEY --to HANDLE [--to HANDLE…] [--task TASK] --file FILE',
    summary: 'Sends the text of FILE (- for standard input) to team members as the Operator',
    options: {
      ...WRITE,
      project: { type: 'string' },
      to: { type: 'string', multiple: true },
      task: { type: 'string' },
      file: { type: 'string' },
    },
    positionals: 0,
    write: true,
    async run(ctx) {
      const project = projectOf(ctx);
      const to = ctx.values.to;
      const handles = Array.isArray(to) ? to : [];
      if (handles.length === 0) throw new UsageError('--to is required');
      for (const handle of handles)
        if (!MemberHandle.safeParse(handle).success) throw new UsageError(`${handle} is not a member handle`);
      const task = text(ctx, 'task');
      const message = (await contentOf(ctx)).trim();
      if (message === '') throw new UsageError('the message is empty');
      return operate(
        ctx,
        project,
        {
          kind: 'operate',
          operation: {
            op: 'message_send',
            to: handles,
            text: message,
            ...(task === undefined ? {} : { taskKey: taskKeyOf(task) }),
          },
        },
        task === undefined ? undefined : taskKeyOf(task),
      );
    },
  },
  labelsCommand('add'),
  labelsCommand('remove'),
  {
    name: 'inbox list',
    usage: 'inbox list --project KEY [--state STATE|all]',
    summary: 'Lists the inbox items of a project (open ones by default)',
    options: { ...COMMON, project: { type: 'string' }, state: { type: 'string' } },
    positionals: 0,
    write: false,
    async run(ctx) {
      const project = projectOf(ctx);
      const state = text(ctx, 'state');
      if (state !== undefined && state !== 'all' && !InboxState.safeParse(state).success)
        throw new UsageError('--state is not an inbox state');
      const response = await ctx.api.send({
        method: 'GET',
        path: `${routes.inbox(project)}${query({ state })}`,
        write: false,
      });
      return show(
        ctx,
        InboxView,
        response.json,
        (view) =>
          view.items
            .map((item) => {
              const line = `${item.id} ${item.kind} ${item.state} ${item.title ?? ''}`.trimEnd();
              // A fix round limit decision is read in full (PM-714): its body is the summary, the lead's
              // assessment, every round and the options. JSON output keeps the item as it is.
              return fixLimitDecisionOf(item) && item.body ? `${line}\n${item.body}\n` : line;
            })
            .join('\n'),
        false,
      );
    },
  },
  {
    name: 'inbox fix-limit',
    usage: 'inbox fix-limit ITEM --project KEY --option replan|reassign|another_round|to_owner [--note TEXT]',
    summary:
      'Decides the fix round limit item addressed to the integrator, or hands it to the owners (to_owner needs --note)',
    options: { ...WRITE, project: { type: 'string' }, option: { type: 'string' }, note: { type: 'string' } },
    positionals: 1,
    write: true,
    async run(ctx) {
      const project = projectOf(ctx);
      const item = ctx.positionals[0]!;
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(item)) throw new UsageError('ITEM is not an inbox item id');
      const note = text(ctx, 'note');
      const body = ResolveIntegratorFixLimitRequest.safeParse({
        optionId: required(ctx, 'option'),
        ...(note === undefined ? {} : { note }),
      });
      if (!body.success)
        throw new UsageError(
          '--option must be replan, reassign, another_round or to_owner (the last needs a --note)',
        );
      const response = await ctx.api.send({
        method: 'POST',
        path: routes.resolveIntegratorFixLimit(project, item),
        body: body.data,
        write: true,
        requestId: requestIdOf(ctx),
      });
      return show(
        ctx,
        z.object({ item: InboxItem }),
        response.json,
        (view) => `decided ${view.item.id} ${view.item.state}`,
        true,
      );
    },
  },
  {
    name: 'inbox answer',
    usage: 'inbox answer ITEM --project KEY --file FILE',
    summary: "Relays the owner's words to a plain information question (not an owner decision)",
    options: { ...WRITE, project: { type: 'string' }, file: { type: 'string' } },
    positionals: 1,
    write: true,
    async run(ctx) {
      const project = projectOf(ctx);
      const item = ctx.positionals[0]!;
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(item)) throw new UsageError('ITEM is not an inbox item id');
      const body = RelayOwnerAnswerRequest.safeParse({ answer: await contentOf(ctx) });
      if (!body.success) throw new UsageError('the answer must be 1 to 20000 characters');
      const response = await ctx.api.send({
        method: 'POST',
        path: routes.relayOwnerAnswer(project, item),
        body: body.data,
        write: true,
        requestId: requestIdOf(ctx),
      });
      return show(
        ctx,
        z.object({ item: InboxItem }),
        response.json,
        (view) => `answered ${view.item.id} ${view.item.state}`,
        true,
      );
    },
  },
  {
    name: 'merges list',
    usage: 'merges list --project KEY --repo REPO',
    summary: "Shows a repository's merge queue order and its revision",
    options: { ...COMMON, project: { type: 'string' }, repo: { type: 'string' } },
    positionals: 0,
    write: false,
    async run(ctx) {
      const project = projectOf(ctx);
      const repo = required(ctx, 'repo');
      const response = await ctx.api.send({
        method: 'GET',
        path: `${routes.mergeQueueOrder(project)}${query({ repo })}`,
        write: false,
      });
      return show(
        ctx,
        MergeQueueOrder,
        response.json,
        (order) => `revision ${order.revision}: ${order.taskKeys.join(' ')}`,
        false,
      );
    },
  },
  {
    name: 'merges enqueue',
    usage: 'merges enqueue TASK',
    summary: 'Starts (queues) the merge of an approved card',
    options: { ...WRITE, project: { type: 'string' } },
    positionals: 1,
    write: true,
    async run(ctx) {
      const taskKey = taskKeyOf(ctx.positionals[0]);
      return operate(ctx, projectOfTask(ctx, taskKey), { kind: 'merge', taskKey, request: {} }, taskKey);
    },
  },
  {
    name: 'merges prioritize',
    usage: 'merges prioritize TASK --reason TEXT',
    summary: "Puts a card's queued merge at the front of its repository's queue",
    options: { ...WRITE, project: { type: 'string' }, reason: { type: 'string' } },
    positionals: 1,
    write: true,
    async run(ctx) {
      const taskKey = taskKeyOf(ctx.positionals[0]);
      const reason = required(ctx, 'reason');
      const response = await ctx.api.send({
        method: 'POST',
        path: routes.taskMergePrioritize(projectOfTask(ctx, taskKey), taskKey),
        body: { reason },
        write: true,
        requestId: requestIdOf(ctx),
      });
      return rawShow(ctx, response.json, `prioritized ${taskKey}`);
    },
  },
  {
    name: 'merges reorder',
    usage: 'merges reorder --project KEY --repo REPO --expected-revision N --reason TEXT TASK…',
    summary: "Sets the complete order of a repository's merge queue",
    options: {
      ...WRITE,
      project: { type: 'string' },
      repo: { type: 'string' },
      'expected-revision': { type: 'string' },
      reason: { type: 'string' },
    },
    positionals: 'rest',
    write: true,
    async run(ctx) {
      const project = projectOf(ctx);
      const revision = required(ctx, 'expected-revision');
      if (!/^\d{1,15}$/.test(revision)) throw new UsageError('--expected-revision must be a whole number');
      return operate(ctx, project, {
        kind: 'merge_order',
        repo: required(ctx, 'repo'),
        expectedRevision: Number(revision),
        taskKeys: ctx.positionals.map((value) => taskKeyOf(value)),
        reason: required(ctx, 'reason'),
      });
    },
  },
  pauseCommand('pause'),
  pauseCommand('resume'),
  {
    name: 'events follow',
    usage: 'events follow --project KEY [--cursor CURSOR] [--cursor-file FILE]',
    summary: "Follows the project's change journal until interrupted; one line per event",
    options: {
      ...COMMON,
      project: { type: 'string' },
      cursor: { type: 'string' },
      'cursor-file': { type: 'string' },
    },
    positionals: 0,
    write: false,
    async run(ctx) {
      return followEvents(ctx, {
        project: projectOf(ctx),
        cursor: text(ctx, 'cursor'),
        cursorFile: text(ctx, 'cursor-file'),
      });
    },
  },
  {
    name: 'operations get',
    usage: 'operations get ID --project KEY',
    summary: 'Reads a super operation and its recorded result',
    options: { ...COMMON, project: { type: 'string' } },
    positionals: 1,
    write: false,
    async run(ctx) {
      const project = projectOf(ctx);
      const id = ctx.positionals[0]!;
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new UsageError('ID is not an operation id');
      const response = await ctx.api.send({
        method: 'GET',
        path: routes.superOperation(project, id),
        write: false,
      });
      return show(
        ctx,
        SuperOperationDetail,
        response.json,
        (detail) =>
          `operation ${detail.operation.id} ${detail.operation.state}${detail.operation.errorCode ? ` (${detail.operation.errorCode})` : ''}`,
        false,
      );
    },
  },
];

/** An answer of a shape this client does not model: JSON mode passes it on as it is. */
async function rawShow(ctx: CommandContext, json: unknown, humanLine: string): Promise<number> {
  await ctx.print(ctx.json ? `${JSON.stringify(json)}\n` : `${humanLine}\n`);
  return 0;
}
