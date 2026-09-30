import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import {
  CheckName,
  CheckState,
  MemberHandle,
  StageId,
  TaskKey,
  TaskStatus,
  Visibility,
} from '@projectman/shared';
import { z } from 'zod';
import { TeamToolError, type TeamToolsHandler, type ToolContext } from '../contracts';
import {
  formatLinkedPullRequest,
  formatMembers,
  formatQuestionAsked,
  formatSentMessage,
  formatTaskCreated,
  formatTaskDetail,
  formatTaskUpdate,
} from './format';

/**
 * The team tools as Claude sees them (mcp__team__<name>). Names, descriptions and input
 * schemas are the prompt: they tell the model when and how to use each tool. Input is
 * validated by the MCP SDK against the zod schema before `run` is called.
 */

export const TEAM_TOOL_NAMES = [
  'send_message',
  'list_members',
  'get_task',
  'list_tasks',
  'update_task',
  'create_task',
  'link_pull_request',
  'ask_human',
  'save_memory',
] as const;
export type TeamToolName = (typeof TEAM_TOOL_NAMES)[number];

/** Server-level instructions, sent once at initialization (Claude Code adds them to the system prompt). */
export const TEAM_INSTRUCTIONS = [
  'Team tools connect you with your team in projectman: humans and other AI members.',
  '- Address teammates by handle (e.g. "qa", "fe-1"); list_members shows who is who.',
  '- Text you write in your own session reaches nobody. To tell a teammate something, or to answer a ' +
    '"[team message from <handle> ...]", use send_message.',
  "- Be concise. Write messages, notes and questions in the project's language.",
  '- Record check results, stage moves and notes with update_task instead of only mentioning them in text.',
  '- Propose new work with create_task: it waits unassigned in the first stage until humans prioritise it.',
  '- Link pull requests with link_pull_request as soon as they exist.',
  '- When a human decision or information is needed, use ask_human; the answer arrives later as a team message.',
  '- Keep durable learnings with save_memory.',
].join('\n');

const MAX_MESSAGE_CHARS = 20_000;
const MAX_NOTE_CHARS = 10_000;
const MAX_TITLE_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 20_000;
const MAX_LABEL_CHARS = 40;
const MAX_QUESTION_CHARS = 4_000;
const MAX_OPTION_CHARS = 200;
const MAX_MEMORY_CHARS = 2_000;

export interface ToolRun<Args> {
  ctx: ToolContext;
  args: Args;
  handler: TeamToolsHandler;
}

export interface TeamTool {
  readonly name: TeamToolName;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.ZodObject;
  readonly annotations: ToolAnnotations;
  /** Runs the tool with validated arguments and returns the text result. */
  run(call: ToolRun<Record<string, unknown>>): Promise<string>;
}

type ToolInput<Shape extends z.core.$ZodLooseShape> = z.output<z.ZodObject<Shape, z.core.$strict>>;

function defineTool<Shape extends z.core.$ZodLooseShape>(def: {
  name: TeamToolName;
  title: string;
  description: string;
  readOnly: boolean;
  input: Shape;
  run(call: ToolRun<ToolInput<Shape>>): Promise<string>;
}): TeamTool {
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    // Strict: an unknown key (e.g. a misspelled parameter) is an error instead of being ignored.
    inputSchema: z.strictObject(def.input),
    annotations: {
      title: def.title,
      readOnlyHint: def.readOnly,
      destructiveHint: false,
      openWorldHint: false,
    },
    // The SDK has already validated the arguments against inputSchema.
    run: async (call) => def.run(call as ToolRun<ToolInput<Shape>>),
  };
}

const unique = <T>(items: T[]): T[] => [...new Set(items)];

const taskKeyInput = TaskKey.describe('Task key, e.g. "AR-21".');

export const TEAM_TOOLS: readonly TeamTool[] = [
  defineTool({
    name: 'send_message',
    title: 'Send a team message',
    readOnly: false,
    description:
      'Send a message to teammates (humans or AI members), addressed by handle. AI members receive it in ' +
      'their session for the task; humans see it in the app. This is the only way to reach a teammate: ' +
      'text in your own session is not delivered. Use it to hand over work, report findings or reply to a ' +
      "team message. Be concise and specific, in the project's language.",
    input: {
      to: z
        .array(MemberHandle)
        .min(1)
        .max(20)
        .describe('Recipient handles, e.g. ["qa"] or ["fe-1", "owner"]. Handles only, without "@".'),
      text: z
        .string()
        .trim()
        .min(1)
        .max(MAX_MESSAGE_CHARS)
        .describe(
          "The message, in the project's language. Include what the recipient needs to act on it " +
            '(task, PR, findings, what you expect from them).',
        ),
      task_key: TaskKey.optional().describe(
        'Task the message is about, e.g. "AR-21". Defaults to the task of your current session.',
      ),
    },
    async run({ ctx, args, handler }) {
      // A message to oneself would be typed back into the caller's own session.
      const to = unique(args.to).filter((handle) => handle !== ctx.member);
      if (to.length === 0) {
        throw new TeamToolError(
          'invalid',
          'You cannot send a message to yourself; address teammates by handle (see list_members).',
        );
      }
      const taskKey = args.task_key ?? ctx.taskKey;
      const result = await handler.sendMessage(ctx, {
        to,
        text: args.text,
        ...(taskKey ? { taskKey } : {}),
      });
      return formatSentMessage({ ...result, requested: to, taskKey });
    },
  }),

  defineTool({
    name: 'list_members',
    title: 'List team members',
    readOnly: true,
    description:
      'List the team: handle, name, human or AI, role, status and current tasks. Use it to find the right ' +
      'teammate to address (by handle) and to see who is busy with what.',
    input: {},
    async run({ ctx, handler }) {
      return formatMembers(await handler.listMembers(ctx), ctx.member);
    },
  }),

  defineTool({
    name: 'list_tasks',
    title: 'List tasks',
    readOnly: true,
    description:
      'Read the project board as a compact list, newest update first. Defaults to open tasks ' +
      '(active, waiting or blocked). Filter by status, stage or assignee; use get_task for details.',
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
      'Get a task: title, description, stage, status, assignee, checks, links (pull requests, branches) and ' +
      'its parent, subtasks (keys, titles, stages, statuses), and recent timeline (who did what).',
    input: { task_key: taskKeyInput },
    async run({ ctx, args, handler }) {
      return formatTaskDetail(await handler.getTask(ctx, { taskKey: args.task_key }));
    },
  }),

  defineTool({
    name: 'update_task',
    title: 'Update a task',
    readOnly: false,
    description:
      'Record progress on a task: record a check result, add a note, rewrite its title or description ' +
      '(for example a specification with acceptance criteria, or a technical plan) and/or move it to ' +
      'another stage. Always record the outcome of a code review, security review, QA or client test here ' +
      '(check + a short note with the findings): saying it only in text does not update the task. Stage ' +
      'gates are enforced: a move is refused while its gate (a passed check, a merged PR or a human ' +
      'approval) is not met. In one call everything else is recorded before the stage move.',
    input: {
      task_key: taskKeyInput,
      stage_id: StageId.optional().describe(
        'Stage to move the task to, e.g. "qa" (a stage id of the project pipeline).',
      ),
      check: z
        .strictObject({
          name: CheckName.describe('Which check.'),
          state: CheckState.describe(
            'Result: passed, failed (problems found), blocked (cannot be done now), retest_needed or pending.',
          ),
        })
        .optional()
        .describe('Check result to record, e.g. {"name": "code_review", "state": "passed"}.'),
      note: z
        .string()
        .trim()
        .min(1)
        .max(MAX_NOTE_CHARS)
        .optional()
        .describe(
          "Note for the task timeline, in the project's language: findings, decisions, what changed.",
        ),
      title: z
        .string()
        .trim()
        .min(1)
        .max(MAX_TITLE_CHARS)
        .optional()
        .describe("New title, short and specific, in the project's language."),
      description: z
        .string()
        .trim()
        .min(1)
        .max(MAX_DESCRIPTION_CHARS)
        .optional()
        .describe(
          'New description (markdown). It replaces the whole description, so include everything that ' +
            'should stay; read the current one with get_task first.',
        ),
    },
    async run({ ctx, args, handler }) {
      const { task_key: taskKey, stage_id: stageId, check, note, title, description } = args;
      if (!stageId && !check && !note && !title && !description) {
        throw new TeamToolError(
          'invalid',
          'Nothing to update: pass stage_id, check, note, title and/or description.',
        );
      }
      const { task } = await handler.updateTask(ctx, {
        taskKey,
        ...(stageId ? { stageId } : {}),
        ...(check ? { check } : {}),
        ...(note ? { note } : {}),
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
      });
      return formatTaskUpdate(task, {
        stageId,
        check,
        note: !!note,
        title: !!title,
        description: !!description,
      });
    },
  }),

  defineTool({
    name: 'create_task',
    title: 'Create a task',
    readOnly: false,
    description:
      'Create a new task, for example a card for a reported bug, one part of a request you split, or ' +
      'follow-up work you found. It starts unassigned in the first stage of the pipeline, where humans ' +
      'prioritise it; it does not start any work. Give it a specific title and a self-contained ' +
      "description, in the project's language. Set parent_key for a one-level subtask in the same project.",
    input: {
      parent_key: taskKeyInput
        .optional()
        .describe('Parent task in this project; must not itself be a subtask.'),
      title: z
        .string()
        .trim()
        .min(1)
        .max(MAX_TITLE_CHARS)
        .describe("Short, specific title in the project's language."),
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
    },
    async run({ ctx, args, handler }) {
      const { task } = await handler.createTask(ctx, {
        title: args.title,
        ...(args.parent_key ? { parentKey: args.parent_key } : {}),
        ...(args.description ? { description: args.description } : {}),
        ...(args.labels ? { labels: unique(args.labels) } : {}),
        ...(args.visibility ? { visibility: args.visibility } : {}),
      });
      return formatTaskCreated(task);
    },
  }),

  defineTool({
    name: 'link_pull_request',
    title: 'Link a pull request',
    readOnly: false,
    description:
      'Attach a GitHub pull request to a task, so its checks, reviews and merge are tracked on the task. ' +
      'Call it right after opening the pull request.',
    input: {
      task_key: taskKeyInput,
      repo: z
        .string()
        .regex(/^[\w.-]+\/[\w.-]+$/, 'expected "owner/name"')
        .describe('GitHub repository as "owner/name".'),
      number: z.number().int().positive().describe('Pull request number.'),
    },
    async run({ ctx, args, handler }) {
      const { task } = await handler.linkPullRequest(ctx, {
        taskKey: args.task_key,
        repo: args.repo,
        number: args.number,
      });
      return formatLinkedPullRequest(task, args.repo, args.number);
    },
  }),

  defineTool({
    name: 'ask_human',
    title: 'Ask a human',
    readOnly: false,
    description:
      'Ask a human for a decision or information you cannot find or decide yourself (requirements, ' +
      'priorities, approvals, access, trade-offs). The question goes to their inbox; the answer arrives ' +
      'later in this session as a team message, so do not wait or poll for it. Ask one clear, self-contained ' +
      "question in the project's language.",
    input: {
      question: z
        .string()
        .trim()
        .min(1)
        .max(MAX_QUESTION_CHARS)
        .describe(
          "The question, in the project's language, with the context needed to answer it without opening " +
            'anything else.',
        ),
      options: z
        .array(z.string().trim().min(1).max(MAX_OPTION_CHARS))
        .min(1)
        .max(10)
        .optional()
        .describe('Suggested answers shown as buttons, e.g. ["Yes", "No"]. Omit for a free-text answer.'),
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
    },
    async run({ ctx, args, handler }) {
      const taskKey = args.task_key ?? ctx.taskKey;
      const to = args.to ? unique(args.to) : undefined;
      const { inboxItemId } = await handler.askHuman(ctx, {
        question: args.question,
        ...(args.options ? { options: args.options } : {}),
        ...(taskKey ? { taskKey } : {}),
        ...(to ? { to } : {}),
      });
      return formatQuestionAsked(inboxItemId, to);
    },
  }),

  defineTool({
    name: 'save_memory',
    title: 'Save to memory',
    readOnly: false,
    description:
      'Save a durable learning to your own memory; it is included in all your future sessions. Use it for ' +
      'lasting knowledge about the project, codebase, conventions or people, not for task progress or ' +
      'temporary state (record those with update_task).',
    input: {
      note: z
        .string()
        .trim()
        .min(1)
        .max(MAX_MEMORY_CHARS)
        .describe('The learning: one or two self-contained sentences.'),
    },
    async run({ ctx, args, handler }) {
      await handler.saveMemory(ctx, { note: args.note });
      return 'Saved to your memory; it will be part of your future sessions.';
    },
  }),
];
