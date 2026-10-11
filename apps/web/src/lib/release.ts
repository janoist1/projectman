import type { ProjectConfig, ReleaseStep } from '@projectman/shared';
import { t } from '../i18n/t';

/** The steps before the deploy touches the running instance (PM-493 order): a failure there changes nothing. */
const EARLY_STEPS: readonly ReleaseStep[] = ['fetch', 'build', 'test', 'config_check', 'pause'];

/** What a failed deploy left behind: nothing changed, the old version runs again, or nothing runs. */
export type ReleaseOutcome = 'early' | 'rolledBack' | 'down' | 'publish';

export function releaseOutcome(step: ReleaseStep, rolledBack: boolean): ReleaseOutcome {
  if (step === 'publish') return 'publish';
  if (EARLY_STEPS.includes(step)) return 'early';
  return rolledBack ? 'rolledBack' : 'down';
}

export function releaseStepName(step: ReleaseStep): string {
  return t(`release.steps.${step}`);
}

/** The words of a `release_failed` alert: title, what happened, what comes next. */
export function releaseFailedWords(
  step: ReleaseStep,
  rolledBack: boolean,
  key: string,
): { title: string; what: string; next: string; outcome: ReleaseOutcome } {
  const outcome = releaseOutcome(step, rolledBack);
  const params = { key, step: releaseStepName(step) };
  switch (outcome) {
    case 'down':
      return {
        outcome,
        title: t('inbox.alerts.release_failed.titleDown', params),
        what: t('inbox.alerts.release_failed.down', params),
        next: t('inbox.alerts.release_failed.nextDown'),
      };
    case 'publish':
      return {
        outcome,
        title: t('inbox.alerts.release_failed.titlePublish', params),
        what: t('inbox.alerts.release_failed.publish'),
        next: t('inbox.alerts.release_failed.nextPublish'),
      };
    default:
      return {
        outcome,
        title: t('inbox.alerts.release_failed.title', params),
        what: t(`inbox.alerts.release_failed.${outcome}`, params),
        next: t('inbox.alerts.release_failed.nextNew'),
      };
  }
}

type RepoFacts = Partial<Pick<ProjectConfig, 'project'>> | undefined;

/**
 * The GitHub "owner/name" of the release: the release card's repository, else the project's only one.
 * Null when that is not clear or the repository is not on GitHub (no link then).
 */
export function releaseGithub(config: RepoFacts, cardRepo: string | null | undefined): string | null {
  const repos = config?.project?.repos ?? [];
  const repo = cardRepo ? repos.find((entry) => entry.name === cardRepo) : repos.length === 1 ? repos[0] : undefined;
  return repo?.github ?? null;
}

/** The GitHub page of the change: the comparison with the last live version, else the commit alone. */
export function releaseChangesUrl(github: string, commit: string, baseCommit: string | null): string {
  return baseCommit
    ? `https://github.com/${github}/compare/${baseCommit}...${commit}`
    : `https://github.com/${github}/commit/${commit}`;
}

/** An address a row may link to from outside: only `https://`. */
export function isHttpsUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('https://');
}
