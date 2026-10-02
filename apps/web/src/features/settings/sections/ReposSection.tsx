import type { ProjectConfig } from '@projectman/shared';
import { t } from '../../../i18n/t';
import shared from '../settings.module.css';
import { SettingsSection } from './SettingsSection';

/** The workspace's git repositories: one row each, the name with its path below. */
export function ReposSection({ config }: { config: ProjectConfig }) {
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
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}
