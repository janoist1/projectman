import { TaskStatus as TaskStatusSchema, CheckName, CheckState, TaskKey } from '@projectman/shared';
import type {
  InboxItem,
  InboxOption,
  MemberView,
  ProjectConfig,
  Task,
  TaskDetail,
  TaskStatus,
  Visibility,
  WorkItemRef,
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
import type { ApprovalRequirement, UnmetCondition } from './gates';
import type { GithubSync } from './github-sync';
import { ANSWER_OPTION, answerText, sponsorOrOwners } from './inbox';
import type { InboxService } from './inbox';
import type { MemberService } from './members';
import type { MessageService } from './messages';
import type { ProjectService } from './projects';
import type { SessionOrchestrator } from './sessions';
import type { TaskService } from './tasks';
import type { TimelineService } from './timeline';
import { aiActor, humanActor, unique } from './util';

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** Explains a blocked stage move to the agent in plain English. */
function describeGateBlock(err: DomainError): string {
  const details = (err.details ?? {}) as { unmet?: UnmetCondition[]; approvals?: ApprovalRequirement[] };
  const reasons = (details.unmet ?? []).map((u) => {
    if (u.condition.type === 'check_passed') {
      return `the "${u.condition.check}" check has not passed (required to enter stage "${u.stageId}")`;
    }
    if (u.condition.type === 'pr_merged') {
      return `the linked pull request is not merged (required to enter stage "${u.stageId}")`;
    }
    return `a condition of stage "${u.stageId}" is not met`;
  });
  if (reasons.length === 0 && details.approvals?.length) {
    reasons.push(
      ...details.approvals.map(
        (a) => `stage "${a.stageId}" needs an approval from ${a.approvers.join(' or ')}`,
      ),
    );
  }
  return reasons.length > 0 ? `The stage move is blocked: ${reasons.join('; ')}.` : err.message;
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
 * The team tools behind the MCP server (mcp__team__*). Every action is attributed to the
 * calling AI member. Messages about a task reach the recipient's session for that task.
 */
export class TeamToolsService implements TeamToolsHandler {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly tasks: TaskService;
  private readonly members: MemberService;
  private readonly sessions: SessionOrchestrator;
  private readonly messages: MessageService;
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
    sessions: SessionOrchestrator;
    messages: MessageService;
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
    this.sessions = deps.sessions;
    this.messages = deps.messages;
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
      const config = await this.caller(ctx);
      const text = args.text.trim();
      if (!text) throw new TeamToolError('invalid', 'The message text is empty.');
      const recipients = unique(args.to).filter((h) => h !== ctx.member);
      if (recipients.length === 0)
        throw new TeamToolError(
          'invalid',
          'No recipients: name at least one team member other than yourself.',
        );
      const unknown = recipients.filter((h) => !config.team.members.some((m) => m.handle === h));
      if (unknown.length > 0)
        throw new TeamToolError(
          'not_found',
          `Unknown team members: ${unknown.join(', ')}. Use list_members to see the handles.`,
        );
      const taskKey = this.taskKeyFor(ctx, args.taskKey);

      const aiRecipients = recipients.filter(
        (h) => config.team.members.find((m) => m.handle === h)?.kind === 'ai',
      );
      const message = this.messages.record({
        projectKey: ctx.projectKey,
        from: ctx.member,
        to: recipients,
        taskKey,
        body: text,
        actor: aiActor(ctx.member),
        sessionId: ctx.sessionId,
        delivered: aiRecipients.length === 0,
        humanRecipients: recipients.filter((h) => !aiRecipients.includes(h)),
      });
      const workItem: WorkItemRef = taskKey ? { type: 'task', taskKey } : { type: 'general' };
      this.deliverInBackground(ctx.projectKey, aiRecipients, workItem, message.id);
      // Humans have it in their messages now; AI recipients get it typed into their session
      // for the work item as soon as that session is idle (queued, never awaited here).
      return { messageId: message.id, deliveredTo: recipients };
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
      const openStatuses: TaskStatus[] = ['active', 'waiting', 'blocked'];
      return this.tasks
        .list(ctx.projectKey)
        .filter(
          (task) =>
            (status === 'open' ? openStatuses.includes(task.status) : task.status === status) &&
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
      check?: { name: CheckName; state: CheckState };
      note?: string;
      title?: string;
      description?: string;
    },
  ): Promise<{ task: Task }> {
    return this.guard(async () => {
      const config = await this.caller(ctx);
      const taskKey = this.validTaskKey(ctx, args.taskKey);
      const actor = aiActor(ctx.member);
      // Validate everything first, then apply: title, description, check and note before the
      // stage move, so one call can record "passed" and move through the gate that needs it.
      const name = args.check ? CheckName.safeParse(args.check.name) : null;
      const state = args.check ? CheckState.safeParse(args.check.state) : null;
      if (args.check && (!name?.success || !state?.success)) {
        throw new TeamToolError(
          'invalid',
          'Invalid check: name must be code_review, security_review, qa or client_test; ' +
            'state must be pending, passed, blocked, failed or retest_needed.',
        );
      }
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
      let task = this.tasks.get(ctx.projectKey, taskKey);
      if (title !== undefined || description !== undefined) {
        task = await this.tasks.update(
          ctx.projectKey,
          taskKey,
          {
            ...(title !== undefined ? { title } : {}),
            ...(description !== undefined ? { description } : {}),
          },
          actor,
          { sessionId: ctx.sessionId },
        );
      }
      if (name?.success && state?.success) {
        task = this.tasks.setCheck(ctx.projectKey, taskKey, name.data, state.data, actor, ctx.sessionId);
      }
      if (args.note?.trim()) {
        await this.tasks.addNote(ctx.projectKey, taskKey, args.note.trim(), actor, ctx.sessionId);
      }
      if (args.stageId && args.stageId !== task.stageId) {
        const result = await this.tasks.moveToStage(ctx.projectKey, taskKey, args.stageId, actor);
        if (!result.moved) {
          const approvers = unique(result.pendingApproval.flatMap((i) => i.assignees));
          throw new TeamToolError(
            'gate_blocked',
            `Moving ${taskKey} to ${args.stageId} needs a human approval. It was requested from ` +
              `${approvers.join(', ')}; the task moves automatically once they approve.`,
          );
        }
        task = result.task;
      }
      return { task };
    });
  }

  async createTask(
    ctx: ToolContext,
    args: { title: string; description?: string; labels?: string[]; visibility?: Visibility },
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
    args: { question: string; options?: string[]; taskKey?: string; to?: string[] },
  ): Promise<{ inboxItemId: string }> {
    return this.guard(async () => {
      const config = await this.caller(ctx);
      const question = args.question.trim();
      if (!question) throw new TeamToolError('invalid', 'The question is empty.');
      const taskKey = this.taskKeyFor(ctx, args.taskKey);
      let assignees: string[];
      if (args.to && args.to.length > 0) {
        const notHuman = args.to.filter(
          (h) => config.team.members.find((m) => m.handle === h)?.kind !== 'human',
        );
        if (notHuman.length > 0)
          throw new TeamToolError(
            'invalid',
            `ask_human can only ask human members; these are not: ${notHuman.join(', ')}.`,
          );
        assignees = unique(args.to);
      } else {
        assignees = sponsorOrOwners(config, ctx.member);
      }
      const labels = (args.options ?? []).map((o) => o.trim()).filter(Boolean);
      const options: InboxOption[] = [
        ...labels.map((label, i): InboxOption => ({
          id: `option_${i + 1}`,
          label,
          style: i === 0 ? 'primary' : 'secondary',
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
        payload: { question, options: labels },
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

  /** Inbox handler: a human answered an ask_human question; the answer goes back to the asking session. */
  async deliverAnswer(item: InboxItem): Promise<void> {
    const resolution = item.resolution;
    if (item.kind !== 'question' || !resolution) return;
    const config = await this.projects.config(item.projectKey);
    const asker = config.team.members.find((m) => m.handle === item.source);
    if (asker?.kind !== 'ai') return;
    const question = typeof item.payload.question === 'string' ? item.payload.question : item.title;
    const body = `Answer to your question "${question}":\n\n${answerText(item)}`;
    const message = this.messages.record({
      projectKey: item.projectKey,
      from: resolution.by,
      to: [asker.handle],
      taskKey: item.taskKey,
      body,
      actor: humanActor(resolution.by),
      sessionId: item.sessionId,
    });
    const session = item.sessionId ? this.ctx.repos.sessions.get(item.sessionId) : null;
    const workItem: WorkItemRef =
      session?.member === asker.handle
        ? session.workItem
        : item.taskKey
          ? { type: 'task', taskKey: item.taskKey }
          : { type: 'general' };
    this.deliverInBackground(item.projectKey, [asker.handle], workItem, message.id);
  }

  /**
   * Wakes each recipient through admission or queues text into its live session; the
   * message counts as delivered once it was typed into every recipient's session.
   */
  private deliverInBackground(
    projectKey: string,
    recipients: string[],
    workItem: WorkItemRef,
    messageId: string,
  ): void {
    if (recipients.length === 0) return;

    for (const handle of recipients) {
      this.sessions.deliverOrStartMessageSession(projectKey, handle, workItem, messageId);
    }
  }

  /** The caller must still be an AI member of the project. */
  private async caller(ctx: ToolContext): Promise<ProjectConfig> {
    const config = await this.projects.config(ctx.projectKey);
    const member = config.team.members.find((m) => m.handle === ctx.member);
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
