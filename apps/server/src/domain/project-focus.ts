import {
  PROJECT_FOCUS_MAX_ITEMS,
  isOpenTask,
  projectFocusPlaces,
  projectFocusRefusal,
} from '@projectman/shared';
import type {
  Actor,
  FocusPlace,
  ProjectFocus,
  ProjectFocusItem,
  ProjectFocusView,
  TimelineEvent,
} from '@projectman/shared';
import { isoNow } from './context';
import type { DomainContext } from './context';
import { DomainError, conflict, forbidden, notFound } from './errors';
import type { ProjectService } from './projects';
import type { TaskService } from './tasks';
import type { TimelineService } from './timeline';

/**
 * The project's focus (PM-427): one ordered list of themes and cards per project. A write checks who
 * may set it, then replaces the list and records the `focus_changed` event in one unit of work; the
 * `project_focus_changed` event goes out when it commits, and the `onChange` listeners run after that.
 * The service never takes an item off by itself: a closed item stays (it covers nothing, see
 * `projectFocusPlaces`) until a person removes it.
 */
export class ProjectFocusService {
  private readonly ctx: DomainContext;
  private readonly projects: Pick<ProjectService, 'config'>;
  private readonly tasks: Pick<TaskService, 'list' | 'find'>;
  private readonly timeline: Pick<TimelineService, 'append'>;
  private readonly listeners: Array<(projectKey: string) => void> = [];

  constructor(deps: {
    ctx: DomainContext;
    projects: Pick<ProjectService, 'config'>;
    tasks: Pick<TaskService, 'list' | 'find'>;
    timeline: Pick<TimelineService, 'append'>;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.timeline = deps.timeline;
  }

  /** The focus list in order. */
  get(projectKey: string): ProjectFocus {
    return { items: this.ctx.repos.projectFocus.list(projectKey) };
  }

  /** The focus as `actor` sees it: with whether they may change it. */
  async view(projectKey: string, actor: Actor): Promise<ProjectFocusView> {
    const config = await this.projects.config(projectKey);
    return { ...this.get(projectKey), canEdit: projectFocusRefusal(config, actor) === null };
  }

  /** Key -> place of every open card and theme the focus covers (`projectFocusPlaces`). */
  places(projectKey: string): Map<string, FocusPlace> {
    return projectFocusPlaces(this.get(projectKey).items, this.tasks.list(projectKey));
  }

  /** Puts a theme or card into the focus at `position` (1-based; absent or past the end: last). */
  async add(projectKey: string, key: string, actor: Actor, position?: number): Promise<ProjectFocus> {
    await this.check(projectKey, actor);
    return this.write(projectKey, () => {
      const task = this.tasks.find(projectKey, key);
      if (!task) throw notFound('task', key);
      if (!isOpenTask(task))
        throw conflict('focus_task_closed', 'A closed card or theme cannot be in the focus');
      const items = this.ctx.repos.projectFocus.list(projectKey);
      if (items.some((item) => item.key === key))
        throw conflict('focus_item_exists', `${key} is already in the focus`);
      if (items.length >= PROJECT_FOCUS_MAX_ITEMS)
        throw conflict('focus_full', `The focus holds at most ${PROJECT_FOCUS_MAX_ITEMS} items`);
      const place = Math.min(Math.max(position ?? items.length + 1, 1), items.length + 1);
      const item: ProjectFocusItem = { key, addedAt: isoNow(this.ctx), addedBy: actor };
      const next = [...items.slice(0, place - 1), item, ...items.slice(place - 1)];
      this.ctx.repos.projectFocus.replace(projectKey, next);
      this.timeline.append({
        projectKey,
        taskKey: key,
        actor,
        type: 'focus_changed',
        data: { action: 'added', key, title: task.title, position: place, previous: null },
      });
      return next;
    });
  }

  /** Moves an item to `position` (1-based, clamped to the length of the list). */
  async move(projectKey: string, key: string, position: number, actor: Actor): Promise<ProjectFocus> {
    await this.check(projectKey, actor);
    return this.write(projectKey, () => {
      const items = this.ctx.repos.projectFocus.list(projectKey);
      const from = items.findIndex((item) => item.key === key);
      if (from < 0) throw unknownItem(key);
      const place = Math.min(Math.max(position, 1), items.length);
      // The same place writes nothing.
      if (place === from + 1) return null;
      const [item] = items.splice(from, 1);
      items.splice(place - 1, 0, item!);
      this.ctx.repos.projectFocus.replace(projectKey, items);
      this.timeline.append({
        projectKey,
        taskKey: null,
        actor,
        type: 'focus_changed',
        data: {
          action: 'moved',
          key,
          title: this.titleOf(projectKey, key),
          position: place,
          previous: from + 1,
        },
      });
      return items;
    });
  }

  /** Takes an item out of the focus. */
  async remove(projectKey: string, key: string, actor: Actor): Promise<ProjectFocus> {
    await this.check(projectKey, actor);
    return this.write(projectKey, () => {
      const items = this.ctx.repos.projectFocus.list(projectKey);
      const from = items.findIndex((item) => item.key === key);
      if (from < 0) throw unknownItem(key);
      const next = items.filter((item) => item.key !== key);
      this.ctx.repos.projectFocus.replace(projectKey, next);
      this.timeline.append({
        projectKey,
        taskKey: key,
        actor,
        type: 'focus_changed',
        data: {
          action: 'removed',
          key,
          title: this.titleOf(projectKey, key),
          position: null,
          previous: from + 1,
        },
      });
      return next;
    });
  }

  /** The project's `focus_changed` events, cards or not, newest first. */
  changes(projectKey: string, limit: number): TimelineEvent[] {
    return this.ctx.repos.timeline.ofProjectType(projectKey, 'focus_changed', limit);
  }

  /** Calls `listener` with the project key after a write changed the focus. */
  onChange(listener: (projectKey: string) => void): void {
    this.listeners.push(listener);
  }

  /** Whether the actor may set the focus: the shared rule decides. */
  private async check(projectKey: string, actor: Actor): Promise<void> {
    const refusal = projectFocusRefusal(await this.projects.config(projectKey), actor);
    if (refusal) {
      throw forbidden(
        refusal,
        refusal === 'focus_humans_only'
          ? 'Only a person may set the focus'
          : 'The focus is set by the owner or by whoever prioritizes',
      );
    }
  }

  /**
   * One write: `change` runs in a unit of work with the checks and the storing and returns the new list,
   * or null when nothing changed.
   */
  private write(projectKey: string, change: () => ProjectFocusItem[] | null): ProjectFocus {
    const items = this.ctx.unitOfWork(() => {
      const next = change();
      if (next) this.ctx.bus.publish({ type: 'project_focus_changed', projectKey, focus: { items: next } });
      return next;
    });
    if (!items) return this.get(projectKey);
    for (const listener of this.listeners) {
      try {
        listener(projectKey);
      } catch (err) {
        this.ctx.logger.warn({ err, projectKey }, 'a project focus listener failed');
      }
    }
    return { items };
  }

  private titleOf(projectKey: string, key: string): string {
    return this.tasks.find(projectKey, key)?.title ?? key;
  }
}

const unknownItem = (key: string) =>
  new DomainError('focus_item_unknown', `${key} is not in the focus`, { status: 404 });
