import {
  ALERT_SEEN_OPTION,
  ANALYSIS_LABEL,
  canSeeTask,
  cardAnalyst,
  isOpenTask,
  isTheme,
  memberOf,
  ownerHandles,
  relationAsksAnalyst,
  SYSTEM_SENDER,
} from '@projectman/shared';
import type { ProjectConfig, RelationCheckAlert, Task, TaskRelationKind } from '@projectman/shared';
import { oneLine, relationNoticeText } from '../../agent-text';
import type { RelationNoticeRelation } from '../../agent-text';
import type { DomainContext } from '../context';
import type { DomainEventMap } from '../events';
import type { InboxService } from '../inbox';
import type { ProjectService } from '../projects';
import type { SessionOrchestrator } from '../sessions';
import type { TaskService } from '../tasks';
import { SYSTEM_ACTOR, unique } from '../util';
import type { Messaging } from './messaging';

/** How much of the other card's description a notice carries. */
const SUMMARY_LIMIT = 300;

/** How far back in a card's label changes the member who set the analysis label is looked for. */
const LABEL_EVENTS = 200;

/**
 * A new relation on a card that is being worked on (PM-421). The members with a running session on the
 * card are told, as a stored `info` message from the system: it starts nothing, and an idle session
 * gets it before its next input. A prerequisite or a duplicate may change the work, so the card's
 * analyst is also asked, with an `action` message on this very card, to check whether it does. With no
 * analyst to ask, the owners get an alert. The messages are the trace: the timeline shows who was told
 * and when, the receipt when it was typed in.
 */
export class RelationNotices {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly tasks: TaskService;
  private readonly sessions: SessionOrchestrator;
  private readonly messaging: Messaging;
  private readonly inbox: InboxService;

  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    tasks: TaskService;
    sessions: SessionOrchestrator;
    messaging: Messaging;
    inbox: InboxService;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.sessions = deps.sessions;
    this.messaging = deps.messaging;
    this.inbox = deps.inbox;
  }

  /** Looks at every card the operation put relations on, one after the other. */
  async added(event: DomainEventMap['task_relations_added']): Promise<void> {
    const config = await this.projects.config(event.projectKey);
    const byCard = new Map<string, { kind: TaskRelationKind; ref: string }[]>();
    for (const { taskKey, kind, ref } of event.added) {
      const list = byCard.get(taskKey) ?? [];
      if (!list.some((r) => r.kind === kind && r.ref === ref)) list.push({ kind, ref });
      byCard.set(taskKey, list);
    }
    for (const [taskKey, relations] of byCard) {
      try {
        await this.card(config, event, taskKey, relations);
      } catch (err) {
        this.ctx.logger.warn(
          { err, taskKey },
          'could not tell the members of a card about its new relations',
        );
      }
    }
  }

  private async card(
    config: ProjectConfig,
    event: DomainEventMap['task_relations_added'],
    taskKey: string,
    added: { kind: TaskRelationKind; ref: string }[],
  ): Promise<void> {
    const { projectKey, actor } = event;
    const task = this.tasks.find(projectKey, taskKey);
    if (!task || !isOpenTask(task) || isTheme(task)) return;
    const workers = this.workers(projectKey, task, config);
    if (workers.length === 0) return;

    const relations: RelationNoticeRelation[] = [];
    for (const { kind, ref } of added) {
      const other = this.ctx.repos.tasks.get(ref);
      if (!other) continue;
      relations.push({
        kind,
        other: {
          key: other.key,
          title: other.title,
          stageId: other.stageId,
          status: other.status,
          summary: oneLine(other.description, SUMMARY_LIMIT),
          visible: canSeeTask({ access: 'ai' }, other),
        },
      });
    }
    if (relations.length === 0) return;

    const actorHandle = actor.handle ?? SYSTEM_SENDER;
    const text = (check: boolean) =>
      relationNoticeText({ cardKey: taskKey, actor: actorHandle, check, relations });
    const asksAnalyst = relations.some(({ kind }) => relationAsksAnalyst(kind));
    let analyst: string | null = null;
    if (asksAnalyst) {
      analyst = cardAnalyst(config, this.analysisLabelSetter(projectKey, taskKey));
      if (!analyst) this.alertOwners(config, task, actor.handle, relations);
      else if (analyst === actor.handle) analyst = null;
    }

    const notified = workers.filter((handle) => handle !== actor.handle && handle !== analyst);
    for (const handle of notified)
      await this.messaging.send(
        projectKey,
        SYSTEM_SENDER,
        { to: [handle], taskKey, text: text(false) },
        { kind: 'info', actor: SYSTEM_ACTOR, untilInput: true, ownCard: true },
      );
    // The analyst who also works the card gets one message: the check holds the notice.
    if (analyst)
      await this.messaging.send(
        projectKey,
        SYSTEM_SENDER,
        { to: [analyst], taskKey, text: text(true) },
        { kind: 'action', actor: SYSTEM_ACTOR, ownCard: true },
      );
  }

  /** The AI members with a running session on the card, one each, in the order of their sessions. */
  private workers(projectKey: string, task: Task, config: ProjectConfig): string[] {
    return unique(
      this.sessions
        .list(projectKey, { taskKey: task.key })
        .filter(
          (session) =>
            session.workItem.type === 'task' &&
            session.workItem.taskKey === task.key &&
            memberOf(config, session.member)?.kind === 'ai' &&
            this.sessions.isRunning(session.id),
        )
        .map((session) => session.member),
    );
  }

  /** Who put the analysis label on the card the last time, or null (a person, the system, or nobody). */
  private analysisLabelSetter(projectKey: string, taskKey: string): string | null {
    const events = this.ctx.repos.timeline.listOfTypes(
      projectKey,
      taskKey,
      ['task_labels_changed'],
      LABEL_EVENTS,
    );
    for (let i = events.length - 1; i >= 0; i--) {
      const added = events[i]!.data.added;
      if (Array.isArray(added) && added.includes(ANALYSIS_LABEL)) return events[i]!.actor.handle;
    }
    return null;
  }

  /** No analyst can check the new relations: the owners (but whoever added them) are told. */
  private alertOwners(
    config: ProjectConfig,
    task: Task,
    actorHandle: string | null,
    relations: RelationNoticeRelation[],
  ): void {
    const owners = ownerHandles(config).filter((handle) => handle !== actorHandle);
    if (owners.length === 0) return;
    this.inbox.create({
      projectKey: task.projectKey,
      kind: 'alert',
      assignees: owners,
      source: 'system',
      taskKey: task.key,
      title: `${task.key}: a new relation may change the work, and no analyst can check it`,
      payload: {
        alert: 'relation_check',
        taskKey: task.key,
        relations: relations
          .filter(({ kind }) => relationAsksAnalyst(kind))
          .map(({ kind, other }) => ({ kind, key: other.key })),
      } satisfies RelationCheckAlert,
      options: [ALERT_SEEN_OPTION],
    });
  }
}
