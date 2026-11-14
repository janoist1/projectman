import { Link } from 'react-router';
import { validateProjectConfig } from '@projectman/shared';
import type { ConfigIssue, ProjectConfig } from '@projectman/shared';
import { useProject } from '../../app/contexts';
import { Icon } from '../../components/Icon';
import { t } from '../../i18n/t';
import { issueMessage } from '../../lib/configIssues';
import { issueTarget } from './issueTarget';
import type { SettingsSectionId } from './sections';
import { showParams } from './selection';
import styles from './ConfigProblems.module.css';

export function ConfigProblems({ config, section }: { config: ProjectConfig; section?: SettingsSectionId }) {
  const issues = validateProjectConfig(config);
  const problems = issues.filter((issue) => issue.severity !== 'warning');
  const holdWarnings = issues.filter((issue) => issue.code === 'start_condition_ai_hold');
  return (
    <>
      {problems.length > 0 ? <ProblemsBanner config={config} section={section} problems={problems} /> : null}
      {holdWarnings.length > 0 ? (
        <section className={styles.banner} role="status">
          {holdWarnings.map((issue, i) => (
            <p className={styles.warning} key={i}>
              <Icon name="exclamation" size={16} />
              <span>
                <strong>
                  {config.pipeline.labels.find((label) => label.id === issue.detail)?.name ?? issue.detail}
                </strong>
                {': '}
                {issueMessage(issue)}
              </span>
            </p>
          ))}
        </section>
      ) : null}
    </>
  );
}

function ProblemsBanner({
  config,
  section,
  problems,
}: {
  config: ProjectConfig;
  section?: SettingsSectionId;
  problems: ConfigIssue[];
}) {
  const { key } = useProject();
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
          const name = target ? (element?.name ?? t(`settings.nav.${target.section}`)) : undefined;
          return (
            <li key={i}>
              {name ? `${name}: ` : null}
              {issueMessage(issue)}{' '}
              {target && (target.section !== section || target.field?.startsWith('ownerDecisionTopics')) ? (
                <Link
                  state={{ settingsIssueTarget: true }}
                  aria-label={t('settings.problems.openLabel', { name: name! })}
                  to={{
                    pathname: `/p/${key}/settings/${target.section}`,
                    search: target.field?.startsWith('ownerDecisionTopics')
                      ? `?${new URLSearchParams({ field: target.field })}`
                      : show
                        ? `?${showParams(show)}`
                        : '',
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
