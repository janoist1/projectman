import type { MemberView, TaskDetail, TimelineEvent, TimelineEventType } from '@projectman/shared';
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

const STAGES = ['backlog', 'development', 'code_review', 'qa', 'done'];

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
    task: {
      id: 'task_21',
      projectKey: 'AR',
      key: 'AR-21',
      title: 'Validate the login form',
      description: 'Show an error message when the email address is invalid.',
      stageId: 'development',
      status: 'active',
      assignee: 'fe-1',
      repo: 'web',
      priority: 2,
      labels: ['frontend'],
      checks: {},
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
      event(
        'task_stage_changed',
        'owner',
        'human',
        { from: 'backlog', to: 'development' },
        '2026-09-29T09:00:00.000Z',
      ),
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

  function record(
    detail: TaskDetail,
    ctx: ToolContext,
    type: TimelineEventType,
    data: Record<string, unknown>,
  ) {
    detail.timeline.push({ ...event(type, ctx.member, 'ai', data), sessionId: ctx.sessionId });
  }

  return {
    calls,
    members,
    tasks,
    memory,
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
      return { messageId, deliveredTo: args.to };
    },

    async listMembers(ctx) {
      await enter('listMembers', ctx, {});
      return members;
    },

    async getTask(ctx, args) {
      await enter('getTask', ctx, args);
      return findTask(args.taskKey);
    },

    async updateTask(ctx, args) {
      await enter('updateTask', ctx, args);
      const detail = findTask(args.taskKey);
      if (args.stageId && !STAGES.includes(args.stageId)) {
        throw new TeamToolError('invalid', `Unknown stage "${args.stageId}".`);
      }
      // The check is applied before the stage move, so it can satisfy the target stage's gate.
      const checks = {
        ...detail.task.checks,
        ...(args.check ? { [args.check.name]: args.check.state } : {}),
      };
      if (args.stageId === 'qa' && checks.code_review !== 'passed') {
        throw new TeamToolError('gate_blocked', 'Stage "qa" requires a passed code_review check.');
      }
      const fields = [
        ...(args.title !== undefined ? ['title'] : []),
        ...(args.description !== undefined ? ['description'] : []),
      ];
      if (fields.length > 0) record(detail, ctx, 'task_updated', { fields });
      if (args.check) {
        const from = detail.task.checks[args.check.name] ?? null;
        record(detail, ctx, 'task_check_changed', { check: args.check.name, from, to: args.check.state });
      }
      if (args.note) record(detail, ctx, 'task_note', { text: args.note });
      if (args.stageId && args.stageId !== detail.task.stageId) {
        record(detail, ctx, 'task_stage_changed', { from: detail.task.stageId, to: args.stageId });
      }
      detail.task = {
        ...detail.task,
        title: args.title ?? detail.task.title,
        description: args.description ?? detail.task.description,
        checks,
        stageId: args.stageId ?? detail.task.stageId,
      };
      return { task: detail.task };
    },

    async createTask(ctx, args) {
      await enter('createTask', ctx, args);
      const key = `AR-${21 + tasks.size}`;
      const detail: TaskDetail = {
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
          checks: {},
          links: [],
          visibility: args.visibility ?? 'internal',
          createdBy: ctx.member,
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
  };
}
