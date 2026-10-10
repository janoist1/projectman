import { isAbsolute, resolve, sep } from 'node:path';
import {
  approvalRefusal,
  DELEGATED_INPUT_LIMIT,
  canDecidePermission,
  effectiveSessionPermissions,
  gateRequestOf,
  handOnRequestOf,
  memberOf,
  permissionDelegationOf,
  permissionDelegationState,
  routePermissionRequest,
} from '@projectman/shared';
import type {
  Actor,
  DelegatedPermissionDecision,
  HumanAccess,
  InboxItem,
  InboxKind,
  InboxOption,
  InboxResolutionRule,
  InboxState,
  ProjectConfig,
  Session,
  TimelineEventData,
} from '@projectman/shared';
import { APPROVER_NONE_REFUSAL, MANAGED_VM_NO_LOCAL_APPROVAL } from '../contracts';
import type {
  EngineDirectory,
  PermissionBroker,
  PermissionDecision,
  PermissionRefusedInfo,
  PermissionRequestInfo,
} from '../contracts';
import { ownerHandles } from './access';
import { isoNow } from './context';
import type { DomainContext } from './context';
import { engineIdOf } from './engines';
import { conflict, forbidden, invalid, notFound } from './errors';
import type { ProjectService } from './projects';
import type { TimelineService } from './timeline';
import { commandVerdict, readableRootsFor } from './session-policy';
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

const APPROVAL_REFUSALS = {
  not_an_assignee: 'the current gate does not authorize this approver',
  release_four_eyes: 'release approval requires an independent human',
  self_review_forbidden: 'the assignee and PR authors cannot set this label',
} as const;

/** Free-text answer to a question (the text is the resolution note). */
export const ANSWER_OPTION: InboxOption = { id: 'answer', label: 'answer', style: 'secondary' };

export interface CreateInboxItemInput {
  id?: string;
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
  via?: 'integrator';
  handle: string;
  access: HumanAccess;
}

/** One-line summary of a tool call for humans, e.g. the Bash command or the edited file. */
function summarizeToolInput(input: unknown, sessionCwd?: string | null): string {
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
    if (typeof value === 'string' && value.trim()) {
      const prefix =
        key === 'command' && typeof obj.cwd === 'string' && isAbsolute(obj.cwd) && obj.cwd !== sessionCwd
          ? `${obj.cwd}$ `
          : '';
      return excerpt(`${prefix}${value}`, 200);
    }
  }
  try {
    return excerpt(JSON.stringify(input) ?? '', 200);
  } catch {
    return '';
  }
}

/** Human assignees for requests raised by an AI member: its sponsor, else the owners. */
export function sponsorOrOwners(config: ProjectConfig, memberHandle: string): string[] {
  const member = memberOf(config, memberHandle);
  if (member?.kind === 'ai') {
    const sponsor = memberOf(config, member.sponsor);
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
  private readonly engines: EngineDirectory;
  private readonly attachmentDirectory?: (projectKey: string, taskKey: string) => Promise<string>;
  private readonly waiters = new Map<string, (item: InboxItem) => void>();
  private handOnMove?: (item: InboxItem, by: Resolver) => Promise<void>;

  useHandOnMove(move: (item: InboxItem, by: Resolver) => Promise<void>): void {
    this.handOnMove = move;
  }

  /** Close a hand-on item as part of the transaction that actually moved its card. */
  resolveHandOn(id: string, by: string): void {
    const at = isoNow(this.ctx);
    const item = this.ctx.repos.inbox.close(id, 'resolved', { optionId: 'move', by, at, note: null }, at);
    if (item) this.publish(item);
  }

  constructor(deps: {
    ctx: DomainContext;
    timeline: TimelineService;
    projects: ProjectService;
    /**
     * The engines (PM-311): a session's worktrees root, and where its member workspaces live (PM-138:
     * routine steps there run without asking, as in a worktree), are its engine's.
     */
    engines: EngineDirectory;
    /** The attachment directory of a task: read-only commands there are allowed for its sessions. */
    attachmentDirectory?: (projectKey: string, taskKey: string) => Promise<string>;
  }) {
    this.ctx = deps.ctx;
    this.timeline = deps.timeline;
    this.projects = deps.projects;
    this.engines = deps.engines;
    this.attachmentDirectory = deps.attachmentDirectory;
    this.broker = {
      decide: (request, signal) => this.decide(request, signal),
      refused: (request) => this.classifierRefused(request),
    };
  }

  create(input: CreateInboxItemInput): InboxItem {
    if (input.assignees.length === 0)
      throw invalid('no_assignees', 'an inbox item needs at least one assignee');
    const item: InboxItem = {
      id: input.id ?? newId('inb'),
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

  /** The decision items of one gate request of a task, oldest first. */
  gateRequestItems(projectKey: string, taskKey: string, requestId: string): InboxItem[] {
    return this.ctx.repos.inbox.listGateRequest(projectKey, taskKey, requestId);
  }

  /** Open decision items requesting to move a task from one stage to another. */
  openGateRequests(projectKey: string, taskKey: string, fromStageId: string, toStageId: string): InboxItem[] {
    return this.ctx.repos.inbox.listOpenGateRequests(projectKey, taskKey, fromStageId, toStageId);
  }

  countOpenFor(projectKey: string, handle: string): number {
    return this.ctx.repos.inbox.countOpenFor(projectKey, handle);
  }

  openPermissionOf(projectKey: string, sessionId: string): InboxItem | null {
    return (
      this.ctx.repos.inbox
        .listOpen('permission')
        .filter((item) => item.projectKey === projectKey && item.sessionId === sessionId)
        .at(-1) ?? null
    );
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
    if (by.via && !['question', 'alert'].includes(item.kind))
      throw forbidden(
        'owner_approval_required',
        'Only the owner may give this approval using their own login',
        { kind: item.kind },
      );
    if (item.state !== 'open')
      throw conflict('inbox_item_closed', `inbox item ${id} is ${item.state}`, { id, state: item.state });
    if (!item.options.some((o) => o.id === req.optionId)) {
      throw invalid('unknown_option', `unknown option: ${req.optionId}`);
    }
    const config = await this.projects.config(projectKey);
    if (memberOf(config, by.handle)?.kind !== 'human')
      throw forbidden('ai_approval_forbidden', 'only human members may resolve inbox items');
    if (item.kind === 'boundary')
      throw forbidden('insufficient_access', 'use the boundary decision endpoint');
    const gate = item.kind === 'decision' && req.optionId === 'approve' ? gateRequestOf(item) : null;
    if (gate?.label) {
      // Approving puts the label on in the approver's name: the label rules apply up front.
      const task = item.taskKey ? this.ctx.repos.tasks.get(item.taskKey) : null;
      const refusal = approvalRefusal(config, gate.label, by.handle, task);
      if (refusal) throw forbidden(refusal, APPROVAL_REFUSALS[refusal]);
    }
    const isAssignee = item.assignees.includes(by.handle);
    if (!isAssignee && !(item.kind !== 'decision' && by.access === 'owner')) {
      throw forbidden('not_an_assignee', 'only the assignees may resolve this item');
    }
    const note = req.note?.trim() ? req.note.trim() : null;
    if (item.kind === 'question' && req.optionId === ANSWER_OPTION.id && !note) {
      throw invalid('answer_required', 'a free-text answer needs a note');
    }
    if (item.kind === 'hand_on') {
      if (!handOnRequestOf(item) || !this.handOnMove)
        throw conflict('inbox_item_closed', 'the hand-on request is no longer available');
      // The move closes the item in its own transaction; a refused move leaves it open.
      await this.handOnMove(item, by);
      const resolved = this.get(projectKey, id);
      await this.ctx.events.emit('inbox_resolved', resolved);
      return resolved;
    }
    const at = isoNow(this.ctx);
    const resolved = this.ctx.repos.inbox.close(
      id,
      'resolved',
      { optionId: req.optionId, by: by.handle, at, note, ...(by.via ? { via: by.via } : {}) },
      at,
    );
    if (!resolved) throw conflict('inbox_item_closed', `inbox item ${id} is no longer open`);
    this.publish(resolved);

    if (resolved.kind === 'permission') {
      this.timeline.append({
        projectKey,
        taskKey: resolved.taskKey,
        sessionId: resolved.sessionId,
        actor: { ...humanActor(by.handle), ...(by.via ? { via: by.via } : {}) },
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
    await this.ctx.events.emit('inbox_resolved', resolved);
    return resolved;
  }

  /**
   * An AI decider answers a question delegated to it (PM-169). The one way an AI member decides an
   * inbox item, and only a permission item whose delegation still waits for it (see
   * `canDecidePermission`): never a gate decision, never a question of a person's. `allow` and `deny`
   * close the item in the decider's name, with its reason, and answer the waiting CLI; `escalate` hands
   * the item to the sponsor or the owners, still open. A late answer is refused.
   */
  async resolveDelegated(
    projectKey: string,
    id: string,
    handle: string,
    req: { decision: DelegatedPermissionDecision; reason: string },
  ): Promise<InboxItem> {
    const reason = req.reason.trim();
    if (!reason) throw invalid('invalid_request', 'a decision about a delegated request needs a reason');
    const config = await this.projects.config(projectKey);
    let item = this.get(projectKey, id);
    const delegation = item.kind === 'permission' ? permissionDelegationOf(item) : null;
    if (!delegation)
      throw forbidden(
        'ai_approval_forbidden',
        'an AI member decides only a request delegated to it as the decider',
      );
    if (item.state !== 'open')
      throw conflict('inbox_item_closed', `inbox item ${id} is ${item.state}`, { id, state: item.state });
    item = this.refreshDelegation(item, config);
    const current = permissionDelegationOf(item)!;
    if (!canDecidePermission(config, item.source, current, handle, this.ctx.now().getTime()))
      throw forbidden(
        'not_an_assignee',
        'not a live decider of this request, or its deadline has passed: a person decides it now',
      );
    const actor = aiActor(handle);
    const { decision } = req;
    if (decision === 'escalate')
      return this.escalateDelegated(item, config, { actor, cause: 'lead', reason });

    const at = isoNow(this.ctx);
    // The sponsor and the owners also see what was decided, in their list of recent items.
    const assignees = [...new Set([...item.assignees, ...sponsorOrOwners(config, item.source)])];
    const resolved = this.ctx.unitOfWork(() => {
      this.ctx.repos.inbox.updateOpen(id, item.payload, assignees, at);
      const closed = this.ctx.repos.inbox.close(
        id,
        'resolved',
        { optionId: decision, by: handle, at, note: reason },
        at,
      );
      if (!closed) throw conflict('inbox_item_closed', `inbox item ${id} is no longer open`);
      this.publish(closed);
      this.timeline.append({
        projectKey,
        taskKey: closed.taskKey,
        sessionId: closed.sessionId,
        actor,
        type: 'permission_resolved',
        data: {
          inboxItemId: id,
          decision,
          optionId: decision,
          delegated: true,
          reason: excerpt(reason, 500),
        },
      });
      return closed;
    });
    this.waiters.get(id)?.(resolved);
    await this.ctx.events.emit('inbox_resolved', resolved);
    return resolved;
  }

  /**
   * Hands the delegated questions whose time is up to a person: the deadline passed, delegation was
   * switched off, or no chosen decider is at work any more. Run on a timer and when the configuration
   * changes. Never an allowance: the hook keeps waiting for the person.
   */
  async sweepDelegations(): Promise<void> {
    for (const item of this.ctx.repos.inbox.listOpen('permission')) {
      const delegation = permissionDelegationOf(item);
      if (delegation?.state !== 'pending_lead') continue;
      try {
        this.refreshDelegation(item, await this.projects.config(item.projectKey));
      } catch {
        // The next sweep retries; one unavailable project never holds up another's deadline.
        this.ctx.logger.warn({ itemId: item.id }, 'permission delegation refresh failed');
      }
    }
  }

  /** The item after a due delegation was handed to a person (unchanged when it is not due). */
  private refreshDelegation(item: InboxItem, config: ProjectConfig): InboxItem {
    const delegation = permissionDelegationOf(item);
    if (item.state !== 'open' || delegation?.state !== 'pending_lead') return item;
    if (
      permissionDelegationState(config, item.source, delegation, this.ctx.now().getTime()) === 'pending_lead'
    )
      return item;
    return this.escalateDelegated(item, config, { actor: SYSTEM_ACTOR, cause: 'timeout' });
  }

  private escalateDelegated(
    item: InboxItem,
    config: ProjectConfig,
    by: { actor: Actor; cause: 'lead' | 'timeout'; reason?: string },
  ): InboxItem {
    const delegation = permissionDelegationOf(item)!;
    const assignees = sponsorOrOwners(config, item.source);
    return this.ctx.unitOfWork(() => {
      const updated = this.ctx.repos.inbox.updateOpen(
        item.id,
        {
          ...item.payload,
          delegation: {
            ...delegation,
            state: 'pending_owner',
            escalation: {
              cause: by.cause,
              by: by.actor.handle ?? 'system',
              ...(by.reason ? { reason: excerpt(by.reason, 500) } : {}),
            },
          },
        },
        assignees,
        isoNow(this.ctx),
      );
      if (!updated) return item;
      this.publish(updated);
      this.timeline.append({
        projectKey: item.projectKey,
        taskKey: item.taskKey,
        sessionId: item.sessionId,
        actor: by.actor,
        type: 'permission_escalated',
        data: {
          inboxItemId: item.id,
          cause: by.cause,
          assignees,
          ...(by.reason ? { reason: excerpt(by.reason, 500) } : {}),
        },
      });
      return updated;
    });
  }

  /**
   * The system resolves an open item by a rule, because what it asked about is over (`loop_ended`);
   * null when it is not open. No decision was made, so `inbox_resolved` is not emitted.
   */
  resolveByRule(id: string, optionId: string, rule: InboxResolutionRule): InboxItem | null {
    const at = isoNow(this.ctx);
    const resolved = this.ctx.repos.inbox.close(
      id,
      'resolved',
      { optionId, by: 'system', at, note: null, rule },
      at,
    );
    if (!resolved) return null;
    this.publish(resolved);
    this.waiters.get(id)?.(resolved);
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
  cancelOpenFromSource(projectKey: string, handle: string): InboxItem[] {
    const cancelled: InboxItem[] = [];
    for (const item of this.ctx.repos.inbox.list(projectKey, { state: 'open' })) {
      if (item.source !== handle || item.kind === 'decision') continue;
      const closed = this.cancel(item.id);
      if (closed) cancelled.push(closed);
    }
    return cancelled;
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

  /**
   * The agent's own auto mode refused a tool call (Claude Code's PermissionDenied hook): there is
   * nothing to decide, the timeline shows it (PM-165).
   */
  private classifierRefused(request: PermissionRefusedInfo): void {
    const session = this.ctx.repos.sessions.get(request.sessionId);
    if (!session) return;
    this.refused(session, {
      toolName: request.toolName,
      summary: summarizeToolInput(request.toolInput) || request.toolName,
      by: 'classifier',
      ...(request.reason ? { reason: excerpt(request.reason, 500) } : {}),
    });
  }

  private refused(session: Session, data: TimelineEventData['permission_refused']): void {
    this.timeline.append({
      projectKey: session.projectKey,
      taskKey: session.workItem.type === 'task' ? session.workItem.taskKey : null,
      sessionId: session.id,
      actor: SYSTEM_ACTOR,
      type: 'permission_refused',
      data,
    });
  }

  private async decide(request: PermissionRequestInfo, signal: AbortSignal): Promise<PermissionDecision> {
    const session = this.ctx.repos.sessions.get(request.sessionId);
    if (!session) return { behavior: 'deny', message: 'Unknown session.' };
    // The managed VM profile has no local approvals (PM-141): no inbox item for a human and no
    // command rules (`commandVerdict`, the legacy path only). The runner refuses such a request
    // before it gets here; this is the same rule one step further, should one arrive anyway.
    if (this.ctx.repos.sessions.executionProfile(session.id) === 'managed_vm')
      return { behavior: 'deny', message: MANAGED_VM_NO_LOCAL_APPROVAL };
    const config = await this.projects.config(session.projectKey);
    const summary = summarizeToolInput(request.toolInput, session.cwd);
    const taskKey = session.workItem.type === 'task' ? session.workItem.taskKey : null;
    const member = memberOf(config, session.member);
    const task = taskKey ? this.ctx.repos.tasks.get(taskKey) : null;
    const attachmentsDir =
      task && task.projectKey === session.projectKey
        ? await this.attachmentDirectory?.(session.projectKey, task.key).catch(() => null)
        : null;
    const parentAttachmentsDir =
      task?.parentKey && task.projectKey === session.projectKey
        ? await this.attachmentDirectory?.(session.projectKey, task.parentKey).catch(() => null)
        : null;
    // The places of the engine the session runs on (an engine that is gone has none).
    const engine = this.engines.get(engineIdOf(session));
    const worktreesRootDir = engine?.paths().worktreesRoot ?? undefined;
    const workspacesRootDir = (engine?.memberWorkspaces ? engine.paths().workspacesRoot : null) ?? undefined;
    const readableRoots = readableRootsFor({
      config,
      cwd: session.cwd,
      projectKey: session.projectKey,
      task,
      worktreesRootDir,
      attachmentsDir,
      parentAttachmentsDir,
    });
    const input = request.toolInput;
    const toolCwd = input && typeof input === 'object' && 'cwd' in input ? input.cwd : undefined;
    let validToolCwd = toolCwd === undefined;
    if (typeof toolCwd === 'string' && isAbsolute(toolCwd) && session.cwd) {
      const under = (p: string, root: string) => p === root || p.startsWith(`${root}${sep}`);
      // The canonical paths are the engine's (the directories are on its disk); a path that is not
      // there, or an engine that is gone, makes the directory invalid.
      try {
        const real = engine
          ? await Promise.all([engine.realpath(toolCwd), engine.realpath(session.cwd)])
          : null;
        validToolCwd =
          under(resolve(toolCwd), resolve(session.cwd)) &&
          real !== null &&
          real[0] !== null &&
          real[1] !== null &&
          under(real[0], real[1]);
      } catch {
        validToolCwd = false;
      }
    }
    const verdict =
      member?.kind === 'ai' && validToolCwd
        ? commandVerdict({
            config,
            session: {
              cwd: typeof toolCwd === 'string' ? toolCwd : session.cwd,
              role: member.role,
              provider: session.provider,
            },
            task,
            toolName: request.toolName,
            toolInput: request.toolInput,
            worktreesRootDir,
            workspacesRootDir,
            readableRoots,
          })
        : null;
    // Nobody approves this member's questions (PM-165): refused at once, without an inbox item. The
    // command rules above still come first (a routine step is allowed, publishing is denied); only a
    // request they leave open is refused here. The approver is the one that applies to the session:
    // its own, set by an owner, from the next question on (PM-170), else the member's.
    const approver = member?.kind === 'ai' ? effectiveSessionPermissions(member, session).approver : null;
    if (!verdict && approver === 'none') {
      this.refused(session, { toolName: request.toolName, summary, by: 'approver_none' });
      return { behavior: 'deny', message: APPROVER_NONE_REFUSAL };
    }
    // The approver `ai` (PM-169): the member's AI decider answers, unless the request is one of the
    // owner's categories or there is no decider at work, and then a person does, as for `human`.
    // The session's own directories, not the read-only attachments, are where it may write.
    const route =
      !verdict && member?.kind === 'ai' && approver
        ? routePermissionRequest(config, session.member, {
            toolName: request.toolName,
            toolInput: request.toolInput,
            roots: readableRoots.filter((root) => root !== attachmentsDir && root !== parentAttachmentsDir),
            approver,
          })
        : null;
    const delegation =
      route?.to === 'ai'
        ? {
            state: 'pending_lead' as const,
            leads: route.leads,
            leadDeadline: new Date(
              this.ctx.now().getTime() + (config.team.boundary?.leadTimeoutSeconds ?? 120) * 1000,
            ).toISOString(),
          }
        : null;
    const item = this.create({
      projectKey: session.projectKey,
      kind: 'permission',
      assignees: delegation ? delegation.leads : sponsorOrOwners(config, session.member),
      source: session.member,
      sessionId: session.id,
      taskKey,
      title: summary ? `${request.toolName}: ${summary}` : request.toolName,
      payload: {
        toolName: request.toolName,
        toolInput: request.toolInput ?? null,
        summary,
        ...(delegation ? { delegation } : {}),
        ...(route?.to === 'human' && route.category ? { ownerCategory: route.category } : {}),
      },
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
          note: null,
          rule: 'command_policy',
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

    // Wakes the AI decider; the hook below waits for its answer like for a person's.
    if (delegation) await this.ctx.events.emit('permission_delegated', item);

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

/** The routing never delegates an input longer than `DELEGATED_INPUT_LIMIT`; the cut below is a safeguard. */
const MAX_DELEGATED_INPUT_CHARS = DELEGATED_INPUT_LIMIT;

/**
 * The agent prompt that wakes an AI decider (PM-169): who asks, the exact input of the tool call and how
 * to answer. English, like every prompt for AI members; the decider writes to people in their language.
 */
export function delegatedPermissionPrompt(item: InboxItem): string {
  const delegation = permissionDelegationOf(item);
  const toolName = typeof item.payload.toolName === 'string' ? item.payload.toolName : 'unknown';
  let input: string;
  try {
    input = JSON.stringify(item.payload.toolInput ?? null) ?? 'null';
  } catch {
    input = '"(unreadable)"';
  }
  const cutOff = input.length > MAX_DELEGATED_INPUT_CHARS;
  return [
    `Permission request ${item.id}: ${item.source}'s CLI asks to use the tool ${toolName}${item.taskKey ? ` (task ${item.taskKey})` : ''}.`,
    `Exact input: ${cutOff ? input.slice(0, MAX_DELEGATED_INPUT_CHARS) : input}`,
    cutOff ? 'The input is cut off here: you cannot see all of it, so never allow it; escalate.' : '',
    `Decide it with decide_permission_request (request_id ${item.id}; allow, deny or escalate, always with a reason)${delegation ? ` before ${delegation.leadDeadline}` : ''}; later a person decides it and the answer is refused. Follow your boundary_authorization duty: always escalate what belongs to the owner or what you doubt.`,
  ]
    .filter(Boolean)
    .join('\n');
}

function toPermissionDecision(item: InboxItem): PermissionDecision {
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
