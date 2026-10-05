import type {
  Attachment,
  MemberView,
  TaskDetail,
  TimelineEvent,
  TimelineEventType,
} from '@projectman/shared';
import { TeamToolError, type TeamToolsHandler, type ToolContext } from '../contracts';

/**
 * Test support: an in-memory TeamToolsHandler with a small team and one task, recording
 * every call. Not used by the running server.
 */

type Method = keyof TeamToolsHandler;

export interface RecordedCall {
  method: Method;
  ctx: ToolContext;
  args: unknown;
}

export interface FakeTeamToolsHandler extends TeamToolsHandler {
  readonly calls: RecordedCall[];
  readonly members: MemberView[];
  readonly tasks: Map<string, TaskDetail>;
  readonly memory: Map<string, string[]>;
  /** Attachments per task key (AR-21 starts with `sampleAttachment()`). */
  readonly attachments: Map<string, Attachment[]>;
  /** The names of the project's repositories; the fake refuses others (default: `web` and `api`). */
  readonly repos: string[];
  /** The next call of `method` throws `error`, or never settles when given 'hang'. */
  failNext(method: Method, error: Error | 'hang'): void;
}

export const devContext: ToolContext = {
  sessionId: 'ses_dev',
  projectKey: 'AR',
  member: 'fe-1',
  taskKey: 'AR-21',
};

export const qaContext: ToolContext = {
  sessionId: 'ses_qa',
  projectKey: 'AR',
  member: 'qa',
  taskKey: null,
};

/** Stage ids as in the built-in templates (the internal-tool pipeline without its merge stage). */
const STAGES = ['ready', 'dev', 'code_review', 'qa', 'done'];

export function sampleMembers(): MemberView[] {
  const base = { specialty: null, activity: null, currentTaskKeys: [], sponsor: 'owner', temp: false };
  return [
    {
      ...base,
      handle: 'owner',
      displayName: 'Anna',
      kind: 'human',
      role: 'owner',
      roles: ['operator', 'product_owner'],
      status: 'online',
      sponsor: null,
    },
    {
      ...base,
      handle: 'fe-1',
      displayName: 'Ben',
      kind: 'ai',
      role: 'developer',
      roles: ['developer'],
      specialty: 'frontend',
      status: 'working',
      activity: 'Bash: npm test',
      currentTaskKeys: ['AR-21'],
    },
    {
      ...base,
      handle: 'cr',
      displayName: 'Cleo',
      kind: 'ai',
      role: 'code_review',
      roles: ['code_review'],
      status: 'idle',
    },
    { ...base, handle: 'qa', displayName: 'Quinn', kind: 'ai', role: 'qa', roles: ['qa'], status: 'idle' },
  ];
}

export function sampleTaskDetail(): TaskDetail {
  return {
    pullRequests: [],
    task: {
      id: 'task_21',
      projectKey: 'AR',
      key: 'AR-21',
      title: 'Validate the login form',
      description: 'Show an error message when the email address is invalid.',
      stageId: 'dev',
      status: 'active',
      assignee: 'fe-1',
      repo: 'web',
      priority: 'high',
      labels: ['frontend'],
      links: [{ kind: 'branch', ref: 'ar-21-login-validation', repo: 'web' }],
      visibility: 'internal',
      createdBy: 'owner',
      createdAt: '2026-09-29T08:00:00.000Z',
      updatedAt: '2026-09-29T09:00:00.000Z',
      closedAt: null,
    },
    timeline: [
      event(
        'task_created',
        'owner',
        'human',
        { title: 'Validate the login form' },
        '2026-09-29T08:00:00.000Z',
      ),
      event('task_stage_changed', 'owner', 'human', { from: 'ready', to: 'dev' }, '2026-09-29T09:00:00.000Z'),
    ],
    sessions: [
      {
        id: 'ses_dev',
        projectKey: 'AR',
        member: 'fe-1',
        workItem: { type: 'task', taskKey: 'AR-21' },
        claudeSessionId: '123e4567-e89b-42d3-a456-426614174000',
        cwd: '/tmp/worktrees/AR/AR-21',
        branch: 'ar-21-login-validation',
        transcriptPath: null,
        state: 'working',
        activity: null,
        startedAt: '2026-09-29T09:00:00.000Z',
        lastActivityAt: '2026-09-29T09:05:00.000Z',
        endedAt: null,
      },
    ],
  };
}

let eventSeq = 0;
function event(
  type: TimelineEventType,
  handle: string | null,
  kind: 'human' | 'ai' | 'system',
  data: Record<string, unknown>,
  createdAt = new Date().toISOString(),
): TimelineEvent {
  eventSeq += 1;
  return {
    id: `evt_${eventSeq}`,
    projectKey: 'AR',
    taskKey: 'AR-21',
    sessionId: null,
    actor: { kind, handle },
    type,
    data,
    createdAt,
  };
}

export function createFakeTeamToolsHandler(): FakeTeamToolsHandler {
  const calls: RecordedCall[] = [];
  const failures = new Map<Method, Error | 'hang'>();
  const members = sampleMembers();
  const initial = sampleTaskDetail();
  const tasks = new Map<string, TaskDetail>([[initial.task.key, initial]]);
  const memory = new Map<string, string[]>();
  const attachments = new Map<string, Attachment[]>([[initial.task.key, [sampleAttachment()]]]);
  const repos = ['web', 'api'];
  let seq = 0;

  async function enter(method: Method, ctx: ToolContext, args: unknown): Promise<void> {
    calls.push({ method, ctx, args });
    const failure = failures.get(method);
    if (!failure) return;
    failures.delete(method);
    if (failure === 'hang') await new Promise<never>(() => {});
    throw failure;
  }

  function findTask(key: string): TaskDetail {
    const detail = tasks.get(key);
    if (!detail) throw new TeamToolError('not_found', `Task ${key} does not exist.`);
    return detail;
  }

  function findAttachment(taskKey: string, id: string): Attachment {
    findTask(taskKey);
    const found = (attachments.get(taskKey) ?? []).find((a) => a.id === id);
    if (!found) throw new TeamToolError('not_found', `${taskKey} has no attachment ${id}.`);
    return found;
  }

  function record(
    detail: TaskDetail,
    ctx: ToolContext,
    type: TimelineEventType,
    data: Record<string, unknown>,
  ) {
    detail.timeline.push({ ...event(type, ctx.member, 'ai', data), sessionId: ctx.sessionId });
  }

  return {
    async submitBoundaryRequest(ctx, args) {
      await enter('submitBoundaryRequest', ctx, args);
      throw new TeamToolError('not_found', 'No protected operation adapter in this transport fake.');
    },
    async getBoundaryRequest(ctx, args) {
      await enter('getBoundaryRequest', ctx, args);
      throw new TeamToolError('not_found', 'Unknown boundary request.');
    },
    async decideBoundaryRequest(ctx, args) {
      await enter('decideBoundaryRequest', ctx, args);
      throw new TeamToolError('not_found', 'Unknown boundary request.');
    },
    async decidePermissionRequest(ctx, args) {
      await enter('decidePermissionRequest', ctx, args);
      throw new TeamToolError('not_found', 'Unknown permission request.');
    },
    async decideFixLimit(ctx, args) {
      await enter('decideFixLimit', ctx, args);
      throw new TeamToolError('not_found', 'Unknown fix round limit hold.');
    },
    async listNetworkDenials(ctx) {
      await enter('listNetworkDenials', ctx, {});
      return [];
    },
    calls,
    members,
    tasks,
    memory,
    attachments,
    repos,
    failNext(method, error) {
      failures.set(method, error);
    },

    async sendMessage(ctx, args) {
      await enter('sendMessage', ctx, args);
      const unknown = args.to.filter((h) => !members.some((m) => m.handle === h));
      if (unknown.length > 0) throw new TeamToolError('not_found', `Unknown member: ${unknown.join(', ')}.`);
      seq += 1;
      const messageId = `msg_${seq}`;
      if (args.taskKey) {
        record(findTask(args.taskKey), ctx, 'team_message', {
          messageId,
          from: ctx.member,
          to: args.to,
          excerpt: args.text.slice(0, 80),
        });
      }
      return {
        messageId,
        deliveredTo: args.to,
        recipients: args.to.map((handle) => ({ handle, delivery: 'typed_now' as const })),
      };
    },

    async listMembers(ctx) {
      await enter('listMembers', ctx, {});
      return members;
    },

    async listTasks(ctx, args) {
      await enter('listTasks', ctx, args);
      return [...tasks.values()].map(({ task }) => {
        const { key, title, stageId, status, assignee, labels, updatedAt } = task;
        return { key, title, stageId, status, assignee, labels, updatedAt };
      });
    },

    async getTask(ctx, args) {
      await enter('getTask', ctx, args);
      // The repository the work happens in is the domain's to work out (`effectiveRepo`); the
      // fake's project has several, so a task that names none has no repository to work in.
      const detail = findTask(args.taskKey);
      const all = attachments.get(args.taskKey) ?? [];
      return {
        ...detail,
        effectiveRepo: detail.task.repo,
        repoChoiceNeeded: detail.task.repo === null,
        attachments: { attachments: all.slice(0, 20), total: all.length, offset: 0 },
      };
    },

    async updateTask(ctx, args) {
      await enter('updateTask', ctx, args);
      const detail = findTask(args.taskKey);
      if (args.stageId && !STAGES.includes(args.stageId)) {
        throw new TeamToolError('invalid', `Unknown stage "${args.stageId}".`);
      }
      // Labels are applied before the stage move, so they can satisfy the target stage's gate.
      const labels = [
        ...detail.task.labels.filter((label) => !(args.removeLabels ?? []).includes(label)),
        ...(args.addLabels ?? []).filter((label) => !detail.task.labels.includes(label)),
      ];
      if (args.stageId === 'qa' && !labels.includes('code-review-ok')) {
        throw new TeamToolError('gate_blocked', 'Stage "qa" requires the label "code-review-ok".');
      }
      if (args.repo && !repos.includes(args.repo)) {
        throw new TeamToolError(
          'invalid',
          `unknown repository: ${args.repo} (the project has: ${repos.join(', ')})`,
        );
      }
      const repoChanged = args.repo !== undefined && args.repo !== detail.task.repo;
      const fields = [
        ...(args.title !== undefined ? ['title'] : []),
        ...(args.description !== undefined ? ['description'] : []),
        ...(repoChanged ? ['repo'] : []),
      ];
      if (fields.length > 0) {
        record(detail, ctx, 'task_updated', {
          fields,
          ...(repoChanged ? { repo: args.repo, previousRepo: detail.task.repo } : {}),
        });
      }
      if (args.addLabels?.length || args.removeLabels?.length) {
        record(detail, ctx, 'task_labels_changed', {
          added: args.addLabels ?? [],
          removed: args.removeLabels ?? [],
        });
      }
      if (args.note) record(detail, ctx, 'task_note', { text: args.note });
      if (args.stageId && args.stageId !== detail.task.stageId) {
        record(detail, ctx, 'task_stage_changed', { from: detail.task.stageId, to: args.stageId });
      }
      detail.task = {
        ...detail.task,
        title: args.title ?? detail.task.title,
        description: args.description ?? detail.task.description,
        repo: args.repo !== undefined ? args.repo : detail.task.repo,
        labels,
        stageId: args.stageId ?? detail.task.stageId,
        ...(args.developerLevel
          ? {
              developerLevel: {
                level: args.developerLevel.level,
                reason: args.developerLevel.reason || null,
                setBy: ctx.member,
                setAt: '2026-09-28T08:00:00.000Z',
              },
            }
          : {}),
      };
      return { task: detail.task };
    },

    async createTask(ctx, args) {
      await enter('createTask', ctx, args);
      const key = `AR-${21 + tasks.size}`;
      const detail: TaskDetail = {
        pullRequests: [],
        task: {
          ...initial.task,
          id: `task_${key}`,
          key,
          title: args.title,
          description: args.description ?? '',
          stageId: STAGES[0]!,
          assignee: null,
          repo: null,
          priority: null,
          labels: args.labels ?? [],
          links: [],
          visibility: args.visibility ?? 'internal',
          createdBy: ctx.member,
          ...(args.developerLevel
            ? {
                developerLevel: {
                  level: args.developerLevel.level,
                  reason: args.developerLevel.reason || null,
                  setBy: ctx.member,
                  setAt: '2026-09-28T08:00:00.000Z',
                },
              }
            : {}),
        },
        timeline: [],
        sessions: [],
      };
      record(detail, ctx, 'task_created', { title: args.title });
      tasks.set(key, detail);
      return { task: detail.task };
    },

    async linkPullRequest(ctx, args) {
      await enter('linkPullRequest', ctx, args);
      const detail = findTask(args.taskKey);
      const ref = String(args.number);
      const known = detail.task.links.some(
        (l) => l.kind === 'pull_request' && l.repo === args.repo && l.ref === ref,
      );
      if (!known) {
        const link = { kind: 'pull_request' as const, ref, repo: args.repo, state: 'open' };
        detail.task = { ...detail.task, links: [...detail.task.links, link] };
        record(detail, ctx, 'task_link_added', { kind: 'pull_request', ref, repo: args.repo });
      }
      return { task: detail.task };
    },

    async publishTaskBranch(ctx, args) {
      await enter('publishTaskBranch', ctx, args);
      const detail = findTask(args.taskKey ?? ctx.taskKey ?? 'AR-21');
      const pullRequest = {
        repo: 'acme/web',
        number: 7,
        title: args.title ?? detail.task.title,
        url: 'https://github.com/acme/web/pull/7',
        state: 'open' as const,
        draft: false,
        headRef: `${detail.task.key}-work`,
        baseRef: 'main',
        checks: 'none' as const,
        reviewDecision: null,
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        updatedAt: '2026-10-01T10:00:00Z',
      };
      return {
        repo: 'acme/web',
        branch: `${detail.task.key}-work`,
        commit: args.commit,
        alreadyPublished: false,
        pullRequest,
        pullRequestCreated: true,
        task: detail.task,
      };
    },

    async getRemoteState(ctx, args) {
      await enter('getRemoteState', ctx, args);
      findTask(args.taskKey);
      return {
        taskKey: args.taskKey,
        repo: 'acme/web',
        baseBranch: 'main',
        baseCommit: 'a'.repeat(40),
        branch: `${args.taskKey}-work`,
        branchCommit: 'b'.repeat(40),
        ahead: 2,
        behind: 0,
        pullRequests: [],
        publishedBy: null,
      };
    },

    async askHuman(ctx, args) {
      await enter('askHuman', ctx, args);
      const notHuman = (args.to ?? []).filter((h) => members.find((m) => m.handle === h)?.kind !== 'human');
      if (notHuman.length > 0) {
        throw new TeamToolError('invalid', `Only humans can be asked: ${notHuman.join(', ')}.`);
      }
      seq += 1;
      return { inboxItemId: `inbox_${seq}` };
    },

    async saveMemory(ctx, args) {
      await enter('saveMemory', ctx, args);
      memory.set(ctx.member, [...(memory.get(ctx.member) ?? []), args.note]);
      return { ok: true };
    },

    async setCurrentWork(ctx, args) {
      await enter('setCurrentWork', ctx, args);
      if (ctx.taskKey === null)
        throw new TeamToolError('invalid', 'set_current_work is only for a session working on a task.');
      return { recorded: true };
    },

    async listAttachments(ctx, args) {
      await enter('listAttachments', ctx, args);
      findTask(args.taskKey);
      const all = attachments.get(args.taskKey) ?? [];
      const offset = args.offset ?? 0;
      return { attachments: all.slice(offset, offset + (args.limit ?? 50)), total: all.length, offset };
    },

    async readAttachment(ctx, args) {
      await enter('readAttachment', ctx, args);
      const attachment = findAttachment(args.taskKey, args.attachmentId);
      return {
        attachment,
        path: `/tmp/attachments/AR/${args.taskKey}/${attachment.id}${attachment.preview === 'image' ? '.png' : ''}`,
        readableWithoutAsking: ctx.taskKey === args.taskKey,
      };
    },

    async attachFile(ctx, args) {
      await enter('attachFile', ctx, args);
      findTask(args.taskKey);
      seq += 1;
      const attachment: Attachment = {
        ...sampleAttachment(),
        id: `att_fake${String(seq).padStart(8, '0')}`,
        taskKey: args.taskKey,
        fileName: args.path.split('/').pop()!,
        uploadedBy: { kind: 'ai', handle: ctx.member },
      };
      attachments.set(args.taskKey, [...(attachments.get(args.taskKey) ?? []), attachment]);
      return { attachment };
    },

    async deleteAttachment(ctx, args) {
      await enter('deleteAttachment', ctx, args);
      const attachment = findAttachment(args.taskKey, args.attachmentId);
      if (attachment.uploadedBy.handle !== ctx.member)
        throw new TeamToolError('forbidden', 'You can delete only the attachments you attached yourself.');
      attachments.set(
        args.taskKey,
        (attachments.get(args.taskKey) ?? []).filter((a) => a.id !== attachment.id),
      );
      return { attachmentId: attachment.id, fileName: attachment.fileName };
    },
  };
}

/** A screenshot the owner attached to AR-21. */
export function sampleAttachment(): Attachment {
  return {
    id: 'att_screenshot01',
    projectKey: 'AR',
    taskKey: 'AR-21',
    fileName: 'login-error.png',
    size: 48_213,
    mediaType: 'image/png',
    preview: 'image',
    uploadedBy: { kind: 'human', handle: 'owner' },
    createdAt: '2026-09-29T08:30:00.000Z',
  };
}
