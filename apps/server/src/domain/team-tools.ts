import {
  isOpenTask,
  memberOf,
  questionChoices,
  TaskStatus as TaskStatusSchema,
  TaskKey,
} from '@projectman/shared';
import type {
  InboxOption,
  MemberView,
  ProjectConfig,
  QuestionOptionInput,
  Task,
  TaskDetail,
  Visibility,
} from '@projectman/shared';
import { TeamToolError } from '../contracts';
import type {
  GithubService,
  ListTasksInput,
  MemberMemoryStore,
  TaskSummary,
  TeamToolsHandler,
  ToolContext,
} from '../contracts';
import type { DomainContext } from './context';
import { DomainError } from './errors';
import type { ApprovalRequirement, UnmetCondition } from '@projectman/shared';
import type { GithubSync } from './github-sync';
import { ANSWER_OPTION, sponsorOrOwners } from './inbox';
import type { InboxService } from './inbox';
import type { MemberService } from './members';
import type { Messaging } from './messaging';
import type { ProjectService } from './projects';
import type { TaskService } from './tasks';
import type { TimelineService } from './timeline';
import { aiActor, unique } from './util';

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** Explains a blocked stage move to the agent in plain English. */
function describeGateBlock(err: DomainError): string {
  const details = (err.details ?? {}) as { unmet?: UnmetCondition[]; approvals?: ApprovalRequirement[] };
  const reasons = (details.unmet ?? []).map((u) =>
    u.condition.type === 'has_label'
      ? `the label "${u.condition.label}" is missing (required to enter stage "${u.stageId}")`
      : `the label "${u.condition.label}" is on the task and holds it back (stage "${u.stageId}")`,
  );
  if (reasons.length === 0 && details.approvals?.length) {
    reasons.push(
      ...details.approvals.map(
        (a) =>
          `stage "${a.stageId}" needs a human approval (label "${a.label}", from ${a.approvers.join(' or ')})`,
      ),
    );
  }
  return reasons.length > 0
    ? `The stage move is blocked: ${reasons.join('; ')}. Nothing from this call was recorded; ` +
        'send the labels and the note again, without stage_id or once the gate is met.'
    : err.message;
}

/** The send_message refusals of the messaging module, in the words the agent reads. */
function toMessageToolError(err: unknown): unknown {
  if (!(err instanceof DomainError)) return err;
  const details = (err.details ?? {}) as { field?: string; what?: string; ids?: string[] };
  if (err.code === 'invalid_request' && details.field === 'text')
    return new TeamToolError('invalid', 'The message text is empty.');
  if (err.code === 'invalid_request' && details.field === 'to')
    return new TeamToolError('invalid', 'No recipients: name at least one team member other than yourself.');
  if (err.code === 'not_found' && details.what === 'member' && details.ids)
    return new TeamToolError(
      'not_found',
      `Unknown team members: ${details.ids.join(', ')}. Use list_members to see the handles.`,
    );
  return err;
}

function toToolError(err: unknown): unknown {
  if (err instanceof TeamToolError || !(err instanceof DomainError)) return err;
  if (err.code === 'not_found') return new TeamToolError('not_found', err.message);
  if (err.status === 403) return new TeamToolError('forbidden', err.message);
  if (err.code === 'gate_blocked' || err.code === 'approval_requested') {
    return new TeamToolError('gate_blocked', describeGateBlock(err));
  }
  return new TeamToolError('invalid', err.message);
}

/**
 * The team tools behind the MCP server (mcp__team__*): they check the arguments, call the
 * domain services and put their refusals in words the agent reads. Every action is attributed
 * to the calling AI member.
 */
export class TeamToolsService implements TeamToolsHandler {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly tasks: TaskService;
  private readonly members: MemberService;
  private readonly messaging: Messaging;
  private readonly inbox: InboxService;
  private readonly timeline: TimelineService;
  private readonly memory: MemberMemoryStore;
  private readonly github: GithubService;
  private readonly githubSync: GithubSync;

  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    tasks: TaskService;
    members: MemberService;
    messaging: Messaging;
    inbox: InboxService;
    timeline: TimelineService;
    memory: MemberMemoryStore;
    github: GithubService;
    githubSync: GithubSync;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.members = deps.members;
    this.messaging = deps.messaging;
    this.inbox = deps.inbox;
    this.timeline = deps.timeline;
    this.memory = deps.memory;
    this.github = deps.github;
    this.githubSync = deps.githubSync;
  }

  async sendMessage(
    ctx: ToolContext,
    args: { to: string[]; text: string; taskKey?: string },
  ): Promise<{ messageId: string; deliveredTo: string[] }> {
    return this.guard(async () => {
      await this.caller(ctx);
      const taskKey = this.taskKeyFor(ctx, args.taskKey);
      // Humans have it in their messages now; AI recipients get it typed into their session
      // for the work item as soon as that session is idle (queued, never awaited here).
      const message = await this.messaging
        .send(
          ctx.projectKey,
          ctx.member,
          { to: args.to, text: args.text, taskKey },
          { actor: aiActor(ctx.member), sessionId: ctx.sessionId },
        )
        .catch((err: unknown) => {
          throw toMessageToolError(err);
        });
      return { messageId: message.id, deliveredTo: message.to };
    });
  }

  async listMembers(ctx: ToolContext): Promise<MemberView[]> {
    return this.guard(async () => this.members.rosterFor(await this.caller(ctx)));
  }

  async listTasks(ctx: ToolContext, args: ListTasksInput): Promise<TaskSummary[]> {
    return this.guard(async () => {
      await this.caller(ctx);
      const status = args.status ?? 'open';
      const limit = args.limit ?? 50;
      if (status !== 'open' && !TaskStatusSchema.safeParse(status).success) {
        throw new TeamToolError('invalid', 'Invalid task status.');
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw new TeamToolError('invalid', 'limit must be an integer between 1 and 200.');
      }
      const assignee = args.assignee === 'me' ? ctx.member : args.assignee;
      return this.tasks
        .list(ctx.projectKey)
        .filter(
          (task) =>
            (status === 'open' ? isOpenTask(task) : task.status === status) &&
            (args.stage === undefined || task.stageId === args.stage) &&
            (assignee === undefined || task.assignee === assignee),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.key.localeCompare(b.key))
        .slice(0, limit)
        .map(({ key, title, stageId, status, assignee, labels, updatedAt }) => ({
          key,
          title,
          stageId,
          status,
          assignee,
          labels,
          updatedAt,
        }));
    });
  }

  async getTask(ctx: ToolContext, args: { taskKey: string }): Promise<TaskDetail> {
    return this.guard(async () => {
      await this.caller(ctx);
      return this.tasks.detail(ctx.projectKey, this.validTaskKey(ctx, args.taskKey), 50);
    });
  }

  async updateTask(
    ctx: ToolContext,
    args: {
      taskKey: string;
      stageId?: string;
      addLabels?: string[];
      removeLabels?: string[];
      note?: string;
      title?: string;
      description?: string;
    },
  ): Promise<{ task: Task }> {
    return this.guard(async () => {
      const config = await this.caller(ctx);
      const taskKey = this.validTaskKey(ctx, args.taskKey);
      // The whole call is one change, all or nothing: title, description, labels and note are
      // recorded before the stage move, so one call can add "code review ok" and pass the gate.
      if (args.stageId && !config.pipeline.stages.some((s) => s.id === args.stageId)) {
        throw new TeamToolError(
          'invalid',
          `Unknown stage "${args.stageId}". Stages in pipeline order: ` +
            `${config.pipeline.stages.map((s) => s.id).join(', ')}.`,
        );
      }
      const title = args.title?.trim();
      if (args.title !== undefined && !title) throw new TeamToolError('invalid', 'The title is empty.');
      const description = args.description?.trim();
      if (args.description !== undefined && !description) {
        throw new TeamToolError('invalid', 'The description is empty; pass the whole new description.');
      }
      try {
        const task = await this.tasks.update(
          ctx.projectKey,
          taskKey,
          {
            title,
            description,
            addLabels: args.addLabels,
            removeLabels: args.removeLabels,
            note: args.note,
            stageId: args.stageId,
          },
          aiActor(ctx.member),
          { sessionId: ctx.sessionId },
        );
        return { task };
      } catch (err) {
        if (err instanceof DomainError && err.code === 'approval_requested') {
          const { approvers } = err.details as { approvers: string[] };
          throw new TeamToolError(
            'gate_blocked',
            `Moving ${taskKey} to ${args.stageId} needs a human approval. It was requested from ` +
              `${approvers.join(', ')}; the task moves automatically once they approve. The rest of this ` +
              'call was recorded.',
          );
        }
        throw err;
      }
    });
  }

  async createTask(
    ctx: ToolContext,
    args: {
      title: string;
      description?: string;
      labels?: string[];
      visibility?: Visibility;
      parentKey?: string;
    },
  ): Promise<{ task: Task }> {
    return this.guard(async () => {
      await this.caller(ctx);
      const title = args.title.trim();
      if (!title) throw new TeamToolError('invalid', 'The title is empty.');
      const labels = unique((args.labels ?? []).map((l) => l.trim()).filter(Boolean));
      // No stage: a new task starts in the pipeline's first (queue) stage, where humans prioritise it.
      const task = await this.tasks.create(
        ctx.projectKey,
        {
          title,
          parentKey: args.parentKey,
          description: args.description?.trim() ?? '',
          labels,
          visibility: args.visibility ?? 'internal',
        },
        aiActor(ctx.member),
        { sessionId: ctx.sessionId },
      );
      return { task };
    });
  }

  async linkPullRequest(
    ctx: ToolContext,
    args: { taskKey: string; repo: string; number: number },
  ): Promise<{ task: Task }> {
    return this.guard(async () => {
      await this.caller(ctx);
      const taskKey = this.validTaskKey(ctx, args.taskKey);
      if (!REPO_RE.test(args.repo))
        throw new TeamToolError('invalid', 'repo must look like "owner/name" (the GitHub repository).');
      if (!Number.isInteger(args.number) || args.number <= 0)
        throw new TeamToolError('invalid', 'number must be the positive number of the pull request.');
      let title: string | undefined;
      let state: string | undefined;
      try {
        const pr = await this.github.getPullRequest(args.repo, args.number);
        this.tasks.recordPullRequest(pr);
        title = pr.title;
        state = pr.state;
      } catch (err) {
        this.ctx.logger.warn(
          { err, repo: args.repo, number: args.number },
          'could not fetch the pull request',
        );
      }
      const task = this.tasks.addLink(
        ctx.projectKey,
        taskKey,
        { kind: 'pull_request', ref: String(args.number), repo: args.repo, title, state },
        aiActor(ctx.member),
        ctx.sessionId,
      );
      if (state !== 'merged' && state !== 'closed') this.githubSync.watch(args.repo, args.number);
      return { task };
    });
  }

  async askHuman(
    ctx: ToolContext,
    args: {
      question: string;
      options?: QuestionOptionInput[];
      taskKey?: string;
      to?: string[];
      recommended?: string;
      recommendationReason?: string;
      details?: string;
    },
  ): Promise<{ inboxItemId: string }> {
    return this.guard(async () => {
      const config = await this.caller(ctx);
      const question = args.question.trim();
      if (!question) throw new TeamToolError('invalid', 'The question is empty.');
      const taskKey = this.taskKeyFor(ctx, args.taskKey);
      let assignees: string[];
      if (args.to && args.to.length > 0) {
        const notHuman = args.to.filter((h) => memberOf(config, h)?.kind !== 'human');
        if (notHuman.length > 0)
          throw new TeamToolError(
            'invalid',
            `ask_human can only ask human members; these are not: ${notHuman.join(', ')}.`,
          );
        assignees = unique(args.to);
      } else {
        assignees = sponsorOrOwners(config, ctx.member);
      }
      const choices = questionChoices(args.options);
      const recommended = args.recommended?.trim();
      const reason = args.recommendationReason?.trim();
      const details = args.details?.trim();
      // The team tool checks this at its boundary; a direct caller gets the same answer.
      const recommendedIndex = recommended ? choices.findIndex((choice) => choice.label === recommended) : -1;
      if (recommended && recommendedIndex < 0) {
        throw new TeamToolError(
          'invalid',
          `The recommended option "${recommended}" is not one of the options.`,
        );
      }
      if (reason && !recommended) {
        throw new TeamToolError('invalid', 'A recommendation reason needs a recommended option.');
      }
      // The recommended option is the primary button; without a recommendation the first one is.
      const primary = Math.max(recommendedIndex, 0);
      const options: InboxOption[] = [
        ...choices.map((choice, i): InboxOption => ({
          id: `option_${i + 1}`,
          label: choice.label,
          style: i === primary ? 'primary' : 'secondary',
          ...(choice.consequence ? { consequence: choice.consequence } : {}),
        })),
        ANSWER_OPTION,
      ];
      const item = this.inbox.create({
        projectKey: ctx.projectKey,
        kind: 'question',
        assignees,
        source: ctx.member,
        sessionId: ctx.sessionId,
        taskKey,
        title: question,
        payload: {
          question,
          options: choices.map((choice) => choice.label),
          ...(recommendedIndex >= 0 ? { recommended: options[recommendedIndex]!.id } : {}),
          ...(reason ? { recommendationReason: reason } : {}),
          ...(details ? { details } : {}),
        },
        options,
      });
      this.timeline.append({
        projectKey: ctx.projectKey,
        taskKey,
        sessionId: ctx.sessionId,
        actor: aiActor(ctx.member),
        type: 'question_asked',
        data: { inboxItemId: item.id, question },
      });
      return { inboxItemId: item.id };
    });
  }

  async saveMemory(ctx: ToolContext, args: { note: string }): Promise<{ ok: true }> {
    return this.guard(async () => {
      await this.caller(ctx);
      const note = args.note.trim();
      if (!note) throw new TeamToolError('invalid', 'The memory note is empty.');
      await this.memory.append(ctx.projectKey, ctx.member, note);
      return { ok: true as const };
    });
  }

  /** The caller must still be an AI member of the project. */
  private async caller(ctx: ToolContext): Promise<ProjectConfig> {
    const config = await this.projects.config(ctx.projectKey);
    const member = memberOf(config, ctx.member);
    if (member?.kind !== 'ai')
      throw new TeamToolError(
        'forbidden',
        `${ctx.member} is not an active AI member of this team, so the team tools are not available.`,
      );
    return config;
  }

  /** A task key of the caller's project. */
  private validTaskKey(ctx: ToolContext, taskKey: string): string {
    if (!TaskKey.safeParse(taskKey).success)
      throw new TeamToolError(
        'invalid',
        `Invalid task key "${taskKey}"; task keys look like "${ctx.projectKey}-12".`,
      );
    if (!this.tasks.find(ctx.projectKey, taskKey))
      throw new TeamToolError('not_found', `Task ${taskKey} does not exist in this project.`);
    return taskKey;
  }

  /** The explicit task key, else the session's task, else null. */
  private taskKeyFor(ctx: ToolContext, taskKey: string | undefined): string | null {
    const key = taskKey ?? ctx.taskKey;
    return key ? this.validTaskKey(ctx, key) : null;
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw toToolError(err);
    }
  }
}
