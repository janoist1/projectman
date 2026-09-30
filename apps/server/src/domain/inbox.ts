import { labelDefinition, labelHolders, taskAuthors } from '@projectman/shared';
import type {
  HumanAccess,
  InboxItem,
  InboxKind,
  InboxOption,
  InboxState,
  ProjectConfig,
} from '@projectman/shared';
import type { PermissionBroker, PermissionDecision, PermissionRequestInfo } from '../contracts';
import { ownerHandles } from './access';
import { isoNow } from './context';
import type { DomainContext } from './context';
import { conflict, forbidden, invalid, notFound } from './errors';
import type { ProjectService } from './projects';
import type { TimelineService } from './timeline';
import { commandVerdict } from './session-policy';
import { SYSTEM_ACTOR, aiActor, excerpt, humanActor, newId } from './util';

/** Built-in option ids; the web app translates them (labels repeat the id). */
export const PERMISSION_OPTIONS: InboxOption[] = [
  { id: 'allow', label: 'allow', style: 'primary' },
  { id: 'allow_session', label: 'allow_session', style: 'secondary' },
  { id: 'deny', label: 'deny', style: 'danger' },
];

export const DECISION_OPTIONS: InboxOption[] = [
  { id: 'approve', label: 'approve', style: 'primary' },
  { id: 'reject', label: 'reject', style: 'danger' },
];

/** Free-text answer to a question (the text is the resolution note). */
export const ANSWER_OPTION: InboxOption = { id: 'answer', label: 'answer', style: 'secondary' };

export interface CreateInboxItemInput {
  projectKey: string;
  kind: InboxKind;
  assignees: string[];
  source: string;
  sessionId?: string | null;
  taskKey?: string | null;
  title: string;
  body?: string | null;
  payload: Record<string, unknown>;
  options: InboxOption[];
}

export interface Resolver {
  handle: string;
  access: HumanAccess;
}

type ResolvedHandler = (item: InboxItem) => void | Promise<void>;

/** One-line summary of a tool call for humans, e.g. the Bash command or the edited file. */
export function summarizeToolInput(input: unknown): string {
  const obj = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  for (const key of [
    'command',
    'file_path',
    'notebook_path',
    'path',
    'url',
    'pattern',
    'description',
    'prompt',
  ]) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return excerpt(value, 200);
  }
  try {
    return excerpt(JSON.stringify(input) ?? '', 200);
  } catch {
    return '';
  }
}

/** Human assignees for requests raised by an AI member: its sponsor, else the owners. */
export function sponsorOrOwners(config: ProjectConfig, memberHandle: string): string[] {
  const member = config.team.members.find((m) => m.handle === memberHandle);
  if (member?.kind === 'ai') {
    const sponsor = config.team.members.find((m) => m.handle === member.sponsor);
    if (sponsor?.kind === 'human') return [sponsor.handle];
  }
  return ownerHandles(config);
}

/**
 * Everything waiting for a human ("Rád vár"): tool permissions, gate decisions, questions.
 * Implements the runner's PermissionBroker: a permission request becomes an inbox item and
 * the hook waits until a human resolves it (or the request is aborted, then it expires).
 */
export class InboxService {
  readonly broker: PermissionBroker;
  private readonly ctx: DomainContext;
  private readonly timeline: TimelineService;
  private readonly projects: ProjectService;
  private readonly worktreesRootDir?: string;
  private readonly waiters = new Map<string, (item: InboxItem) => void>();
  private readonly handlers = new Map<InboxKind, ResolvedHandler[]>();

  constructor(deps: {
    ctx: DomainContext;
    timeline: TimelineService;
    projects: ProjectService;
    worktreesRootDir?: string;
  }) {
    this.ctx = deps.ctx;
    this.timeline = deps.timeline;
    this.projects = deps.projects;
    this.worktreesRootDir = deps.worktreesRootDir;
    this.broker = { decide: (request, signal) => this.decide(request, signal) };
  }

  /** Runs after an item of `kind` was resolved by a human. */
  onResolved(kind: InboxKind, handler: ResolvedHandler): void {
    this.handlers.set(kind, [...(this.handlers.get(kind) ?? []), handler]);
  }

  create(input: CreateInboxItemInput): InboxItem {
    if (input.assignees.length === 0)
      throw invalid('no_assignees', 'an inbox item needs at least one assignee');
    const item: InboxItem = {
      id: newId('inb'),
      projectKey: input.projectKey,
      kind: input.kind,
      assignees: [...new Set(input.assignees)],
      source: input.source,
      sessionId: input.sessionId ?? null,
      taskKey: input.taskKey ?? null,
      title: input.title,
      body: input.body ?? null,
      payload: input.payload,
      options: input.options,
      state: 'open',
      resolution: null,
      createdAt: isoNow(this.ctx),
    };
    this.ctx.repos.inbox.insert(item);
    this.publish(item);
    return item;
  }

  get(projectKey: string, id: string): InboxItem {
    const item = this.ctx.repos.inbox.get(id);
    if (!item || item.projectKey !== projectKey) throw notFound('inbox item', id);
    return item;
  }

  list(
    projectKey: string,
    filter: { state?: InboxState; kind?: InboxKind; taskKey?: string; limit?: number } = {},
  ) {
    return this.ctx.repos.inbox.list(projectKey, filter);
  }

  countOpenFor(projectKey: string, handle: string): number {
    return this.ctx.repos.inbox.countOpenFor(projectKey, handle);
  }

  /**
   * A human picks an option. Only assignees may resolve; owners may also answer permission
   * requests and questions, but gate decisions belong to the named approvers only.
   */
  async resolve(
    projectKey: string,
    id: string,
    req: { optionId: string; note?: string },
    by: Resolver,
  ): Promise<InboxItem> {
    const item = this.get(projectKey, id);
    if (item.state !== 'open') throw conflict('inbox_item_closed', `inbox item ${id} is ${item.state}`);
    if (!item.options.some((o) => o.id === req.optionId)) {
      throw invalid('unknown_option', `unknown option: ${req.optionId}`);
    }
    const config = await this.projects.config(projectKey);
    if (!config.team.members.some((m) => m.handle === by.handle && m.kind === 'human'))
      throw forbidden('ai_approval_forbidden', 'only human members may resolve inbox items');
    if (item.kind === 'decision' && req.optionId === 'approve') {
      const gate = item.payload.gate as { stageId?: string; label?: string } | undefined;
      const stage = config.pipeline.stages.find((s) => s.id === gate?.stageId);
      const task = item.taskKey ? this.ctx.repos.tasks.get(item.taskKey) : null;
      const label = gate?.label ? labelDefinition(config, gate.label) : undefined;
      if (label && !labelHolders(config, label).includes(by.handle))
        throw forbidden('not_an_assignee', 'the current gate does not authorize this approver');
      if (
        stage?.kind === 'release' &&
        config.team.releaseFourEyes &&
        task &&
        taskAuthors(task).includes(by.handle)
      )
        throw forbidden('release_four_eyes', 'release approval requires an independent human');
    }
    const isAssignee = item.assignees.includes(by.handle);
    if (!isAssignee && !(item.kind !== 'decision' && by.access === 'owner')) {
      throw forbidden('not_an_assignee', 'only the assignees may resolve this item');
    }
    const note = req.note?.trim() ? req.note.trim() : null;
    if (item.kind === 'question' && req.optionId === ANSWER_OPTION.id && !note) {
      throw invalid('answer_required', 'a free-text answer needs a note');
    }
    const at = isoNow(this.ctx);
    const resolved = this.ctx.repos.inbox.close(
      id,
      'resolved',
      { optionId: req.optionId, by: by.handle, at, note },
      at,
    );
    if (!resolved) throw conflict('inbox_item_closed', `inbox item ${id} is no longer open`);
    this.publish(resolved);

    if (resolved.kind === 'permission') {
      this.timeline.append({
        projectKey,
        taskKey: resolved.taskKey,
        sessionId: resolved.sessionId,
        actor: humanActor(by.handle),
        type: 'permission_resolved',
        data: {
          inboxItemId: id,
          decision: req.optionId === 'deny' ? 'deny' : 'allow',
          optionId: req.optionId,
        },
      });
    } else if (resolved.kind === 'question') {
      this.timeline.append({
        projectKey,
        taskKey: resolved.taskKey,
        sessionId: resolved.sessionId,
        actor: humanActor(by.handle),
        type: 'question_answered',
        data: { inboxItemId: id, answer: answerText(resolved) },
      });
    }

    this.waiters.get(id)?.(resolved);
    for (const handler of this.handlers.get(resolved.kind) ?? []) {
      try {
        await handler(resolved);
      } catch (err) {
        this.ctx.logger.error({ err, inboxItemId: id }, 'inbox resolution handler failed');
      }
    }
    return resolved;
  }

  /** Closes an open item without a decision (e.g. a stale gate request); returns null if not open. */
  cancel(id: string): InboxItem | null {
    return this.close(id, 'cancelled');
  }

  expire(id: string): InboxItem | null {
    return this.close(id, 'expired');
  }

  /** Startup: permission requests cannot survive a restart (their hook call is gone). */
  expireOpenPermissions(): void {
    for (const item of this.ctx.repos.inbox.listOpen('permission')) this.close(item.id, 'expired', false);
  }

  reassignRemovedHuman(projectKey: string, handle: string, owners: string[]): void {
    for (const item of this.ctx.repos.inbox
      .listOpen()
      .filter((i) => i.projectKey === projectKey && i.assignees.includes(handle))) {
      const remaining = item.assignees.filter((h) => h !== handle);
      const updated = this.ctx.repos.inbox.updateAssignees(
        item.id,
        remaining.length ? remaining : owners,
        isoNow(this.ctx),
      );
      if (updated) this.publish(updated);
    }
  }

  /** Cancels open questions and permission requests raised by a member (e.g. when it is retired). */
  cancelOpenFromSource(projectKey: string, handle: string): void {
    for (const item of this.ctx.repos.inbox.list(projectKey, { state: 'open' })) {
      if (item.source === handle && item.kind !== 'decision') this.cancel(item.id);
    }
  }

  private close(id: string, state: 'cancelled' | 'expired', publish = true): InboxItem | null {
    const closed = this.ctx.repos.inbox.close(id, state, null, isoNow(this.ctx));
    if (!closed) return null;
    if (publish) this.publish(closed);
    this.waiters.get(id)?.(closed);
    return closed;
  }

  private publish(item: InboxItem): void {
    this.ctx.bus.publish({ type: 'inbox_upserted', projectKey: item.projectKey, item });
  }

  private async decide(request: PermissionRequestInfo, signal: AbortSignal): Promise<PermissionDecision> {
    const session = this.ctx.repos.sessions.get(request.sessionId);
    if (!session) return { behavior: 'deny', message: 'Unknown session.' };
    const config = await this.projects.config(session.projectKey);
    const summary = summarizeToolInput(request.toolInput);
    const taskKey = session.workItem.type === 'task' ? session.workItem.taskKey : null;
    const member = config.team.members.find((member) => member.handle === session.member);
    const verdict =
      member?.kind === 'ai'
        ? commandVerdict({
            config,
            session: { cwd: session.cwd, role: member.role },
            task: taskKey ? this.ctx.repos.tasks.get(taskKey) : null,
            toolName: request.toolName,
            toolInput: request.toolInput,
            worktreesRootDir: this.worktreesRootDir,
          })
        : null;
    const item = this.create({
      projectKey: session.projectKey,
      kind: 'permission',
      assignees: sponsorOrOwners(config, session.member),
      source: session.member,
      sessionId: session.id,
      taskKey,
      title: summary ? `${request.toolName}: ${summary}` : request.toolName,
      payload: { toolName: request.toolName, toolInput: request.toolInput ?? null, summary },
      options: PERMISSION_OPTIONS,
    });
    this.timeline.append({
      projectKey: session.projectKey,
      taskKey,
      sessionId: session.id,
      actor: aiActor(session.member),
      type: 'permission_requested',
      data: { inboxItemId: item.id, toolName: request.toolName, summary },
    });

    if (verdict) {
      const at = isoNow(this.ctx);
      const resolved = this.ctx.repos.inbox.close(
        item.id,
        'resolved',
        {
          optionId: verdict.behavior,
          by: 'system',
          at,
          note: 'Automatikus: szabály szerint',
        },
        at,
      )!;
      this.publish(resolved);
      this.timeline.append({
        projectKey: session.projectKey,
        taskKey,
        sessionId: session.id,
        actor: SYSTEM_ACTOR,
        type: 'permission_resolved',
        data: { inboxItemId: item.id, decision: verdict.behavior, optionId: verdict.behavior },
      });
      return verdict;
    }

    return new Promise<PermissionDecision>((resolve) => {
      const onAbort = () => {
        this.waiters.delete(item.id);
        this.expire(item.id);
        resolve({ behavior: 'deny', message: 'No human decided in time; the request expired.' });
      };
      this.waiters.set(item.id, (closed) => {
        signal.removeEventListener('abort', onAbort);
        this.waiters.delete(item.id);
        resolve(toPermissionDecision(closed));
      });
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

export function toPermissionDecision(item: InboxItem): PermissionDecision {
  const resolution = item.resolution;
  if (item.state === 'resolved' && resolution) {
    if (resolution.optionId === 'allow') return { behavior: 'allow' };
    if (resolution.optionId === 'allow_session') return { behavior: 'allow', rememberForSession: true };
    const reason = resolution.note ? `: ${resolution.note}` : '.';
    return { behavior: 'deny', message: `Denied by ${resolution.by}${reason}` };
  }
  return { behavior: 'deny', message: `The permission request was ${item.state}.` };
}

/** The answer text of a resolved question: the chosen option's label and/or the note. */
export function answerText(item: InboxItem): string {
  const resolution = item.resolution;
  if (!resolution) return '';
  if (resolution.optionId === ANSWER_OPTION.id) return resolution.note ?? '';
  const label = item.options.find((o) => o.id === resolution.optionId)?.label ?? resolution.optionId;
  return resolution.note ? `${label}\n\n${resolution.note}` : label;
}
