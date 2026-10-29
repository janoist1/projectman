import {
  AddableRelationKind,
  COMPLEXITY_REASON_MAX,
  MemberHandle,
  StageId,
  TaskPriority,
  TaskRelationKind,
  TaskStatus,
} from '@projectman/shared';
import type { AcceptanceChange, ComplexityRequest, MemberView, Task } from '@projectman/shared';
import { z } from 'zod';
import { TeamToolError } from '../../contracts';
import type { ListTasksInput, TaskSummary, TaskToolDetail, TaskToolsHandler } from '../../contracts';
import { formatTaskCreated, formatTaskDetail, formatTaskUpdate, MAX_DESCRIPTION_CHARS } from '../format';

import {
  DEVELOPER_LEVEL_REFUSED,
  defineTool,
  type TeamToolGroup,
  unique,
  taskKeyInput,
  TASK_VISIBILITY_REMOVED,
} from '../kit';
const MAX_NOTE_CHARS = 10_000;

const complexityInput = z
  .number()
  .int()
  .nullable()
  .optional()
  .describe('Complexity points: 1, 2, 3, 5, 8 or 13 (split larger cards); null removes them.');
const complexityReasonInput = z
  .string()
  .trim()
  .min(1)
  .max(COMPLEXITY_REASON_MAX)
  .optional()
  .describe('Reason for the complexity (1–300 characters); needs numeric points.');

function complexityArg(args: {
  complexity?: number | null | undefined;
  complexity_reason?: string | undefined;
}): ComplexityRequest | undefined {
  if (args.complexity_reason !== undefined && typeof args.complexity !== 'number')
    throw new TeamToolError('invalid', 'complexity_reason needs a numeric complexity.');
  return args.complexity === undefined
    ? undefined
    : { points: args.complexity, reason: args.complexity_reason ?? null };
}

const MAX_TITLE_CHARS = 200;

const MAX_LABEL_CHARS = 40;

const MAX_REPO_CHARS = 64;

const ADDED_RELATIONS_HELP =
  'part_of: this card is a one-level subtask of the other (same project); prerequisite: this card can ' +
  'only be done after the other (order cards with this, not with a "Dependencies" text); related: the ' +
  'cards belong together, nothing more; duplicate_of: this card duplicates the other and is closed ' +
  'pointing at it (only a card that has not started: waiting in a queue stage, no session; otherwise ' +
  'whoever may cancel it marks it: an admin, the owner, or the project manager when the project settings allow it). Point at the original, never at another duplicate.';

const addedRelationInput = z.object({
  kind: AddableRelationKind,
  task_key: taskKeyInput.describe('The other card, in this project.'),
});

const acceptanceTextInput = z.string().trim().min(1).max(500);

const acceptanceChangeInput = z.object({
  op: z.enum(['add', 'edit', 'remove', 'done', 'not_needed', 'move', 'reopen', 'confirm']),
  item_id: z.string().trim().min(1).max(40).optional().describe('The acc_… id from get_task; not for add.'),
  text: acceptanceTextInput.optional().describe('add, edit: the condition.'),
  evidence: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .optional()
    .describe('done: how it is met (the commit, the test, the file, the observed behavior).'),
  reason: z.string().trim().min(1).max(1000).optional().describe('not_needed: why it does not apply.'),
  task_key: taskKeyInput.optional().describe('move: the open card that takes the item over.'),
  note: z.string().trim().min(1).max(1000).optional().describe('reopen: what does not hold.'),
});

const ACCEPTANCE_HELP =
  'Changes of the acceptance items (the conditions of "done") in order, all or nothing with the rest of ' +
  'the call. add (text); edit (item_id, text; an open item); remove (item_id); done (item_id, evidence) and ' +
  'not_needed (item_id, reason) and move (item_id, task_key: the item goes to that card as an open one): ' +
  'the assignee or a person marks them; reopen (item_id, note): the assignee or the owner of the current ' +
  'step sets an item open again; confirm (item_id): the owner of the current step, never the one who ' +
  'marked it nor the assignee. Item ids are in get_task.';

/** The MCP shape of one acceptance change as the shared one; a missing field is an invalid call. */
function acceptanceChanges(items: z.infer<typeof acceptanceChangeInput>[] | undefined): AcceptanceChange[] {
  const field = <T>(item: z.infer<typeof acceptanceChangeInput>, value: T | undefined, name: string): T => {
    if (value === undefined) throw new TeamToolError('invalid', `acceptance ${item.op} needs ${name}.`);
    return value;
  };
  return (items ?? []).map((item): AcceptanceChange => {
    if (item.op === 'add') return { op: 'add', text: field(item, item.text, 'text') };
    const itemId = field(item, item.item_id, 'item_id');
    switch (item.op) {
      case 'edit':
        return { op: 'edit', itemId, text: field(item, item.text, 'text') };
      case 'done':
        return { op: 'done', itemId, evidence: field(item, item.evidence, 'evidence') };
      case 'not_needed':
        return { op: 'not_needed', itemId, reason: field(item, item.reason, 'reason') };
      case 'move':
        return { op: 'move', itemId, taskKey: field(item, item.task_key, 'task_key') };
      case 'reopen':
        return { op: 'reopen', itemId, ...(item.note ? { note: item.note } : {}) };
      case 'remove':
      case 'confirm':
        return { op: item.op, itemId };
    }
  });
}

/**
 * The runs below serve the member tools and the bearer endpoint alike (PM-760): they depend on the handler
 * methods they call, typed over the caller's context, so neither caller needs the other's context type.
 */
interface Call<Context, Args, Handler> {
  ctx: Context;
  args: Args;
  handler: Handler;
}

async function runListTasks<C>({
  ctx,
  args,
  handler,
}: Call<C, ListTasksInput, { listTasks(ctx: C, args: ListTasksInput): Promise<TaskSummary[]> }>) {
  return JSON.stringify(await handler.listTasks(ctx, args));
}

async function runGetTask<C>({
  ctx,
  args,
  handler,
}: Call<
  C,
  { task_key: string; event_id?: string | undefined; description_offset?: number | undefined },
  { getTask(ctx: C, args: { taskKey: string; eventId?: string }): Promise<TaskToolDetail> }
>) {
  const event = args.event_id === undefined ? {} : { eventId: args.event_id };
  return formatTaskDetail(await handler.getTask(ctx, { taskKey: args.task_key, ...event }), {
    descriptionOffset: args.description_offset ?? 0,
  });
}

interface UpdateTaskArgs {
  complexity?: number | null | undefined;
  complexity_reason?: string | undefined;
  task_key: string;
  stage_id?: string | undefined;
  add_labels?: string[] | undefined;
  remove_labels?: string[] | undefined;
  note?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  repo?: string | null | undefined;
  add_relations?: { kind: AddableRelationKind; task_key: string }[] | undefined;
  remove_relations?: { kind: TaskRelationKind; task_key: string }[] | undefined;
  theme_key?: string | null | undefined;
  priority?: TaskPriority | null | undefined;
  despite_prerequisites?: boolean | undefined;
  acceptance?: z.infer<typeof acceptanceChangeInput>[] | undefined;
}

async function runUpdateTask<C>({
  ctx,
  args,
  handler,
}: Call<
  C,
  UpdateTaskArgs,
  {
    updateTask(ctx: C, args: Parameters<TaskToolsHandler['updateTask']>[1]): Promise<{ task: Task }>;
    listMembers(ctx: C): Promise<MemberView[]>;
  }
>) {
  const {
    task_key: taskKey,
    stage_id: stageId,
    priority,
    add_labels: addLabels,
    remove_labels: removeLabels,
    note,
    title,
    description,
    repo,
    add_relations: addRelations,
    remove_relations: removeRelations,
    theme_key: themeKey,
    despite_prerequisites: despitePrerequisites,
  } = args;
  const complexity = complexityArg(args);
  if (
    !stageId &&
    themeKey === undefined &&
    priority === undefined &&
    !complexity &&
    !addLabels?.length &&
    !removeLabels?.length &&
    !note &&
    !title &&
    !description &&
    repo === undefined &&
    !addRelations?.length &&
    !removeRelations?.length &&
    !args.acceptance?.length
  ) {
    throw new TeamToolError(
      'invalid',
      'Nothing to update: pass stage_id, add_labels, remove_labels, note, title, description, repo, ' +
        'add_relations, remove_relations, theme_key, priority, complexity and/or acceptance.',
    );
  }
  const acceptance = acceptanceChanges(args.acceptance);
  const relations = {
    add: (addRelations ?? []).map((r) => ({ kind: r.kind, key: r.task_key })),
    remove: (removeRelations ?? []).map((r) => ({ kind: r.kind, key: r.task_key })),
  };
  const { task } = await handler.updateTask(ctx, {
    taskKey,
    ...(stageId ? { stageId } : {}),
    ...(addLabels?.length ? { addLabels } : {}),
    ...(removeLabels?.length ? { removeLabels } : {}),
    ...(note ? { note } : {}),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(repo !== undefined ? { repo } : {}),
    ...(relations.add.length + relations.remove.length > 0 ? { relations } : {}),
    ...(themeKey !== undefined ? { themeKey } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(complexity ? { complexity } : {}),
    ...(despitePrerequisites ? { despitePrerequisites } : {}),
    ...(acceptance.length ? { acceptance } : {}),
  });
  const moverName =
    task.handOn && stageId
      ? (await handler.listMembers(ctx)).find((member) => member.handle === task.handOn!.mover)?.displayName
      : undefined;
  return formatTaskUpdate(task, {
    ...(moverName ? { moverName } : {}),
    stageId,
    ...(priority !== undefined ? { priority } : {}),
    ...(complexity ? { complexity: true } : {}),
    ...(themeKey !== undefined ? { themeKey } : {}),
    labels: { added: addLabels ?? [], removed: removeLabels ?? [] },
    note: !!note,
    title: !!title,
    description: !!description,
    repo,
    relations,
  });
}

interface CreateTaskArgs {
  complexity?: number | null | undefined;
  complexity_reason?: string | undefined;
  kind?: 'task' | 'theme' | undefined;
  theme_key?: string | undefined;
  parent_key?: string | undefined;
  title: string;
  description?: string | undefined;
  labels?: string[] | undefined;
  relations?: { kind: AddableRelationKind; task_key: string }[] | undefined;
  acceptance?: string[] | undefined;
}

async function runCreateTask<C>({
  ctx,
  args,
  handler,
}: Call<
  C,
  CreateTaskArgs,
  { createTask(ctx: C, args: Parameters<TaskToolsHandler['createTask']>[1]): Promise<{ task: Task }> }
>) {
  const complexity = complexityArg(args);
  const { task } = await handler.createTask(ctx, {
    title: args.title,
    ...(complexity ? { complexity } : {}),
    ...(args.relations?.length
      ? { relations: args.relations.map((r) => ({ kind: r.kind, key: r.task_key })) }
      : {}),
    ...(args.parent_key ? { parentKey: args.parent_key } : {}),
    ...(args.kind === 'theme' ? { kind: args.kind } : {}),
    ...(args.theme_key ? { themeKey: args.theme_key } : {}),
    ...(args.description ? { description: args.description } : {}),
    ...(args.labels ? { labels: unique(args.labels) } : {}),
    ...(args.acceptance?.length ? { acceptance: args.acceptance } : {}),
  });
  return formatTaskCreated(task, complexity !== undefined);
}
export const TASK_TOOL_GROUP: TeamToolGroup = {
  module: 'core/tasks',
  tools: [
    defineTool({
      name: 'list_tasks',
      title: 'List tasks',
      readOnly: true,
      description:
        'Read the project board as a compact list, newest update first. Defaults to open tasks ' +
        '(active, waiting or blocked). Filter by status, stage or assignee; use get_task for details. A ' +
        'theme is marked kind "theme"; it is in no stage, so a stage filter leaves themes out.',
      input: {
        status: z.union([z.literal('open'), TaskStatus]).default('open'),
        stage: StageId.optional(),
        assignee: MemberHandle.optional().describe('Member handle, or "me" for your own tasks.'),
        limit: z.number().int().min(1).max(200).default(50),
      },
      external: { access: 'read', run: runListTasks },
      run: runListTasks,
    }),
    defineTool({
      name: 'get_task',
      title: 'Get a task',
      readOnly: true,
      description:
        'Get a task: title, description, stage, status, assignee, labels, links (pull requests, branches), ' +
        'its relations to other cards, its theme (a theme shows its cards ' +
        'and progress), its parent, subtasks, attachments (open one with read_attachment) and recent ' +
        'timeline. The description is shown whole up to ' +
        `${MAX_DESCRIPTION_CHARS} characters; a longer one is shown in parts, and the result says how to ` +
        'read the rest. A long timeline note, question or answer is cut; with event_id (named on the cut ' +
        'line) the call returns that one text whole instead of the task.',
      input: {
        task_key: taskKeyInput,
        event_id: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .optional()
          .describe('Id of a timeline event: returns its whole text. Only when a timeline line is cut.'),
        description_offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Show the description from this character on (default 0), when get_task said it is cut.'),
      },
      external: { access: 'read', run: runGetTask },
      run: runGetTask,
    }),
    defineTool({
      name: 'update_task',
      title: 'Update a task',
      readOnly: false,
      description:
        'Record progress on a task: labels, a note, the title or description, the repository, relations, ' +
        'theme, priority, complexity, acceptance items and/or a move to another stage. One call is all or nothing: a refused ' +
        'label or a blocked stage gate records nothing. A move that needs a human approval records the rest ' +
        'and waits for the approval.',
      refused: DEVELOPER_LEVEL_REFUSED,
      input: {
        task_key: taskKeyInput,
        complexity: complexityInput,
        complexity_reason: complexityReasonInput,
        stage_id: StageId.optional().describe(
          'Id of the stage to move the task to (the pipeline is in your instructions).',
        ),
        add_labels: z
          .array(z.string().trim().min(1).max(MAX_LABEL_CHARS))
          .max(10)
          .optional()
          .describe('Label ids to add. A label of a group replaces the other labels of that group.'),
        remove_labels: z
          .array(z.string().trim().min(1).max(MAX_LABEL_CHARS))
          .max(10)
          .optional()
          .describe('Label ids to remove.'),
        note: z
          .string()
          .trim()
          .min(1)
          .max(MAX_NOTE_CHARS)
          .optional()
          .describe('Note for the timeline: findings, decisions, what changed; with labels, their comment.'),
        title: z
          .string()
          .trim()
          .min(1)
          .max(MAX_TITLE_CHARS)
          .optional()
          .describe('New title, short and specific.'),
        description: z
          .string()
          .trim()
          .min(1)
          .max(MAX_DESCRIPTION_CHARS)
          .optional()
          .describe(
            'New description (markdown). It replaces the whole description: read the current one with ' +
              'get_task first, all of it if it says it is cut.',
          ),
        repo: z
          .string()
          .trim()
          .min(1)
          .max(MAX_REPO_CHARS)
          .nullable()
          .optional()
          .describe('Project repository the task works in; null clears it. Refused while a session runs.'),
        add_relations: z
          .array(addedRelationInput)
          .max(10)
          .optional()
          .describe(
            'Relations of this card to other cards to add. ' +
              ADDED_RELATIONS_HELP +
              ' A refused relation (a prerequisite loop, itself, another project) refuses the whole call.',
          ),
        remove_relations: z
          .array(
            z.object({
              kind: TaskRelationKind.describe('The relation as this card sees it, also a reverse one.'),
              task_key: taskKeyInput.describe('The other card.'),
            }),
          )
          .max(10)
          .optional()
          .describe('Relations of this card to other cards to remove; removals apply before additions.'),
        theme_key: taskKeyInput
          .nullable()
          .optional()
          .describe('The open theme this card belongs to; null removes it. Not for subtasks and themes.'),
        priority: TaskPriority.nullable()
          .optional()
          .describe(
            "The card priority; null clears it. People may set it; an AI member only when the project's priority setting allows it.",
          ),
        despite_prerequisites: z
          .boolean()
          .optional()
          .describe(
            'Move into the work stage despite an open prerequisite. Honored only for a person, or for the ' +
              'project manager when the project settings allow it (team.prerequisiteOverride); otherwise the ' +
              "card's work start waits for its prerequisites.",
          ),
        acceptance: z.array(acceptanceChangeInput).max(20).optional().describe(ACCEPTANCE_HELP),
      },
      external: { access: 'write', run: runUpdateTask },
      run: runUpdateTask,
    }),
    defineTool({
      name: 'create_task',
      refused: {
        ...DEVELOPER_LEVEL_REFUSED,
        visibility: TASK_VISIBILITY_REMOVED,
        priority:
          'priority cannot be given when a card is created. Set it afterwards with update_task priority, if the ' +
          "project's priority setting allows it. " +
          'Urgent cards start first and are pulled into development by the system; the other levels only inform.',
      },
      title: 'Create a task',
      readOnly: false,
      description:
        'Create a new task, for example a card for a bug you found, one part of a request you split, or ' +
        'follow-up work. It starts unassigned in the first stage, where humans prioritise it; it does not ' +
        'start any work. Give it a self-contained description. If it came from another task, note the new ' +
        'key there with update_task. kind "theme" creates a theme instead: a card that groups other cards ' +
        '(an epic), open or closed, in no stage, with no assignee and no work.',
      input: {
        kind: z
          .enum(['task', 'theme'])
          .optional()
          .describe('task (default) or theme: a card that groups other cards; no stage, no work.'),
        theme_key: taskKeyInput
          .optional()
          .describe('The theme the new card belongs to: an open card of kind theme in this project.'),
        parent_key: taskKeyInput
          .optional()
          .describe('Parent task in this project; must not itself be a subtask.'),
        title: z.string().trim().min(1).max(MAX_TITLE_CHARS).describe('Short, specific title.'),
        description: z
          .string()
          .trim()
          .max(MAX_DESCRIPTION_CHARS)
          .optional()
          .describe(
            'Markdown: what and why, and what done means (for a bug: steps to reproduce, expected and ' +
              'actual behaviour, environment). Mention the task it came from, if any.',
          ),
        labels: z
          .array(z.string().trim().min(1).max(MAX_LABEL_CHARS))
          .max(10)
          .optional()
          .describe('Labels, e.g. ["bug"].'),
        relations: z
          .array(addedRelationInput)
          .max(10)
          .optional()
          .describe(
            'Relations of the new card to other cards, as add_relations of update_task. One refused ' +
              'relation refuses the creation.',
          ),
        acceptance: z
          .array(acceptanceTextInput)
          .max(40)
          .optional()
          .describe(
            'The acceptance conditions of the card, one per item: each checkable on its own, so the assignee ' +
              'can mark it done with evidence and the reviewer confirm it.',
          ),
        complexity: complexityInput,
        complexity_reason: complexityReasonInput,
      },
      external: { access: 'write', run: runCreateTask },
      run: runCreateTask,
    }),
  ],
};
