import {
  cardSteps,
  isTheme,
  memberQueueSourceOf,
  openPrerequisites,
  PENDING_INBOX_STATES,
  taskWait,
  visibleCardStepsInput,
  waitHolders,
  waitWorkers,
} from '@projectman/shared';
import type { CardStep, InboxItem, ProjectConfig, Task, TaskWait } from '@projectman/shared';
import type { DomainContext } from '../base';
import type { MemberService, ProjectAccess } from '../members';

/** Who reads the steps: the requester, as the card's other parts are read for them. */
type StepsViewer = Pick<ProjectAccess, 'access' | 'handle' | 'via'>;

/**
 * Why cards stand still (PM-460), from the shared rule `taskWait`: this is the server's side of it, the
 * facts the rule needs (the card's open inbox items, who works on it, the open prerequisites) read from
 * the project's state. The API's `TaskDetail.wait` and the text the AI members read (`get_task`,
 * `list_tasks`) both come from here, so they say what the board says.
 *
 * It reads once per call, for any number of cards. The API names the viewer (the requester: an inbox
 * item assigned to them comes first, as on the board); the AI text names none, so an item assigned
 * to a particular person is not "their" wait there.
 */
export class TaskWaits {
  private readonly ctx: DomainContext;
  private readonly members: Pick<MemberService, 'rosterFor'>;

  constructor(deps: { ctx: DomainContext; members: Pick<MemberService, 'rosterFor'> }) {
    this.ctx = deps.ctx;
    this.members = deps.members;
  }

  /**
   * The wait of each card (null: the card is closed, a theme, or not waiting), by task key. `ignore`:
   * open items the wait leaves out (the obligation tracking reads the wait without its own todos, PM-806).
   */
  of(
    config: ProjectConfig,
    cards: readonly Task[],
    viewer: string | null = null,
    ignore?: (item: InboxItem) => boolean,
  ): Map<string, TaskWait | null> {
    const projectKey = config.project.key;
    if (cards.length === 0) return new Map();
    const roster = this.members.rosterFor(config);
    // The cards the `prerequisite` links name, closed ones too, read now for exactly their keys (PM-771):
    // the wait never reloads the project's whole card list.
    const named = [
      ...new Set(
        cards.flatMap((task) =>
          task.links.flatMap((link) => (link.kind === 'prerequisite' ? [link.ref] : [])),
        ),
      ),
    ];
    const all = new Map(
      (named.length === 0
        ? []
        : this.ctx.repos.tasks.readScheduling(projectKey, { kind: 'keys', keys: named })
      ).map((task) => [task.key, task]),
    );
    const itemsByTask = new Map<string, InboxItem[]>();
    for (const item of this.ctx.repos.inbox.list(projectKey, { state: PENDING_INBOX_STATES })) {
      if (!item.taskKey || ignore?.(item)) continue;
      const list = itemsByTask.get(item.taskKey) ?? [];
      list.push(item);
      itemsByTask.set(item.taskKey, list);
    }
    return new Map(
      cards.map((task) => {
        const linked = task.links.flatMap((link) => {
          const other = link.kind === 'prerequisite' ? all.get(link.ref) : undefined;
          return other ? [other] : [];
        });
        return [
          task.key,
          taskWait({
            task,
            config,
            openItems: itemsByTask.get(task.key) ?? [],
            workers: waitWorkers(task, config, roster),
            holders: waitHolders(task, roster),
            openPrerequisites: openPrerequisites(task, linked).map((card) => card.key),
            viewer,
          }),
        ];
      }),
    );
  }

  /**
   * The card's open system steps (PM-1151) for the viewer: its open obligations, the queue items placed on
   * it, its waiting start and its pending inbox items, each read for this one card by an indexed query and
   * mapped by the shared `cardSteps`. A theme has none (undefined).
   */
  stepsOf(task: Task, viewer: StepsViewer): CardStep[] | undefined {
    if (isTheme(task)) return undefined;
    const projectKey = task.projectKey;
    return cardSteps(
      visibleCardStepsInput(viewer, {
        obligations: this.ctx.repos.obligations.listLive(projectKey, task.key),
        queueItems: this.ctx.repos.memberQueue.listOpenOfCard(projectKey, task.key).map((item) => ({
          ...item,
          source: memberQueueSourceOf(item.source.type, item.source.id),
        })),
        startWaiting: task.startWaiting ?? null,
        openItems: this.ctx.repos.inbox.list(projectKey, { state: PENDING_INBOX_STATES, taskKey: task.key }),
        viewer: viewer.handle,
      }),
    );
  }

  /** One card's wait. */
  ofCard(
    config: ProjectConfig,
    task: Task,
    viewer: string | null = null,
    ignore?: (item: InboxItem) => boolean,
  ): TaskWait | null {
    return this.of(config, [task], viewer, ignore).get(task.key) ?? null;
  }
}
