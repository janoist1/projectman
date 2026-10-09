import { useEffect, useRef } from 'react';
import { Link, Navigate, NavLink, useLocation, useParams } from 'react-router';
import { validateProjectConfig } from '@projectman/shared';
import type { ConfigView, EngineStatusView } from '@projectman/shared';
import { useConfig, useEngineStatus } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Chip } from '../../components/Chip';
import { Icon } from '../../components/Icon';
import { PageHeader } from '../../components/PageHeader';
import { ErrorState, LoadingState } from '../../components/States';
import { formatAgo } from '../../i18n/format';
import { t } from '../../i18n/t';
import { useDocumentTitle, useMediaQuery } from '../../lib/hooks';
import { ConfigProblems } from './ConfigProblems';
import { DutiesMatrix } from './DutiesMatrix';
import { issueTarget } from './issueTarget';
import { SettingsEditingProvider } from './SettingsEditor';
import { isSettingsSection, SETTINGS_SECTIONS, SETTINGS_WIDE_QUERY } from './sections';
import type { SettingsSectionId } from './sections';
import styles from './SettingsPage.module.css';
import { AccountSection } from './sections/AccountSection';
import { HistorySection } from './sections/HistorySection';
import { LabelsSection } from './sections/LabelsSection';
import { LimitsSection } from './sections/LimitsSection';
import { PipelineSection } from './sections/PipelineSection';
import { ProjectSection } from './sections/ProjectSection';
import { ReposSection } from './sections/ReposSection';
import { TeamSection } from './sections/TeamSection';
import { EnginesSection } from './sections/EnginesSection';
import { ProvidersSection } from './sections/ProvidersSection';
import { IntegratorSection } from './sections/IntegratorSection';

function summary(
  section: SettingsSectionId,
  view: ConfigView | undefined,
  name: string,
  engines: readonly EngineStatusView[] = [],
): string {
  if (section === 'account') return t('settings.summary.account', { name });
  if (section === 'engines')
    return engines.length
      ? t('settings.summary.engines', {
          count: engines.length,
          online: engines.filter((engine) => engine.online).length,
        })
      : t('settings.summary.enginesEmpty');
  if (section === 'providers') return t('settings.summary.providers');
  if (section === 'integrator') return t('settings.summary.integrator');
  if (!view) return '';
  const { config, history } = view;
  switch (section) {
    case 'pipeline':
      return t('settings.summary.pipeline', {
        stages: config.pipeline.stages.length,
        columns: config.pipeline.columns.length,
      });
    case 'labels':
      return config.pipeline.labels.length
        ? t('settings.summary.labels', { count: config.pipeline.labels.length })
        : t('settings.summary.labelsEmpty');
    case 'duties':
      return t('settings.summary.duties');
    case 'team':
      return t('settings.summary.team', { count: config.team.members.length });
    case 'limits':
      return t(config.team.limits.aiEnabled ? 'settings.summary.limitsOn' : 'settings.summary.limitsOff');
    case 'project':
      return t('settings.summary.project', {
        name: config.project.name,
        language:
          config.project.language === 'hu' || config.project.language === 'en'
            ? t(`settings.project.languages.${config.project.language}`)
            : config.project.language,
      });
    case 'repos':
      return config.project.repos.length
        ? t('settings.summary.repos', { count: config.project.repos.length })
        : t('settings.summary.reposEmpty');
    case 'history':
      return history[0]
        ? t('settings.summary.history', { time: formatAgo(history[0].at), author: history[0].author })
        : t('settings.summary.historyEmpty');
  }
}

export function SettingsPage() {
  const { key, isOwner, me } = useProject();
  const config = useConfig(key);
  // Engines exist in cloud mode only, and only the host owner manages them (PM-316).
  const engineStatus = useEngineStatus();
  const enginesShown = me.hostOwner && engineStatus.data?.mode === 'cloud';
  const wide = useMediaQuery(SETTINGS_WIDE_QUERY);
  const { section: routeSection } = useParams();
  const section = isSettingsSection(routeSection) ? routeSection : undefined;
  const location = useLocation();
  const main = useRef<HTMLDivElement>(null);
  const previousSection = useRef(section);
  const base = `/p/${key}/settings`;
  const legacy =
    location.hash === '#settings-problems' ? 'pipeline' : location.hash.replace(/^#settings-/, '');
  useDocumentTitle(
    section ? t(`settings.nav.${section}`) : null,
    t('settings.title'),
    config.data?.config.project.name ?? me.projects.find((p) => p.key === key)?.name,
  );
  useEffect(() => {
    main.current?.closest('main')?.scrollTo?.(0, 0);
    if (wide && location.state?.settingsIssueTarget && section) {
      main.current?.querySelector<HTMLElement>(`#settings-${section}`)?.focus();
    } else if (!wide) {
      if (section) {
        const heading = main.current?.querySelector<HTMLElement>(`#settings-${section}`);
        if (heading) {
          heading.tabIndex = -1;
          heading.focus();
        }
      } else {
        const returnTo = location.state?.settingsReturn ?? previousSection.current;
        if (isSettingsSection(returnTo)) document.getElementById(`settings-nav-${returnTo}`)?.focus();
      }
    }
    previousSection.current = section;
  }, [
    section,
    wide,
    Boolean(config.data),
    location.state?.settingsIssueTarget,
    location.state?.settingsReturn,
  ]);

  if (isSettingsSection(legacy))
    return <Navigate replace to={{ pathname: `${base}/${legacy}`, search: location.search }} />;
  if (routeSection && !section) return <Navigate replace to={base} />;
  // The engines section is not there for a member who cannot manage them, or on a one-machine installation.
  if (section === 'engines' && !enginesShown && !(me.hostOwner && engineStatus.isPending))
    return <Navigate replace to={base} />;
  if (!section && wide)
    return <Navigate replace to={{ pathname: `${base}/pipeline`, search: location.search }} />;

  const counts: Partial<Record<SettingsSectionId, number>> = {};
  if (config.data)
    for (const issue of validateProjectConfig(config.data.config)) {
      if (issue.severity === 'warning') continue;
      const target = issueTarget(issue.path, config.data.config);
      if (target) counts[target.section] = (counts[target.section] ?? 0) + 1;
    }
  const shownSections = SETTINGS_SECTIONS.filter(
    (id) => (id !== 'integrator' || me.hostOwner) && (id !== 'engines' || enginesShown),
  );
  // The divider before the sections that are not the project's: the first of engines and providers.
  const accountStart = shownSections.find((id) => id === 'engines' || id === 'providers');
  const navigation = (
    <nav
      className={wide ? styles.nav : styles.list}
      aria-label={t('settings.nav.label')}
      aria-busy={config.isPending}
    >
      {shownSections.map((id) => (
        <NavLink
          id={`settings-nav-${id}`}
          key={id}
          to={`${base}/${id}`}
          className={({ isActive }) =>
            `${styles.navLink} ${isActive ? styles.active : ''} ${id === accountStart ? styles.account : ''}`
          }
        >
          <span className={styles.linkText}>
            <span className={styles.linkTitle}>
              {t(`settings.nav.${id}`)}{' '}
              {counts[id] ? (
                <span
                  className={styles.mark}
                  role="img"
                  aria-label={t('settings.problems.mark', { n: counts[id]! })}
                >
                  <Icon name="exclamation" size={14} /> {counts[id]}
                </span>
              ) : null}
            </span>
            {!wide ? (
              <span
                className={`${styles.summary} ${id === 'limits' && config.data?.config.team.limits.aiEnabled === false ? styles.disabled : ''}`}
              >
                {summary(id, config.data, me.name, engineStatus.data?.engines)}
              </span>
            ) : null}
          </span>
          {!wide ? <Icon name="chevronRight" size={18} /> : null}
        </NavLink>
      ))}
    </nav>
  );
  let content;
  if (section === 'account') content = <AccountSection />;
  else if (section === 'integrator') content = <IntegratorSection />;
  else if (section === 'engines') content = enginesShown ? <EnginesSection /> : <LoadingState />;
  else if (config.data && section) {
    const view = config.data;
    switch (section) {
      case 'pipeline':
        content = <PipelineSection config={view.config} />;
        break;
      case 'labels':
        content = <LabelsSection config={view.config} />;
        break;
      case 'duties':
        content = <DutiesMatrix key={view.version} config={view.config} version={view.version} />;
        break;
      case 'team':
        content = <TeamSection config={view.config} />;
        break;
      case 'limits':
        content = <LimitsSection config={view.config} />;
        break;
      case 'project':
        content = <ProjectSection config={view.config} />;
        break;
      case 'repos':
        content = <ReposSection config={view.config} />;
        break;
      case 'history':
        content = <HistorySection history={view.history} current={view.version} canRevert={isOwner} />;
        break;
      case 'providers':
        content = <ProvidersSection config={view.config} />;
        break;
    }
    content = (
      <SettingsEditingProvider key={section} view={view} reload={async () => (await config.refetch()).data}>
        {content}
      </SettingsEditingProvider>
    );
  }
  return (
    <div className={styles.page}>
      {wide || !section ? (
        <PageHeader className={styles.header} title={t('settings.title')}>
          {config.data ? (
            <Chip
              tone="outline"
              size="md"
              title={t('settings.versionId', { version: config.data.version.slice(0, 7) })}
            >
              {t('settings.version')}
            </Chip>
          ) : null}
        </PageHeader>
      ) : (
        <>
          <h1 className={styles.sr}>{t('settings.title')}</h1>
          <Link
            className={styles.back}
            to={base}
            state={{ settingsReturn: section }}
            aria-label={t('settings.backLabel')}
          >
            <Icon name="chevronLeft" size={16} />
            {t('settings.back')}
          </Link>
        </>
      )}
      <div className={styles.grid}>
        {wide ? navigation : null}
        <div ref={main} className={styles.mainCol} data-settings-content>
          {section !== 'account' && section !== 'engines' ? (
            <>
              {config.isPending && section ? <LoadingState /> : null}
              {config.isError ? (
                <ErrorState
                  error={config.error}
                  message={t('settings.loadError')}
                  onRetry={() => void config.refetch()}
                />
              ) : null}
              {config.data && section !== 'providers' ? (
                <ConfigProblems config={config.data.config} section={section} />
              ) : null}
            </>
          ) : null}
          {content}
          {!wide && !section ? navigation : null}
        </div>
      </div>
    </div>
  );
}
