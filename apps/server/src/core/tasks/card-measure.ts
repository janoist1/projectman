import {
  cardReviewer,
  closedCardsSince,
  countCardRounds,
  DEFAULT_CLOSED_CARDS_DAYS,
  isClosedSince,
  measureClosedCard,
} from '@projectman/shared';
import type { ClosedCardsMeasure, ProjectConfig, Task, TaskDetail } from '@projectman/shared';
import type { DomainContext } from '../base';
import type { ProjectService } from '../projects';

/** A card's fix rounds and the limit that holds it now (PM-262). */
interface FixRoundsMeasure {
  rounds: number;
  limit: number;
}

/**
 * Measuring the closed cards (PM-222): the cards done in a period with what they cost per model
 * and how many rounds they took, for comparing which implementer or model needs more of them.
 * The rules are `measureClosedCard` and `countCardRounds` in `packages/shared`.
 */
export class CardMeasure {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly fixRounds: ((task: Task, config: ProjectConfig) => FixRoundsMeasure) | undefined;

  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    /** The rounds against the fix round limit of a card (PM-262). */
    fixRounds?: (task: Task, config: ProjectConfig) => FixRoundsMeasure;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.fixRounds = deps.fixRounds;
  }

  /**
   * The card's detail with its rounds, its fix rounds against the limit and the stage, label, full-test
   * and fix-limit events older than its timeline window.
   */
  withRounds(detail: TaskDetail): TaskDetail {
    const { projectKey, key } = detail.task;
    const config = this.projects.cachedConfig(projectKey);
    if (!config) return detail;
    const fixRounds = this.fixRounds?.(detail.task, config);
    // The same read gives the events the timeline window cut off, for the card's story (PM-1160); the
    // failed merges are only counted (PM-1341), their check output stays out of the detail.
    const events = this.ctx.repos.timeline.roundEvents(projectKey, key);
    const shown = new Set(detail.timeline.map((event) => event.id));
    return {
      ...detail,
      rounds: countCardRounds(events, config),
      earlierEvents: events.filter((event) => !shown.has(event.id) && event.type !== 'task_merge_failed'),
      ...(fixRounds ? { fixRounds } : {}),
    };
  }

  /** The cards closed (done, not cancelled) in the last `days` days, the most recently closed first. */
  async closedCards(projectKey: string, days = DEFAULT_CLOSED_CARDS_DAYS): Promise<ClosedCardsMeasure> {
    const config = await this.projects.config(projectKey);
    const since = closedCardsSince(this.ctx.now(), days);
    const tasks = this.ctx.repos.tasks
      .readClosedSince(projectKey, since)
      .filter((task) => isClosedSince(task, since));
    const keys = tasks.map((task) => task.key);
    const sessions = this.ctx.repos.sessions.listForTasks(projectKey, keys);
    const events = this.ctx.repos.timeline.roundEventsFor(projectKey, keys);
    const cards = tasks.map((task) =>
      measureClosedCard(
        task,
        sessions.get(task.key) ?? [],
        countCardRounds(events.get(task.key) ?? [], config),
        cardReviewer(events.get(task.key) ?? [], config),
      ),
    );
    return { since, days, cards };
  }
}
