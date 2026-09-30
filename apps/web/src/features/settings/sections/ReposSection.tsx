import type { ProjectConfig } from '@projectman/shared';
import { t } from '../../../i18n/t';
import shared from '../settings.module.css';
import { SettingsSection } from './SettingsSection';

/** The workspace's git repositories. */
export function ReposSection({ config }: { config: ProjectConfig }) {
  return (
    <SettingsSection id="settings-repos" title={t('settings.sections.repos')}>
      {config.project.repos.length === 0 ? (
        <p className={shared.muted}>{t('settings.repos.none')}</p>
      ) : (
        <div className={shared.tableWrap}>
          <table className={shared.table}>
            <thead>
              <tr>
                <th scope="col">{t('settings.repos.name')}</th>
                <th scope="col">{t('settings.repos.path')}</th>
                <th scope="col">{t('settings.repos.github')}</th>
                <th scope="col">{t('settings.repos.defaultBranch')}</th>
              </tr>
            </thead>
            <tbody>
              {config.project.repos.map((repo) => (
                <tr key={repo.name}>
                  <td className={shared.strong}>{repo.name}</td>
                  <td>
                    <code className={shared.id}>{repo.path}</code>
                  </td>
                  <td>{repo.github ? <code className={shared.id}>{repo.github}</code> : t('common.dash')}</td>
                  <td>
                    <code className={shared.id}>{repo.defaultBranch}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SettingsSection>
  );
}
