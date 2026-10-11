import {
  ALERT_SEEN_OPTION,
  alertPayloadOf,
  memberOf,
  ownerHandles,
  partLeft,
  partReadyStage,
  REFINE_LABEL,
  SYSTEM_SENDER,
} from '@projectman/shared';
import type { PartsLeftAlert, ProjectConfig, Session, Task, TimelineEventData } from '@projectman/shared';
import { partsLeftText } from '../../agent-text';
import type { DomainContext } from '../context';
import type { InboxService } from '../inbox';
import type { Messaging } from '../messaging';
import type { ProjectService } from '../projects';
import type { SessionOrchestrator } from '../sessions';
import type { TimelineService } from '../timeline';
import { KeyedMutex, SYSTEM_ACTOR, unique } from '../util';

/** How many `task_parts_left` events of a card are read back. */
const EVENTS = 100;

/**
 * Parts of a broken-down card that were left in the first stage (PM-480). The member who broke the card
 * down creates the parts, labels them, orders them and takes them out of the first stage in the same
 * turn. When that turn ends and parts are still left, the member is told once, with an `action` message
 * on the parent card. If they are still left after the member's next turn, the owners get an alert. The
 * messages, the events on the parent and the alert are the trace; nothing here moves or labels a card
 * (decision 48: the members move, the system checks and says).
 */
export class LeftParts {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly sessions: SessionOrchestrator;
  private readonly messaging: Messaging;
  private readonly inbox: InboxService;
  private readonly timeline: TimelineService;
  private readonly mutex = new KeyedMutex();

  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    sessions: SessionOrchestrator;
    messaging: Messaging;
    inbox: InboxService;
    timeline: TimelineService;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.sessions = deps.sessions;
    this.messaging = deps.messaging;
    this.inbox = deps.inbox;
    this.timeline = deps.timeline;
  }

  /** A turn of a member on a card ended (the session went idle or ended): tell them, or tell the owners. */
  async turnEnded(session: Session): Promise<void> {
    if (session.workItem.type !== 'task' || this.sessions.isPaused(session)) return;
    const { projectKey } = session;
    const parentKey = session.workItem.taskKey;
    const member = session.member;
    const config = await this.projects.config(projectKey);
    if (memberOf(config, member)?.kind !== 'ai') return;
    await this.mutex.run(`${projectKey}:${parentKey}`, async () => {
      const parent = this.ctx.repos.tasks.get(parentKey);
      if (!parent || parent.projectKey !== projectKey) return;
      // The member waits for an answer: their turn on the card is not over.
      if (parent.labels.some((id) => config.pipeline.labels.find((l) => l.id === id)?.blocks)) return;
      const left = this.leftOf(config, projectKey, parentKey, member);
      if (left.length === 0) return;

      const history = this.history(projectKey, parentKey, member);
      const toTell = left.filter((part) => !history.told.has(part.key));
      const toAlert = left.filter(
        (part) =>
          history.told.has(part.key) &&
          !history.alerted.has(part.key) &&
          this.delivered(history, part, member),
      );
      if (toTell.length > 0) await this.tell(config, parentKey, member, toTell);
      if (toAlert.length > 0) this.alert(config, parentKey, member, toAlert);
    });
  }

  /** A part changed stage or labels or was cancelled: an open alert whose parts are all in order closes. */
  async changed(task: Task): Promise<void> {
    const parentKey = task.parentKey;
    if (!parentKey) return;
    const { projectKey } = task;
    await this.mutex.run(`${projectKey}:${parentKey}`, async () => {
      const open = this.inbox.list(projectKey, { kind: 'alert', taskKey: parentKey }).flatMap((item) => {
        const payload = alertPayloadOf(item);
        return item.state === 'open' && payload?.alert === 'parts_left' ? [{ item, payload }] : [];
      });
      if (open.length === 0) return;
      const config = await this.projects.config(projectKey);
      for (const { item, payload } of open) {
        const stillLeft = this.leftOf(config, projectKey, parentKey, payload.member).some((part) =>
          payload.parts.includes(part.key),
        );
        if (!stillLeft) this.inbox.cancel(item.id);
      }
    });
  }

  /** The parts of the card that `member` created and left where nobody starts them. */
  private leftOf(config: ProjectConfig, projectKey: string, parentKey: string, member: string): Task[] {
    return this.ctx.repos.tasks
      .children(projectKey, parentKey)
      .filter((part) => partLeft(part, config)?.member === member);
  }

  /** What the member was told and what the owners were told about, from the parent's events. */
  private history(projectKey: string, parentKey: string, member: string) {
    const told = new Map<string, string>();
    const alerted = new Set<string>();
    for (const event of this.ctx.repos.timeline.listOfTypes(
      projectKey,
      parentKey,
      ['task_parts_left'],
      EVENTS,
    )) {
      const data = event.data as Partial<TimelineEventData['task_parts_left']>;
      if (data.member !== member || !Array.isArray(data.parts)) continue;
      for (const key of data.parts) {
        if (data.phase === 'told') told.set(key, data.messageId ?? '');
        else if (data.phase === 'alerted') alerted.add(key);
      }
    }
    return { told, alerted };
  }

  /** Whether the member received the message that told them about the part (it was typed into a session). */
  private delivered(history: { told: Map<string, string> }, part: Task, member: string): boolean {
    const id = history.told.get(part.key);
    const message = id ? this.ctx.repos.messages.get(id) : null;
    if (!message) return false;
    const receipt = message.receipts?.find((r) => r.handle === member);
    return !!(receipt ? receipt.deliveredAt : message.deliveredAt);
  }

  private async tell(config: ProjectConfig, parentKey: string, member: string, parts: Task[]): Promise<void> {
    const projectKey = config.project.key;
    const first = config.pipeline.stages[0];
    const target = partReadyStage(config);
    if (!first || !target) return;
    const text = partsLeftText({
      parentKey,
      parts: parts.map(({ key, title }) => ({ key, title })),
      firstStage: first.id,
      target: target.id,
      refineLabel: REFINE_LABEL,
    });
    const message = await this.messaging.send(
      projectKey,
      SYSTEM_SENDER,
      { to: [member], taskKey: parentKey, text },
      { kind: 'action', actor: SYSTEM_ACTOR, ownCard: true },
    );
    this.timeline.append({
      projectKey,
      taskKey: parentKey,
      actor: SYSTEM_ACTOR,
      type: 'task_parts_left',
      data: { phase: 'told', member, parts: parts.map((part) => part.key), messageId: message.id },
    });
  }

  private alert(config: ProjectConfig, parentKey: string, member: string, parts: Task[]): void {
    const projectKey = config.project.key;
    const owners = ownerHandles(config);
    if (owners.length === 0) return;
    const keys = unique(parts.map((part) => part.key));
    const item = this.inbox.create({
      projectKey,
      kind: 'alert',
      assignees: owners,
      source: 'system',
      taskKey: parentKey,
      title: `${parentKey}: ${keys.length} part${keys.length === 1 ? '' : 's'} left in the first stage after a reminder`,
      payload: { alert: 'parts_left', taskKey: parentKey, member, parts: keys } satisfies PartsLeftAlert,
      options: [ALERT_SEEN_OPTION],
    });
    this.timeline.append({
      projectKey,
      taskKey: parentKey,
      actor: SYSTEM_ACTOR,
      type: 'task_parts_left',
      data: { phase: 'alerted', member, parts: keys, inboxItemId: item.id },
    });
  }
}
