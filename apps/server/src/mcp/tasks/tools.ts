import {
  AddableRelationKind,
  DEVELOPER_LEVEL_REASON_MAX,
  DeveloperLevel,
  MemberHandle,
  StageId,
  TaskPriority,
  TaskRelationKind,
  TaskStatus,
  Visibility,
} from '@projectman/shared';
import type { DeveloperLevelRequest } from '@projectman/shared';
import { z } from 'zod';
import { TeamToolError } from '../../contracts';
import { formatTaskCreated, formatTaskDetail, formatTaskUpdate, MAX_DESCRIPTION_CHARS } from '../format';

import { defineTool, type TeamToolGroup, unique, taskKeyInput } from '../kit';
const MAX_NOTE_CHARS = 10_000;

const developerLevelInput = DeveloperLevel.optional().describe(
  'The recommended developer of the card: senior (a task that suits the Senior; developer_level_reason is ' +
    'required) or any (any developer may take it). Only an owner, or a member who plans tasks or analyses ' +
    'requirements, may set it; it can be changed on a card that has started too, and it does not replace the ' +
    'developer who already carries the card.',
);

const developerLevelReasonInput = z
  .string()
  .trim()
  .min(1)
  .max(DEVELOPER_LEVEL_REASON_MAX)
  .optional()
  .describe(
    `Why the card is recommended for that developer, at most ${DEVELOPER_LEVEL_REASON_MAX} characters; ` +
      'required with developer_level senior, and only with developer_level.',
  );

/** The recommended developer the call asked for; a reason without a level is refused. */
function developerLevelArg(args: {
  developer_level?: DeveloperLevel | undefined;
  developer_level_reason?: string | undefined;
}): DeveloperLevelRequest | undefined {
  if (args.developer_level === undefined) {
    if (args.developer_level_reason !== undefined)
      throw new TeamToolError('invalid', 'developer_level_reason needs developer_level: pass both.');
    return undefined;
  }
  return { level: args.developer_level, reason: args.developer_level_reason ?? null };
}

const MAX_TITLE_CHARS = 200;

const MAX_LABEL_CHARS = 40;

const MAX_REPO_CHARS = 64;

const ADDED_RELATIONS_HELP =
  'part_of: this card is part of the other (a one-level subtask, same project); prerequisite: this card ' +
  'can only be done after the other (order cards with this, not with a "Dependencies" text in the ' +
  'description); related: the cards belong together (follow-up work too), nothing more; duplicate_of: ' +
  'this card duplicates the other and is closed (cancelled) pointing at it. You can mark only a card ' +
  'that has not started (waiting in a queue stage, no session) as a duplicate; a card that has started ' +
  'can be marked only by an admin or the owner. Point at the original, never at another duplicate.';

const addedRelationInput = z.object({
  kind: AddableRelationKind.describe(ADDED_RELATIONS_HELP),
  task_key: taskKeyInput.describe('The other card, in this project.'),
});
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
        'theme (a card that groups other cards) is marked kind "theme"; it is in no stage, so a stage filter ' +
        'leaves themes out. A card in the project focus (what the team works on now) carries its place as ' +
        '"focus" (position, and via: the theme or card that covers it).',
      input: {
        status: z.union([z.literal('open'), TaskStatus]).default('open'),
        stage: StageId.optional(),
        assignee: MemberHandle.optional().describe('Member handle, or "me" for your own tasks.'),
        limit: z.number().int().min(1).max(200).default(50),
      },
      async run({ ctx, args, handler }) {
        return JSON.stringify(await handler.listTasks(ctx, args));
      },
    }),
    defineTool({
      name: 'get_task',
      title: 'Get a task',
      readOnly: true,
      description:
        'Get a task: title, description, stage, status, assignee, labels, links (pull requests, branches) and ' +
        'its relations to other cards by kind (part of, prerequisite, related, duplicate of, both ' +
        'directions: key, title, stage, status), its place in the project focus (what the team works on ' +
        'now), its theme (key, title, status; a theme shows its cards, ' +
        'collecting cards with their subtasks, and its progress), its parent, subtasks (keys, titles, stages, statuses), attachments (open one with read_attachment) and ' +
        'recent timeline (who did what). The description is shown whole up to ' +
        `${MAX_DESCRIPTION_CHARS} characters; a longer one is shown in parts, and the result says how to ` +
        'read the rest. The timeline shows a long note, question or answer cut; with event_id (named on the ' +
        'cut line) the call returns that one text whole instead of the task.',
      input: {
        task_key: taskKeyInput,
        event_id: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .optional()
          .describe(
            'Id of a timeline event of this task: returns its whole text. Only needed when a timeline line ' +
              'says it is cut, and it names the id.',
          ),
        description_offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            'Show the description from this character on (default 0). Only needed when an earlier get_task ' +
              'said the description is cut, and it names the offset.',
          ),
      },
      async run({ ctx, args, handler }) {
        const event = args.event_id === undefined ? {} : { eventId: args.event_id };
        return formatTaskDetail(await handler.getTask(ctx, { taskKey: args.task_key, ...event }), {
          descriptionOffset: args.description_offset ?? 0,
        });
      },
    }),
    defineTool({
      name: 'update_task',
      title: 'Update a task',
      readOnly: false,
      description:
        'Record progress on a task: add or remove labels, add a note, rewrite its title or description ' +
        '(for example a specification with acceptance criteria, or a technical plan), set the repository ' +
        'it works in and/or move it to another stage. The outcome of a review, a test or a client answer ' +
        "is a label from the project's label list (in your instructions: meaning, who may set it). Some " +
        'labels require a note, and labels only humans may set (approvals) are refused. Stage gates are ' +
        'enforced: a move is refused while a label its gate requires is missing or a blocking label is on ' +
        'the task. One call is all or nothing: labels and the note are recorded before the stage move, and ' +
        'if a label is refused or the gate blocks the move, nothing is recorded. A move that needs a human ' +
        'approval records the rest and waits for the approval. Relations between cards (part of, prerequisite, ' +
        'related, duplicate of) are set with add_relations and removed with remove_relations, in the same ' +
        'call: give the order of work as a prerequisite relation, not as a "Dependencies" text in the ' +
        'description. You cannot mark a card that has started as a duplicate. theme_key puts the card into a ' +
        'theme (an open card of kind theme in this project; null removes it); a card belongs to one theme, ' +
        'a subtask takes the theme of its parent and cannot be given one, and a theme cannot be given one or ' +
        'moved. developer_level (with developer_level_reason) sets the recommended developer of the card.',
      input: {
        task_key: taskKeyInput,
        developer_level: developerLevelInput,
        developer_level_reason: developerLevelReasonInput,
        stage_id: StageId.optional().describe(
          'Id of the stage to move the task to (the pipeline is in your instructions).',
        ),
        add_labels: z
          .array(z.string().trim().min(1).max(MAX_LABEL_CHARS))
          .max(10)
          .optional()
          .describe(
            "Label ids to add (the project's labels are listed in your instructions). A label of a group " +
              'replaces the other labels of that group.',
          ),
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
          .describe(
            'Note for the task timeline: findings, decisions, what changed. With labels it is the comment ' +
              'explaining them.',
          ),
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
            'New description (markdown). It replaces the whole description, so include everything that ' +
              'should stay; read the current one with get_task first, all of it if get_task says it is cut.',
          ),
        repo: z
          .string()
          .trim()
          .min(1)
          .max(MAX_REPO_CHARS)
          .nullable()
          .optional()
          .describe(
            'Name of the repository the task works in, one of the project repositories (an unknown name is ' +
              'refused, and the refusal lists them); null clears it. Refused while a session of the task is ' +
              'running, yours included.',
          ),
        add_relations: z
          .array(addedRelationInput)
          .max(10)
          .optional()
          .describe(
            'Relations of this card to other cards to add. ' +
              ADDED_RELATIONS_HELP +
              ' A loop of prerequisites, a card to itself and a card of another project are refused with the ' +
              'reason; so is the whole call.',
          ),
        remove_relations: z
          .array(
            z.object({
              kind: TaskRelationKind.describe(
                'The relation as this card sees it: part_of, has_part, prerequisite, prerequisite_of, related, ' +
                  'duplicate_of or duplicated_by (the reverse of a relation another card set is removable too). ' +
                  'Removing a duplicate relation does not reopen the card.',
              ),
              task_key: taskKeyInput.describe('The other card.'),
            }),
          )
          .max(10)
          .optional()
          .describe('Relations of this card to other cards to remove; removals apply before additions.'),
        theme_key: taskKeyInput
          .nullable()
          .optional()
          .describe(
            'The theme this card belongs to (a theme of this project that is open); null removes it.',
          ),
        priority: TaskPriority.nullable()
          .optional()
          .describe(
            'The card priority: urgent, high, normal or low; null clears it. Only people and the project ' +
              'manager may set it; others are refused. Urgent cards start first and are pulled into ' +
              'development by the system; the other levels only inform.',
          ),
      },
      async run({ ctx, args, handler }) {
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
        } = args;
        const developerLevel = developerLevelArg(args);
        if (
          !stageId &&
          themeKey === undefined &&
          priority === undefined &&
          !developerLevel &&
          !addLabels?.length &&
          !removeLabels?.length &&
          !note &&
          !title &&
          !description &&
          repo === undefined &&
          !addRelations?.length &&
          !removeRelations?.length
        ) {
          throw new TeamToolError(
            'invalid',
            'Nothing to update: pass stage_id, add_labels, remove_labels, note, title, description, repo, ' +
              'add_relations, remove_relations, theme_key, priority and/or developer_level.',
          );
        }
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
          ...(developerLevel ? { developerLevel } : {}),
        });
        const moverName =
          task.handOn && stageId
            ? (await handler.listMembers(ctx)).find((member) => member.handle === task.handOn!.mover)
                ?.displayName
            : undefined;
        return formatTaskUpdate(task, {
          ...(moverName ? { moverName } : {}),
          stageId,
          ...(priority !== undefined ? { priority } : {}),
          ...(developerLevel ? { developerLevel: true } : {}),
          ...(themeKey !== undefined ? { themeKey } : {}),
          labels: { added: addLabels ?? [], removed: removeLabels ?? [] },
          note: !!note,
          title: !!title,
          description: !!description,
          repo,
          relations,
        });
      },
    }),
    defineTool({
      name: 'create_task',
      refused: {
        priority:
          'priority is set by people only: AI members can read it (get_task, list_tasks) but cannot set it. ' +
          'Urgent cards start first and are pulled into development by the system; the other levels only inform.',
      },
      title: 'Create a task',
      readOnly: false,
      description:
        'Create a new task, for example a card for a reported bug, one part of a request you split, or ' +
        'follow-up work you found. It starts unassigned in the first stage of the pipeline, where humans ' +
        'prioritise it; it does not start any work. Give it a self-contained description. Set parent_key ' +
        'for a one-level subtask in the same project, and relations for the other relations to existing ' +
        'cards (a card it needs first is a prerequisite relation, not a "Dependencies" text). If it came ' +
        'from another task, note the new key there with update_task. kind "theme" creates a theme instead: ' +
        'a card that groups other cards (an epic) and is only open or closed; it is in no stage, has no ' +
        'assignee and no work is started on it. theme_key puts the new card into an open theme.',
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
        visibility: Visibility.optional().describe(
          'internal (default): only the team sees it; shared: client members see it too.',
        ),
        relations: z
          .array(addedRelationInput)
          .max(10)
          .optional()
          .describe(
            'Relations of the new card to other cards. ' +
              ADDED_RELATIONS_HELP +
              ' One refused relation refuses the creation.',
          ),
        developer_level: developerLevelInput,
        developer_level_reason: developerLevelReasonInput,
      },
      async run({ ctx, args, handler }) {
        const developerLevel = developerLevelArg(args);
        const { task } = await handler.createTask(ctx, {
          title: args.title,
          ...(developerLevel ? { developerLevel } : {}),
          ...(args.relations?.length
            ? { relations: args.relations.map((r) => ({ kind: r.kind, key: r.task_key })) }
            : {}),
          ...(args.parent_key ? { parentKey: args.parent_key } : {}),
          ...(args.kind === 'theme' ? { kind: args.kind } : {}),
          ...(args.theme_key ? { themeKey: args.theme_key } : {}),
          ...(args.description ? { description: args.description } : {}),
          ...(args.labels ? { labels: unique(args.labels) } : {}),
          ...(args.visibility ? { visibility: args.visibility } : {}),
        });
        return formatTaskCreated(task);
      },
    }),
  ],
};
