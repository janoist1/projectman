import {
  configChangeArea,
  coordinationMemberOf,
  isoWeekKey,
  isTheme,
  MAX_CLOSED_CARDS_DAYS,
  operationsReview,
  operationsReviewDue,
  stageOf,
  teamRules,
  teamSettingOf,
} from '@projectman/shared';
import type {
  ClosedCardsMeasure,
  OperationsReviewFacts,
  OperationsReviewSettingChange,
  ProjectConfig,
  Task,
} from '@projectman/shared';
import type { ProjectManagerSignalRecord } from '../../db';
import type { DomainContext } from '../../core/base';
import { isoNow } from '../../core/base';
import type { ProjectService } from '../../core/projects';

const DAY_MS = 24 * 3_600_000;

/** How far back the measures of one review look at most, even when the last review is older (or none was made). */
const MEASURE_DAYS_MAX = 28;

/** The most saved configuration versions one review lists. */
const SETTING_CHANGES_MAX = 20;

/** What the review reads besides the cards and the signals of the project. */
export interface OperationsReviewDeps {
  ctx: DomainContext;
  projects: Pick<ProjectService, 'historyPage'>;
  /** The closed cards of the card measurement (PM-222) of the last `days` days. */
  closedCards: (projectKey: string, days: number) => Promise<ClosedCardsMeasure>;
}

/**
 * The weekly operations review (PM-1464): the case the sweep raises as an `operations_review` signal, or null
 * when none is due. It is due when the project has a project manager, `team.operationsReview` is `weekly`, a
 * week passed since the last review (the first waits for a week-old project) and a card closed or changed its
 * stage since. The facts are read once now and kept in the signal's subject, so the text the project manager
 * gets does not change while it waits.
 */
export async function operationsReviewCase(
  deps: OperationsReviewDeps,
  config: ProjectConfig,
  openCards: readonly Task[],
  previous: readonly ProjectManagerSignalRecord[],
): Promise<{ caseKey: string; subject: string } | null> {
  const { ctx } = deps;
  const projectKey = config.project.key;
  const now = isoNow(ctx);
  const caseKey = `operations_review:${isoWeekKey(now)}`;
  const reviews = previous.filter((signal) => signal.kind === 'operations_review');
  if (reviews.some((signal) => signal.caseKey === caseKey)) return null;
  const lastReviewAt = reviews.reduce<string | null>(
    (latest, signal) => (latest === null || signal.raisedAt > latest ? signal.raisedAt : latest),
    null,
  );
  const projectCreatedAt = ctx.repos.projects.get(projectKey)?.createdAt ?? now;
  const due = (moved: boolean) =>
    operationsReviewDue({
      now,
      setting: teamSettingOf(config, 'operationsReview'),
      hasProjectManager: coordinationMemberOf(config) !== null,
      lastReviewAt,
      projectCreatedAt,
      moved,
    });
  // The cheap checks first: the sweep asks every minute.
  if (!due(true)) return null;
  const since = lastReviewAt ?? projectCreatedAt;
  const moved =
    ctx.repos.tasks.readClosedSince(projectKey, since).some((task) => task.status === 'done') ||
    openCards.some((task) => (task.stageEnteredAt ?? task.createdAt) >= since);
  if (!due(moved)) return null;

  const periodStart = new Date(
    Math.max(Date.parse(since), Date.parse(now) - MEASURE_DAYS_MAX * DAY_MS),
  ).toISOString();
  const days = Math.min(
    MAX_CLOSED_CARDS_DAYS,
    Math.max(1, Math.ceil((Date.parse(now) - Date.parse(periodStart)) / DAY_MS)),
  );
  const closed = (await deps.closedCards(projectKey, days)).cards.filter(
    (card) => card.closedAt >= periodStart,
  );
  const createdAt: Record<string, string> = {};
  for (const card of closed) {
    const created = ctx.repos.tasks.get(card.taskKey)?.createdAt;
    if (created) createdAt[card.taskKey] = created;
  }
  const measures = operationsReview({
    now,
    closed,
    createdAt,
    open: openCards
      .filter((task) => !isTheme(task))
      .flatMap((task) => {
        const stage = stageOf(config, task.stageId);
        return stage ? [{ taskKey: task.key, stageKind: stage.kind, lastActivityAt: task.updatedAt }] : [];
      }),
    humanItems: ctx.repos.inbox.list(projectKey, { state: 'open' }),
  });
  const facts: OperationsReviewFacts = {
    since,
    until: now,
    measures,
    settingChanges: await settingChangesSince(deps, projectKey, since),
    rules: teamRules(config).map((rule) => ({ ...rule, reason: config.team.ruleReasons?.[rule.id] ?? null })),
  };
  return { caseKey, subject: JSON.stringify(facts) };
}

/** The configuration versions saved after `since`, newest first, each with the areas it touched. */
async function settingChangesSince(
  deps: Pick<OperationsReviewDeps, 'projects'>,
  projectKey: string,
  since: string,
): Promise<OperationsReviewSettingChange[]> {
  const { entries } = await deps.projects.historyPage(projectKey, { limit: SETTING_CHANGES_MAX, offset: 0 });
  return entries
    .filter((entry) => Date.parse(entry.at) > Date.parse(since))
    .map((entry) => ({
      version: entry.version,
      at: entry.at,
      areas: (entry.changes ?? []).map(configChangeArea),
      restores: entry.restores?.version ?? null,
    }));
}
