import { openPrerequisites, taskWait, waitHolders, waitWorkers } from '@projectman/shared';
import type { InboxItem, ProjectConfig, Task, TaskWait } from '@projectman/shared';
import type { DomainContext } from '../context';
import type { MemberService } from '../members';

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

  /** The wait of each card (null: the card is closed, a theme, or not waiting), by task key. */
  of(
    config: ProjectConfig,
    cards: readonly Task[],
    viewer: string | null = null,
  ): Map<string, TaskWait | null> {
    const projectKey = config.project.key;
    if (cards.length === 0) return new Map();
    const roster = this.members.rosterFor(config);
    const all = new Map(this.ctx.repos.tasks.list(projectKey).map((task) => [task.key, task]));
    const itemsByTask = new Map<string, InboxItem[]>();
    for (const item of this.ctx.repos.inbox.list(projectKey, { state: 'open' })) {
      if (!item.taskKey) continue;
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

  /** One card's wait. */
  ofCard(config: ProjectConfig, task: Task, viewer: string | null = null): TaskWait | null {
    return this.of(config, [task], viewer).get(task.key) ?? null;
  }
}
