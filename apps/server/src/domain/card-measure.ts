import {
  closedCardsSince,
  countCardRounds,
  DEFAULT_CLOSED_CARDS_DAYS,
  isClosedSince,
  measureClosedCard,
} from '@projectman/shared';
import type { CardRounds, ClosedCardsMeasure, ProjectConfig, Task, TaskDetail } from '@projectman/shared';
import type { DomainContext } from './context';
import type { ProjectService } from './projects';

/** A card's fix rounds and the limit that holds it now (PM-262). */
export interface FixRoundsMeasure {
  rounds: number;
  limit: number;
}

/** A card's review rounds and send-backs, counted from its whole timeline (PM-222). */
export function cardRounds(
  ctx: Pick<DomainContext, 'repos'>,
  config: Pick<ProjectConfig, 'team' | 'pipeline'>,
  projectKey: string,
  taskKey: string,
): CardRounds {
  return countCardRounds(ctx.repos.timeline.roundEvents(projectKey, taskKey), config);
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
   * The card's detail with its rounds and its fix rounds against the limit, for members who see the
   * card's sessions (not for clients).
   */
  withRounds(detail: TaskDetail): TaskDetail {
    const { projectKey, key } = detail.task;
    const config = this.projects.cachedConfig(projectKey);
    if (!config) return detail;
    const fixRounds = this.fixRounds?.(detail.task, config);
    return {
      ...detail,
      rounds: cardRounds(this.ctx, config, projectKey, key),
      ...(fixRounds ? { fixRounds } : {}),
    };
  }

  /** The cards closed (done, not cancelled) in the last `days` days, the most recently closed first. */
  async closedCards(projectKey: string, days = DEFAULT_CLOSED_CARDS_DAYS): Promise<ClosedCardsMeasure> {
    const config = await this.projects.config(projectKey);
    const since = closedCardsSince(this.ctx.now(), days);
    const cards = this.ctx.repos.tasks
      .list(projectKey)
      .filter((task) => isClosedSince(task, since))
      .sort((a, b) => (a.closedAt! < b.closedAt! ? 1 : a.closedAt! > b.closedAt! ? -1 : 0))
      .map((task) =>
        measureClosedCard(
          task,
          this.ctx.repos.sessions.list(projectKey, { taskKey: task.key }),
          cardRounds(this.ctx, config, projectKey, task.key),
        ),
      );
    return { since, days, cards };
  }
}
