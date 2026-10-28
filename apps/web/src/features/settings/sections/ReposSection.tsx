import { mergeTargetOf, requiresMerge } from '@projectman/shared';
import type { ProjectConfig } from '@projectman/shared';
import { isApiError } from '../../../api/client';
import { useProject } from '../../../app/contexts';
import { SelectField } from '../../../components/Field';
import { t } from '../../../i18n/t';
import { errorMessage } from '../../../lib/errors';
import { useInstantLimits } from '../SettingsEditor';
import shared from '../settings.module.css';
import { SettingsSection } from './SettingsSection';

type Repo = ProjectConfig['project']['repos'][number];

/** The select's values: the repository's own setting, or the project's default. */
const MERGE_CHOICES = { required: 'true', notRequired: 'false', default: 'default' } as const;

function choiceOf(repo: Repo): string {
  if (repo.requireMerge === undefined) return MERGE_CHOICES.default;
  return repo.requireMerge ? MERGE_CHOICES.required : MERGE_CHOICES.notRequired;
}

/** What the repository does without its own setting. */
function defaultRequires(repo: Repo): boolean {
  return requiresMerge({ requireMerge: undefined, fullTestAtMerge: repo.fullTestAtMerge });
}

/** The check the merge runs for this repository, or that there is none. */
function checkText(repo: Repo): string {
  return repo.reviewTest
    ? t('settings.repos.merge.check', { command: repo.reviewTest.command })
    : t('settings.repos.merge.noCheck');
}

/** What the setting means for the repository, in a sentence. */
function mergeHelp(repo: Repo, target: string): string {
  const params = { target, base: repo.defaultBranch };
  const required = repo.requireMerge ?? defaultRequires(repo);
  const help = t(
    required ? 'settings.repos.merge.helpRequired' : 'settings.repos.merge.helpNotRequired',
    params,
  );
  return repo.requireMerge === undefined
    ? `${t('settings.repos.merge.helpDefault', {
        state: t(required ? 'settings.repos.merge.stateRequired' : 'settings.repos.merge.stateNotRequired'),
      })} ${help}`
    : help;
}

/** The merge setting of one repository as text, for those who may not change it. */
function mergeValue(repo: Repo, target: string): string {
  if (repo.requireMerge === undefined)
    return t(
      defaultRequires(repo)
        ? 'settings.repos.merge.defaultRequired'
        : 'settings.repos.merge.defaultNotRequired',
    );
  return repo.requireMerge
    ? t('settings.repos.merge.required', { target })
    : t('settings.repos.merge.notRequired');
}

/** The per-repository merge settings as selects that save as they change (PM-453). */
function MergeControls({ config, target }: { config: ProjectConfig; target: string }) {
  const { shown, saving, commit, error, locked } = useInstantLimits(config);
  return (
    <fieldset className={shared.controls} disabled={locked} aria-busy={saving}>
      {shown.project.repos.map((repo) => (
        <SelectField
          key={repo.name}
          label={t('settings.repos.merge.labelOf', { repo: repo.name })}
          hint={
            <>
              {mergeHelp(repo, target)}
              <br />
              {checkText(repo)}
            </>
          }
          value={choiceOf(repo)}
          onChange={(event) => {
            const choice = event.target.value;
            commit((draft) => {
              const entry = draft.project.repos.find((candidate) => candidate.name === repo.name);
              if (!entry) return;
              if (choice === MERGE_CHOICES.default) delete entry.requireMerge;
              else entry.requireMerge = choice === MERGE_CHOICES.required;
            });
          }}
        >
          <option value={MERGE_CHOICES.required}>{t('settings.repos.merge.required', { target })}</option>
          <option value={MERGE_CHOICES.notRequired}>{t('settings.repos.merge.notRequired')}</option>
          <option value={MERGE_CHOICES.default}>
            {t(
              defaultRequires(repo)
                ? 'settings.repos.merge.defaultRequired'
                : 'settings.repos.merge.defaultNotRequired',
            )}
          </option>
        </SelectField>
      ))}
      {error ? (
        <p role="alert" className={shared.validation}>
          {isApiError(error) && error.code === 'config_conflict'
            ? t('settings.limits.conflict')
            : errorMessage(error)}
        </p>
      ) : null}
    </fieldset>
  );
}

/**
 * The workspace's git repositories: one row each, the name with its path below, and whether the work
 * must be merged before a card enters the stage after review.
 */
export function ReposSection({ config }: { config: ProjectConfig }) {
  const { can } = useProject();
  const target = mergeTargetOf(config)?.name;
  return (
    <SettingsSection id="settings-repos" title={t('settings.sections.repos')}>
      {config.project.repos.length === 0 ? (
        <p className={shared.muted}>{t('settings.repos.none')}</p>
      ) : (
        <ul className={shared.repos}>
          {config.project.repos.map((repo) => (
            <li key={repo.name}>
              <span className={shared.strong}>{repo.name}</span>
              <code className={shared.id}>{repo.path}</code>
              <span className={shared.muted}>
                {t('settings.repos.defaultBranch')}: <code className={shared.id}>{repo.defaultBranch}</code>
                {repo.github ? (
                  <>
                    {' · '}
                    {t('settings.repos.github')}: <code className={shared.id}>{repo.github}</code>
                  </>
                ) : null}
              </span>
              {target && !can.manageTeam ? (
                <span className={shared.muted}>
                  {t('settings.repos.merge.label')}: {mergeValue(repo, target)} · {checkText(repo)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {target && can.manageTeam && config.project.repos.length > 0 ? (
        <section aria-labelledby="settings-merge-title">
          <h3 id="settings-merge-title" className={shared.groupTitle}>
            {t('settings.repos.merge.label')}
          </h3>
          <MergeControls config={config} target={target} />
        </section>
      ) : null}
    </SettingsSection>
  );
}
