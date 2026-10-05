import { Link } from 'react-router';
import { validateProjectConfig } from '@projectman/shared';
import type { ProjectConfig } from '@projectman/shared';
import { useProject } from '../../app/contexts';
import { Icon } from '../../components/Icon';
import { t } from '../../i18n/t';
import { issueMessage } from '../../lib/configIssues';
import { issueTarget } from './issueTarget';
import type { SettingsSectionId } from './sections';
import { showParams } from './selection';
import styles from './ConfigProblems.module.css';

export function ConfigProblems({ config, section }: { config: ProjectConfig; section?: SettingsSectionId }) {
  const { key } = useProject();
  const problems = validateProjectConfig(config).filter((issue) => issue.severity !== 'warning');
  if (problems.length === 0) return null;
  return (
    <section className={styles.banner} aria-labelledby="settings-problems">
      <div className={styles.intro}>
        <Icon name="exclamation" size={20} />
        <div>
          <h2 id="settings-problems">{t('settings.problems.count', { n: problems.length })}</h2>
          <p>{t('settings.problems.rule')}</p>
        </div>
      </div>
      <ul className={styles.problems}>
        {problems.map((issue, i) => {
          const target = issueTarget(issue.path, config);
          const show = target?.show;
          const element =
            show && 'id' in show
              ? (show.type === 'stage'
                  ? config.pipeline.stages
                  : show.type === 'column'
                    ? config.pipeline.columns
                    : config.pipeline.labels
                ).find((item) => item.id === show.id)
              : undefined;
          const name = element?.name ?? t(`settings.nav.${target?.section ?? 'project'}`);
          return (
            <li key={i}>
              {name}: {issueMessage(issue)}{' '}
              {target && target.section !== section ? (
                <Link
                  state={{ settingsIssueTarget: true }}
                  aria-label={t('settings.problems.openLabel', { name })}
                  to={{
                    pathname: `/p/${key}/settings/${target.section}`,
                    search: show ? `?${showParams(show)}` : '',
                  }}
                >
                  {t('settings.problems.open')}
                </Link>
              ) : null}
            </li>
          );
        })}
      </ul>
      <details>
        <summary>{t('errors.details')}</summary>
        {problems.map((issue, i) => (
          <div className={styles.code} key={i}>
            {issue.code} · {issue.path}
          </div>
        ))}
      </details>
    </section>
  );
}
