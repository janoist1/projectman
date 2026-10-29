import {
  coordinationMemberOf,
  DEFAULT_AGENT_PROVIDER,
  effectiveSessionPermissions,
  guestOfConversation,
  hostOutsideOwners,
  memberStorageHandle,
  stageOf,
} from '@projectman/shared';
import type {
  AgentProvider,
  AiMemberConfig,
  Attachment,
  ProjectConfig,
  Session,
  SessionStartCause,
  Task,
  WorkItemRef,
} from '@projectman/shared';
import type {
  CardRelation,
  CardWorker,
  ContextPackInput,
  HandoffTakeover,
  RelatedSession,
} from '../../contracts';
import type { DomainContext } from '../../core/base';
import { QUESTION_LIMIT } from '../../core/inbox';
import type { TaskHandoffRow } from '../../db';
import { aiActor } from '../../kernel';
import { BRIEF_TIMELINE_LIMIT, QUIET_TIMELINE_EVENTS } from '../../agent-text';
import { attachmentToolRules } from './session-policy';
import type { SessionOrchestratorDeps } from './sessions';

interface ContextInputHost {
  fullTests(): { runsFor(task: Task, config: ProjectConfig): boolean } | undefined;
  findRunning(projectKey: string, member: string, workItem: WorkItemRef): Session | null;
  cardWorkersFor(config: ProjectConfig, task: Task, self: string): CardWorker[];
}

/** The settings that apply to this conversation, without changing the member's configuration. */
export function contextMember(
  config: ProjectConfig,
  member: AiMemberConfig,
  workItem: WorkItemRef,
  existing: Session | null,
): AiMemberConfig {
  const permissions = effectiveSessionPermissions(member, existing ?? {});
  const guestOf = guestOfConversation(config, member, workItem);
  const permissionMode =
    guestOf !== undefined ? 'default' : (permissions.permissionMode ?? member.permissionMode);
  return { ...member, permissionMode, approver: permissions.approver };
}

/** Placement-independent reads shared by launches and previews. Phases keep the launch's I/O order. */
export class SessionContextInput {
  private readonly ctx: DomainContext;
  private readonly deps: SessionOrchestratorDeps;
  private readonly host: ContextInputHost;
  constructor(deps: SessionOrchestratorDeps, host: ContextInputHost) {
    this.deps = deps;
    this.host = host;
    this.ctx = deps.ctx;
  }

  async prepare(
    config: ProjectConfig,
    member: AiMemberConfig,
    workItem: WorkItemRef,
    task: Task | null,
    opts: { placementDeferred?: true } = {},
  ) {
    const projectKey = config.project.key;
    const guestOf = guestOfConversation(config, member, workItem);
    const stage = task ? (stageOf(config, task.stageId) ?? null) : null;
    const memory =
      guestOf !== undefined
        ? ''
        : await this.deps.memory.read(projectKey, memberStorageHandle(member)).catch((err: unknown) => {
            this.ctx.logger.warn({ err, member: member.handle }, 'could not read member memory');
            return '';
          });
    const { attachments, parentAttachments, attachmentRules, attachmentDirs } = await this.attachmentsFor(
      projectKey,
      member.handle,
      task,
      opts,
    );
    const relatedSessions = task ? this.relatedSessions(projectKey, member.handle, task) : [];
    return {
      stage,
      memory,
      attachments,
      parentAttachments,
      attachmentRules,
      attachmentDirs,
      relatedSessions,
    };
  }

  handoffFor(task: Task | null, member: AiMemberConfig) {
    const takenHandoff =
      task && task.assignee === member.handle
        ? this.ctx.repos.taskHandoffs.untakenFor(task.key, member.handle)
        : null;
    const handoff = takenHandoff
      ? this.handoffTakeover(takenHandoff, member.provider ?? DEFAULT_AGENT_PROVIDER)
      : null;
    return { takenHandoff, handoff };
  }

  standingFor(
    config: ProjectConfig,
    member: AiMemberConfig,
    task: Task | null,
    existing: Session | null,
    resume: boolean,
  ) {
    const projectKey = config.project.key;
    const cardWorkers = task ? this.host.cardWorkersFor(config, task, member.handle) : [];
    const cardQuestions = task
      ? this.deps.cardQuestions.list(projectKey, task.key, {
          limit: QUESTION_LIMIT,
          ...(resume && existing ? { since: existing.lastActivityAt } : {}),
        })
      : [];
    const relations = task ? this.deps.tasks.relationsOf(projectKey, task.key) : [];
    const themeCard = task?.themeKey ? this.deps.tasks.find(projectKey, task.themeKey) : null;
    const acceptance = task ? this.ctx.repos.taskAcceptance.list(task.id) : [];
    return { cardWorkers, cardQuestions, relations, themeCard, acceptance };
  }

  async build(
    config: ProjectConfig,
    member: AiMemberConfig,
    workItem: WorkItemRef,
    task: Task | null,
    existing: Session | null,
    cause: SessionStartCause | null,
    prepared: Awaited<ReturnType<SessionContextInput['prepare']>>,
    standing: ReturnType<SessionContextInput['standingFor']>,
    handoff: HandoffTakeover | null,
  ): Promise<ContextPackInput> {
    const projectKey = config.project.key;
    const { stage, memory, attachments, parentAttachments, relatedSessions } = prepared;
    const { cardWorkers, cardQuestions, relations, themeCard, acceptance } = standing;
    const operatorKnowledge = await this.deps.operatorKnowledge
      .forConversation(projectKey, member.handle, workItem, cause)
      .catch((err: unknown) => {
        this.ctx.logger.warn({ err, member: member.handle }, 'could not read operator knowledge');
        return undefined;
      });
    const operatorPreference = await this.deps.operatorPreferences
      .forConversation(projectKey, member.handle, workItem, cause)
      .catch((err: unknown) => {
        this.ctx.logger.warn({ err, member: member.handle }, 'could not read operator preference');
        return undefined;
      });
    // The selected project manager leads the setup checklist (PM-1043).
    const checklist =
      coordinationMemberOf(config)?.handle === member.handle
        ? this.ctx.repos.checklists.get(projectKey)
        : null;
    return {
      ...(task && this.host.fullTests()?.runsFor(task, config) ? { serverFullTest: true } : {}),
      project: config,
      ...(checklist ? { checklist } : {}),
      // An owner account's project: the host is not an owner, so the onboarding covers the owner's own machine (PM-1069).
      ...(checklist && hostOutsideOwners(config, this.deps.hostOwnerEmail())
        ? { hostOutsideOwners: true }
        : {}),
      // The settings that apply to this session: the system prompt tells the agent who answers.
      member: contextMember(config, member, workItem, existing),
      workItem,
      task,
      stage,
      timeline: task
        ? this.deps.timeline.list(projectKey, {
            taskKey: task.key,
            limit: BRIEF_TIMELINE_LIMIT,
            excludeTypes: QUIET_TIMELINE_EVENTS,
          })
        : [],
      timelineTotal: task
        ? this.deps.timeline.count(projectKey, { taskKey: task.key, excludeTypes: QUIET_TIMELINE_EVENTS })
        : 0,
      team: this.deps.members.rosterFor(config),
      memory,
      ...(operatorPreference ? { operatorPreference } : {}),
      ...(operatorKnowledge ? { operatorKnowledge } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(parentAttachments ? { parentAttachments } : {}),
      ...(relatedSessions.length > 0 ? { relatedSessions } : {}),
      ...(cardWorkers.length > 0 ? { cardWorkers } : {}),
      ...(cardQuestions.length > 0 ? { cardQuestions } : {}),
      ...(relations.length > 0 ? { relations } : {}),
      ...(acceptance.length > 0 ? { acceptance } : {}),
      ...(themeCard
        ? {
            theme: {
              key: themeCard.key,
              title: themeCard.title,
              stageId: themeCard.stageId,
              status: themeCard.status,
            },
          }
        : {}),
      ...(handoff ? { handoff } : {}),
    };
  }

  /** A closed handoff to the session's member, as the context pack tells it (PM-342). */
  private handoffTakeover(row: TaskHandoffRow, toProvider: AgentProvider): HandoffTakeover {
    return {
      handoffId: row.id,
      from: row.from,
      fromProvider: row.fromProvider,
      toProvider,
      endedAt: row.endedAt ?? row.startedAt,
      outcome: row.outcome === 'note' ? 'note' : 'fallback',
      ...(row.fallbackReason ? { fallbackReason: row.fallbackReason } : {}),
      note: row.note,
      branch: row.branch,
      lastCommit: row.lastCommit,
      uncommitted: row.uncommitted,
      summary: row.summary,
    };
  }

  /**
   * The member's running sessions on the cards that belong with `task` (PM-184): its parent and its
   * subtasks (`TaskService.family`), and the cards on the prerequisite links, in both directions. A
   * card that belongs in several ways is named once, by the first. The task's own session is not one.
   */
  private relatedSessions(projectKey: string, member: string, task: Task): RelatedSession[] {
    const related = new Map<string, CardRelation>();
    for (const card of this.deps.tasks.family(projectKey, task.key))
      related.set(card.key, card.key === task.parentKey ? 'parent' : 'subtask');
    for (const link of task.links)
      if (link.kind === 'prerequisite' && !related.has(link.ref)) related.set(link.ref, 'prerequisite');
    for (const card of this.deps.tasks.relationsOf(projectKey, task.key))
      if (card.kind === 'prerequisite_of' && !related.has(card.key)) related.set(card.key, 'prerequisite_of');
    const found: RelatedSession[] = [];
    for (const [taskKey, relation] of related) {
      if (taskKey === task.key) continue;
      const card = this.deps.tasks.find(projectKey, taskKey);
      const session = card && this.host.findRunning(projectKey, member, { type: 'task', taskKey });
      if (card && session) found.push({ taskKey, title: card.title, relation, state: session.state });
    }
    return found;
  }

  /** The attachments of a card the member may read (empty when it may not, or on a failure). */
  private async readableAttachments(
    projectKey: string,
    taskKey: string,
    handle: string,
  ): Promise<Attachment[]> {
    return (
      (await this.deps.attachments?.list(projectKey, taskKey, aiActor(handle)).catch((err: unknown) => {
        this.ctx.logger.warn({ err, taskKey }, 'could not list the task attachments');
        return undefined;
      })) ?? []
    );
  }

  /**
   * A task session's attachments: the list for its brief, and the task's attachment directory,
   * which it reads (never edits) without asking: in the session policy as a read-only path, and as
   * rules for sessions without a policy. Only that one directory: not the other tasks' ones, nor
   * the rest of the server's home, and only when it can be written as a plain rule path. A failure
   * leaves the session without them. A subtask also gets its direct parent's files and directory
   * (PM-228): the brief names them, so they open without asking too.
   */
  private async attachmentsFor(
    projectKey: string,
    handle: string,
    task: Task | null,
    opts: { placementDeferred?: true },
  ): Promise<{
    attachments: Attachment[];
    parentAttachments: { taskKey: string; attachments: Attachment[] } | null;
    attachmentRules: { allow: string[]; deny: string[] };
    attachmentDirs: string[];
  }> {
    if (!task)
      return {
        attachments: [],
        parentAttachments: null,
        attachmentRules: attachmentToolRules(null),
        attachmentDirs: [],
      };
    const attachments = await this.readableAttachments(projectKey, task.key, handle);
    const parentKey =
      task.parentKey && this.deps.tasks.find(projectKey, task.parentKey) ? task.parentKey : null;
    const parentFiles = parentKey ? await this.readableAttachments(projectKey, parentKey, handle) : [];
    const rules = { allow: [] as string[], deny: [] as string[] };
    const dirs: string[] = [];
    // Directory resolution may initialize storage. Only a launch needs paths for its policy.
    const policyTasks = opts.placementDeferred ? [] : parentKey ? [task.key, parentKey] : [task.key];
    for (const key of policyTasks) {
      const dir =
        (await this.deps.attachmentDirectory?.(projectKey, key).catch((err: unknown) => {
          this.ctx.logger.warn({ err, taskKey: key }, 'could not find the task attachment directory');
          return undefined;
        })) ?? null;
      const dirRules = attachmentToolRules(dir);
      // The rules are empty when the directory cannot be a plain rule path; then it is not granted.
      if (dir && dirRules.allow.length > 0) {
        dirs.push(dir);
        rules.allow.push(...dirRules.allow);
        rules.deny.push(...dirRules.deny);
      }
    }
    return {
      attachments,
      parentAttachments:
        parentKey && parentFiles.length > 0 ? { taskKey: parentKey, attachments: parentFiles } : null,
      attachmentRules: rules,
      attachmentDirs: dirs,
    };
  }
}
