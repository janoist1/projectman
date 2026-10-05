import { validateProjectConfig } from '@projectman/shared';
import type { ProjectConfig } from '@projectman/shared';
import { t } from '../../i18n/t';
import { issueMessage } from '../../lib/configIssues';
import { SettingsSection } from './sections/SettingsSection';
import shared from './settings.module.css';

/**
 * The rules a stored configuration breaks although it loaded: a repository name or a column id
 * used twice, or a release approval that more than the release approval duty may give. The project
 * works and changes may preserve these errors, but cannot introduce more, so the owner is told why.
 */
export function ConfigProblems({ config }: { config: ProjectConfig }) {
  const problems = validateProjectConfig(config).filter((issue) => issue.severity !== 'warning');
  if (problems.length === 0) return null;
  return (
    <SettingsSection id="settings-problems" title={t('settings.problems.title')}>
      <p role="status">{t('settings.problems.intro', { n: problems.length })}</p>
      <ul className={shared.problems}>
        {problems.map((issue, i) => (
          <li key={i}>
            <code className={shared.id}>{issue.path}</code> {issueMessage(issue)}
          </li>
        ))}
      </ul>
    </SettingsSection>
  );
}
