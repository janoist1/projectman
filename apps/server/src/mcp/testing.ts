import type {
  Attachment,
  DutyId,
  FeedbackMarkDetail,
  MemberView,
  TaskDetail,
  TimelineEvent,
  TimelineEventType,
} from '@projectman/shared';
import { BUILT_IN_ROLE_DUTIES, DEFAULT_OPERATOR_PREFERENCE, DUTIES, TaskComplexity } from '@projectman/shared';
import { TeamToolError, type TeamToolsHandler, type ToolContext, type MemberAudience } from '../contracts';

/** A member who holds every role, channel, capability and duty that opens a tool (not the retired Operator-only ones). */
export const fullAudience: MemberAudience = {
  projectManager: true,
  merger: true,
  email: true,
  machineAccess: true,
  duties: new Set(Object.keys(DUTIES) as DutyId[]),
};

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

/** The project manager, who processes feedback marks (PM-512). */
export const pmContext: ToolContext = {
  sessionId: 'ses_pm',
  projectKey: 'AR',
  member: 'pm',
  taskKey: null,
};

/** Stage ids as in the built-in templates (the internal-tool pipeline without its merge stage). */
const STAGES = ['ready', 'dev', 'code_review', 'qa', 'done'];

function sampleMembers(): MemberView[] {
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
    async sendEmail(ctx, args) {
      await enter('sendEmail', ctx, args);
      return { emailId: 'ema_fake', status: 'pending_approval' };
    },
    async setEmailContact(ctx, args) {
      await enter('setEmailContact', ctx, args);
      return { handle: args.handle, wants: args.wants };
    },
    async listEmailContacts(ctx) {
      await enter('listEmailContacts', ctx, {});
      return [];
    },
    async mergeTask(ctx, args) {
      await enter('mergeTask', ctx, args);
      return { task: findTask(args.taskKey).task };
    },
    async requestStructuralReview(ctx, args) {
      await enter('requestStructuralReview', ctx, args);
      return { status: 'awaiting_approval', member: null, message_id: null, inbox_item_id: 'inb_fake' };
    },
    async getChecklist(ctx) {
      await enter('getChecklist', ctx, {});
      return { checklist: null, templates: [{ id: 'small-team', checklist: ['code_review'] }] };
    },
    async updateChecklist(ctx, args) {
      await enter('updateChecklist', ctx, args);
      return {
        checklist: {
          baseTemplateId: null,
          items: [],
          progress: { settled: 0, total: 0, complete: true },
        },
      };
    },
    async getOperatorKnowledge(ctx) {
      await enter('getOperatorKnowledge', ctx, {});
      return { schemaVersion: 1, revision: 0, agreement: null, principles: [], appliedProposalIds: [] };
    },
    async proposeOperatorKnowledge(ctx, args) {
      await enter('proposeOperatorKnowledge', ctx, args);
      return {
        status: 'awaiting_approval',
        inbox_item_id: 'inb_fake',
        step_id: 'ops_fake',
        base_revision: args.expected_revision,
      };
    },
    async prioritizeMerge(ctx, args) {
      await enter('prioritizeMerge', ctx, args);
      return { task: findTask(args.taskKey).task, moved: true };
    },
    async listMergeChecks(ctx, args) {
      await enter('listMergeChecks', ctx, args);
      return { runs: [], hasMore: false };
    },
    async proposeRelease(ctx, args) {
      await enter('proposeRelease', ctx, args);
      const commit = args.commit ?? '0'.repeat(40);
      const tasks = [{ key: 'FAKE-1', title: 'A merged card' }];
      return args.preview
        ? { commit, baseCommit: null, tasks }
        : { releaseId: 'rel_fake', taskKey: 'FAKE-2', commit, baseCommit: null, tasks };
    },
    async publishRelease(ctx, args) {
      await enter('publishRelease', ctx, args);
      const commit = args.commit ?? '0'.repeat(40);
      const tag = args.tag ?? 'v2026.10.23';
      return {
        repo: args.repo ?? 'fake',
        commit,
        baseCommit: null,
        tag,
        url: args.preview ? null : `https://github.com/fake/fake/releases/tag/${tag}`,
        tasks: [{ key: 'FAKE-1', title: 'A merged card' }],
      };
    },
    async checkRelease(ctx, args) {
      await enter('checkRelease', ctx, args);
      return {
        candidate: {
          commit: args.commit ?? '0'.repeat(40),
          baseCommit: null,
          tasks: [{ key: 'FAKE-1', title: 'A merged card' }],
        },
        refusal: null,
        proposers: ['devops'],
      };
    },
    async getRoleConfiguration(ctx, args) {
      await enter('getRoleConfiguration', ctx, args);
      return {
        version: 'v1',
        role: args.role,
        override: null,
        effective: { duties: BUILT_IN_ROLE_DUTIES[args.role], instructions: '' },
      };
    },
    async operate(ctx, args) {
      await enter('operate', ctx, args);
      return { status: 'done', step_id: 'ops_fake', changes: [] };
    },
    async executeOperation(ctx, args) {
      await enter('executeOperation', ctx, args);
      return {
        operation: {
          id: 'sop_fake',
          projectKey: ctx.projectKey,
          taskKey: args.taskKey ?? null,
          handoffId: null,
          state: 'succeeded',
          requestId: '00000000-0000-8000-8000-000000000000',
          command: args.command,
          ownerQuestionId: null,
          errorCode: null,
          createdAt: '2026-10-17T00:00:00.000Z',
          updatedAt: '2026-10-17T00:00:00.000Z',
        },
      };
    },
    async getOperation(ctx, args) {
      await enter('getOperation', ctx, args);
      return {
        operation: {
          id: args.operationId,
          projectKey: ctx.projectKey,
          taskKey: null,
          handoffId: null,
          state: 'succeeded',
          requestId: '00000000-0000-8000-8000-000000000000',
          command: { kind: 'credential_revoke', keyId: 'key_fake' },
          ownerQuestionId: null,
          errorCode: null,
          createdAt: '2026-10-17T00:00:00.000Z',
          updatedAt: '2026-10-17T00:00:00.000Z',
        },
        result: null,
      };
    },
    async getMachineStatus(ctx, args) {
      await enter('getMachineStatus', ctx, args);
      return {
        status: {
          target: args.target,
          online: true,
          version: null,
          bootId: null,
          capabilities: ['status'],
          activeOperationId: null,
        },
        machine: null,
      };
    },
    async getMachineLogs(ctx, args) {
      await enter('getMachineLogs', ctx, args);
      return { entries: [] };
    },
    async startTask(ctx, args) {
      await enter('startTask', ctx, args);
      return { task_key: args.taskKey, session_id: null, hired: null, assignee: args.assignee ?? null };
    },
    async startMember(ctx, args) {
      await enter('startMember', ctx, args);
      return { messageId: 'msg_fake', recipient: { handle: args.member, delivery: 'typed_now' } };
    },
    async readProjectDoc(ctx, args) {
      await enter('readProjectDoc', ctx, args);
      return {
        doc: args.doc,
        repo: 'fake',
        path: 'docs/DECISIONS.md',
        commit: '0'.repeat(40),
        exists: true,
        total_lines: 0,
        from_line: args.fromLine ?? 1,
        text: '',
      };
    },
    async listSystemFeedback(ctx) {
      await enter('listSystemFeedback', ctx, {});
      return { items: [] };
    },
    async recordSystemFeedback(ctx, args) {
      await enter('recordSystemFeedback', ctx, args);
      return { id: 'sf_fake', state: 'new' as const, created: args.sameAs === undefined, occurrences: 1 };
    },
    async searchHistory(ctx, args) {
      await enter('searchHistory', ctx, args);
      return { projectKey: args.projectKey ?? ctx.projectKey, matches: [], hasMore: false, documents: [] };
    },
    async readHistorySource(ctx, args) {
      await enter('readHistorySource', ctx, args);
      return {
        projectKey: args.projectKey ?? ctx.projectKey,
        sourceId: args.sourceId,
        sourceType: 'message',
        taskKey: null,
        author: null,
        at: '2026-10-01T00:00:00.000Z',
        fromLine: args.fromLine ?? 1,
        totalLines: 0,
        text: '',
      };
    },
    async getHistorySearchStats(ctx, args) {
      await enter('getHistorySearchStats', ctx, args);
      return {
        since: args.since ?? '2026-09-01T00:00:00.000Z',
        until: args.until ?? '2026-10-01T00:00:00.000Z',
        retainedSince: '2026-07-03T00:00:00.000Z',
        totalSearches: 0,
        failedSearches: 0,
        byMember: [],
        zeroResultCount: 0,
        zeroResultRate: 0,
        zeroResults: [],
        nextCursor: null,
      };
    },
    async writeProjectDocs(ctx, args) {
      await enter('writeProjectDocs', ctx, args);
      return { write_id: 'dw_fake', state: 'running' };
    },
    async listDecisionCandidates(ctx, args) {
      await enter('listDecisionCandidates', ctx, args);
      return { candidates: [], more: false };
    },
    async markDecisionCandidates(ctx, args) {
      await enter('markDecisionCandidates', ctx, args);
      return { marked: args.items.length };
    },
    async combineQuestions(ctx, args) {
      await enter('combineQuestions', ctx, args);
      return { primaryItemId: args.itemIds[0]!, linkedItemIds: args.itemIds.slice(1) };
    },
    async screenQuestion(ctx, args) {
      await enter('screenQuestion', ctx, args);
      return {
        inboxItemId: args.itemId,
        outcome: args.outcome,
        ...(args.todo ? { recipient: args.todo.recipient } : {}),
      };
    },
    async triageLoop(ctx, args) {
      await enter('triageLoop', ctx, args);
      return {
        state: args.outcome === 'loop' ? 'awaiting_owner' : 'observing',
        loopId: 'loop_1',
        inboxItemId: null,
      };
    },
    async dismissSignal(ctx, args) {
      await enter('dismissSignal', ctx, args);
      return { signalId: args.signalId, state: 'dismissed' };
    },
    async reassignTask(ctx, args) {
      await enter('reassignTask', ctx, args);
      return { task_key: args.taskKey, assignee: args.assignee, previous: null };
    },
    async cancelTask(ctx, args) {
      await enter('cancelTask', ctx, args);
      return { task_key: args.taskKey, status: 'cancelled' };
    },
    async openIntegratorTodo(ctx, args) {
      await enter('openIntegratorTodo', ctx, args);
      return { itemId: 'inb_todo_1', recipient: 'integrator', recipientRefusal: null };
    },
    async getOperatorPreference(ctx) {
      await enter('getOperatorPreference', ctx, {});
      return { schemaVersion: 1, revision: 0, data: { ...DEFAULT_OPERATOR_PREFERENCE }, updatedAt: null };
    },
    async setOperatorPreference(ctx, args) {
      await enter('setOperatorPreference', ctx, args);
      return {
        schemaVersion: 1,
        revision: args.expectedRevision + 1,
        data: args.preference,
        updatedAt: '2026-10-15T00:00:00.000Z',
      };
    },
    async decidePermissionRequest(ctx, args) {
      await enter('decidePermissionRequest', ctx, args);
      throw new TeamToolError('not_found', 'Unknown permission request.');
    },
    async decideFixLimit(ctx, args) {
      await enter('decideFixLimit', ctx, args);
      throw new TeamToolError('not_found', 'Unknown fix round limit hold.');
    },
    async handOff(ctx, args) {
      await enter('handOff', ctx, args);
      return { recorded: true };
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
        return {
          key,
          title,
          stageId,
          status,
          assignee,
          labels,
          updatedAt,
          ...(task.complexity ? { complexity: task.complexity.points } : {}),
        };
      });
    },

    async getOperatorDiagnostics(ctx, args) {
      await enter('getOperatorDiagnostics', ctx, args);
      return {
        task: {
          taskKey: args.taskKey,
          title: 'Task',
          stageId: 'dev',
          stageKind: 'work',
          assignee: null,
          labels: [],
          startWaiting: null,
          startBlock: null,
          missingGateLabels: [],
          openQuestions: [],
          session: null,
          holds: [],
          wait: null,
          signals: [],
        },
        asOf: '2026-10-16T10:00:00.000Z',
        sessions: [],
        deliveries: [],
        checks: [],
        machine: null,
      };
    },
    async getProjectState(ctx, args) {
      await enter('getProjectState', ctx, args);
      return {
        paused: { project: false, instance: false },
        operatorWatch: 'report',
        stages: [],
        sessions: [],
        waitingStarts: [],
        openOwnerItems: [],
        signals: [],
        release: null,
        waitingMessages: [],
      };
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
        ...(args.complexity
          ? {
              complexity:
                args.complexity.points === null
                  ? undefined
                  : TaskComplexity.parse({
                      ...args.complexity,
                      setBy: ctx.member,
                      setAt: '2026-09-28T08:00:00.000Z',
                    }),
            }
          : {}),
        title: args.title ?? detail.task.title,
        description: args.description ?? detail.task.description,
        repo: args.repo !== undefined ? args.repo : detail.task.repo,
        labels,
        stageId: args.stageId ?? detail.task.stageId,
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
          ...(args.complexity?.points != null
            ? {
                complexity: TaskComplexity.parse({
                  ...args.complexity,
                  setBy: ctx.member,
                  setAt: '2026-09-28T08:00:00.000Z',
                }),
              }
            : {}),
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

    async withdrawQuestion(ctx, args) {
      await enter('withdrawQuestion', ctx, args);
      return { itemId: args.itemId };
    },

    async setCurrentWork(ctx, args) {
      await enter('setCurrentWork', ctx, args);
      if (ctx.taskKey === null)
        throw new TeamToolError('invalid', 'set_current_work is only for a session working on a task.');
      return { recorded: true };
    },

    async getGuide(ctx, args) {
      await enter('getGuide', ctx, args);
      if (args.topic === 'role') return '# Role guide\nSession role procedures';
      if (args.topic !== 'rules') throw new TeamToolError('not_found', 'No guide topic.');
      return '# Team rules\nSession rules';
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

    async readMessageAttachment(ctx, args) {
      await enter('readMessageAttachment', ctx, args);
      return {
        attachment: {
          id: args.attachmentId,
          fileName: 'screenshot.png',
          mediaType: 'image/png',
          size: 2048,
          preview: 'image',
        },
        message: { id: 'msg_fake00000001', from: 'owner', createdAt: '2026-10-11T08:00:00.000Z' },
        content: { kind: 'image', data: Buffer.from('fake-webp'), mimeType: 'image/webp' },
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

    async takeScreenshots(ctx, input) {
      await enter('takeScreenshots', ctx, input);
      return {
        runId: 'shr_fake0001',
        status: 'done',
        startedAt: '2026-10-05T09:00:00.000Z',
        finishedAt: '2026-10-05T09:00:20.000Z',
        files: ['/sessions/ses_dev/shots/card/card-1512.png'],
        exitCode: 0,
        outputTail: 'shot /sessions/ses_dev/shots/card/card-1512.png 1512x982',
      };
    },

    async getScreenshotRun(ctx, runId) {
      await enter('getScreenshotRun', ctx, runId);
      if (runId !== 'shr_fake0001')
        throw new TeamToolError('not_found', `This session has no screenshot run ${runId}.`);
      return { runId, status: 'running', startedAt: '2026-10-05T09:00:00.000Z', files: [] };
    },

    async getFeedbackList(ctx, args) {
      await enter('getFeedbackList', ctx, args);
      requireFeedbackProcessor(ctx);
      return {
        status: args.status,
        total: 1,
        marks: [sampleFeedbackMark()],
        authorAccess: { cleo: 'client' },
      };
    },

    async getFeedbackMark(ctx, args) {
      await enter('getFeedbackMark', ctx, args);
      requireFeedbackProcessor(ctx);
      return {
        mark: sampleFeedbackMark(),
        authorAccess: 'client',
        screenshot: { kind: 'local', path: '/tmp/feedback/AR/fbm_fake0000000001.jpg' },
      };
    },

    async replyFeedback(ctx, args) {
      await enter('replyFeedback', ctx, args);
      requireFeedbackProcessor(ctx);
      return { markId: args.markId, status: 'handled', outcome: 'answered' };
    },

    async createTaskFromFeedback(ctx, args) {
      await enter('createTaskFromFeedback', ctx, args);
      requireFeedbackProcessor(ctx);
      return {
        markId: args.markId,
        status: 'handled',
        outcome: 'card_created',
        task: { key: 'AR-77', title: args.title },
      };
    },

    async linkFeedback(ctx, args) {
      await enter('linkFeedback', ctx, args);
      requireFeedbackProcessor(ctx);
      return { markId: args.markId, status: 'handled', outcome: 'card_linked' };
    },

    async forwardFeedback(ctx, args) {
      await enter('forwardFeedback', ctx, args);
      requireFeedbackProcessor(ctx);
      return { markId: args.markId, status: 'waiting_owner', outcome: null };
    },

    async closeFeedback(ctx, args) {
      await enter('closeFeedback', ctx, args);
      requireFeedbackProcessor(ctx);
      return { markId: args.markId, status: 'closed', outcome: null };
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

/** The feedback tools are for the project manager `pm` only in the fake. */
function requireFeedbackProcessor(ctx: ToolContext): void {
  if (ctx.member !== 'pm')
    throw new TeamToolError(
      'forbidden',
      'feedback_processor_only: only a member with the feedback processing duty may use the feedback tools.',
    );
}

/** A mark a client made on the shop's cart page. */
function sampleFeedbackMark(): FeedbackMarkDetail {
  return {
    id: 'fbm_fake0000000001',
    projectKey: 'AR',
    author: { handle: 'cleo', name: 'Cleo', kind: 'human', color: 2 },
    surface: { id: 'shop', name: 'Shop', origin: 'https://shop.example.com' },
    pageUrl: 'https://shop.example.com/cart?step=2',
    pagePath: '/cart?step=2',
    pageTitle: 'Cart',
    kind: 'point',
    body: 'The total is wrong',
    anchor: {
      kind: 'point',
      selector: '.total',
      textSnippet: '12 990 Ft',
      elementOffset: null,
      pagePoint: { x: 10, y: 20 },
      rect: null,
    },
    status: 'new',
    outcome: null,
    card: null,
    working: false,
    commentCount: 1,
    unread: false,
    hasScreenshot: true,
    createdAt: '2026-10-12T08:00:00.000Z',
    updatedAt: '2026-10-12T08:00:00.000Z',
    lastActivityAt: '2026-10-12T08:05:00.000Z',
    closedAt: null,
    thread: [
      {
        id: 'fbe_fake0000000001',
        type: 'comment',
        actor: { handle: 'cleo', name: 'Cleo', kind: 'human', color: 2 },
        body: 'It also shows the old price',
        card: null,
        createdAt: '2026-10-12T08:05:00.000Z',
      },
    ],
    environment: {
      viewport: { width: 1280, height: 800 },
      scroll: { x: 0, y: 0 },
      devicePixelRatio: 2,
      userAgent: 'Mozilla/5.0 (test)',
      browser: 'Chrome 140',
      os: 'macOS',
      language: 'hu-HU',
    },
    screenshot: { mediaType: 'image/jpeg', size: 54_000, width: 1280, height: 800 },
    canProcess: true,
    canComment: true,
  };
}

/** A screenshot the owner attached to AR-21. */
function sampleAttachment(): Attachment {
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
