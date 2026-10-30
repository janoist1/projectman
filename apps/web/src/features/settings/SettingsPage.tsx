import { useEffect, useRef } from 'react';
import { Link, Navigate, NavLink, useLocation, useParams } from 'react-router';
import {
  emailChannelOn,
  hasBoundOrigin,
  settingsSectionVisible,
  validateProjectConfig,
} from '@projectman/shared';
import type { ConfigView, EngineStatusView } from '@projectman/shared';
import {
  useConfig,
  useEmailChannel,
  useEngineStatus,
  useHostRequests,
  useOwnerAccounts,
} from '../../api/queries';
import { OwnersSection } from './owners/OwnersSection';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { Chip } from '../../components/Chip';
import { Icon } from '../../components/Icon';
import { PageHeader } from '../../components/PageHeader';
import { ErrorState, LoadingState } from '../../components/States';
import { formatAgo } from '../../i18n/format';
import { t } from '../../i18n/t';
import { useDocumentTitle, useMediaQuery } from '../../lib/hooks';
import { actorLabel } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
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
import { EmailSection } from './sections/EmailSection';
import { FeedbackSection } from './sections/FeedbackSection';
import { ProvidersSection } from './sections/ProvidersSection';
import { IntegratorSection } from './sections/IntegratorSection';

function summary(
  section: SettingsSectionId,
  view: ConfigView | undefined,
  name: string,
  engines: readonly EngineStatusView[] = [],
  emailHumans = 0,
  owners = { owners: 0, open: 0 },
  members: MemberIndex = new Map(),
  myHandle: string | null = null,
): string {
  if (section === 'owners')
    return owners.owners || owners.open
      ? t('settings.summary.owners', owners)
      : t('settings.summary.ownersEmpty');
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
    case 'feedback':
      return config.project.feedback?.surfaces.length
        ? t('settings.summary.feedback', { count: config.project.feedback.surfaces.length })
        : t('settings.summary.feedbackEmpty');
    case 'email':
      return emailChannelOn(config)
        ? t('settings.summary.emailOn', {
            ai: config.team.members.filter((member) => member.kind === 'ai' && member.email?.enabled).length,
            humans: emailHumans,
          })
        : t('settings.summary.emailOff');
    case 'history':
      return history[0]
        ? t('settings.summary.history', {
            time: formatAgo(history[0].at),
            author: hasBoundOrigin(history[0].actor)
              ? actorLabel(history[0].actor, members, myHandle)
              : history[0].operator
                ? (config.team.members.find((member) => member.handle === history[0]!.operator)
                    ?.displayName ?? history[0].operator)
                : history[0].author,
          })
        : t('settings.summary.historyEmpty');
  }
}

export function SettingsPage() {
  const { key, isOwner, me, can, myHandle } = useProject();
  const { members } = useProjectIndexes(key);
  const config = useConfig(key);
  // Engines exist in cloud mode only, and only the host owner manages them (PM-316).
  const engineStatus = useEngineStatus();
  // The summary counts the people who ask for e-mail; only the channel view knows them.
  const emailChannel = useEmailChannel(
    key,
    can.manageTeam && config.data !== undefined && emailChannelOn(config.data.config),
  );
  const emailHumans = emailChannel.data?.contacts.filter((contact) => contact.wants).length ?? 0;
  // An owner account (PM-1062) manages its own machines and holds its own integrator key.
  const machineOwner = me.hostOwner === true || me.ownerAccount === true;
  const enginesShown = machineOwner && engineStatus.data?.mode === 'cloud';
  // The feedback tool's and the e-mail channel's settings are for owners and admins: the rule the project manager's places follow.
  const access = me.projects.find((project) => project.key === key)?.access;
  const sectionVisible = (id: SettingsSectionId) =>
    access !== undefined && settingsSectionVisible(id, access);
  const wide = useMediaQuery(SETTINGS_WIDE_QUERY);
  const { section: routeSection } = useParams();
  const section = isSettingsSection(routeSection) ? routeSection : undefined;
  const ownersShown = me.hostOwner === true && !me.via;
  const hostRequests = useHostRequests('open', ownersShown);
  const ownerAccounts = useOwnerAccounts(ownersShown && !wide && !section);
  const ownersSummary = {
    owners: ownerAccounts.data?.accounts.filter((a) => a.revokedAt === null).length ?? 0,
    open: hostRequests.data?.requests.length ?? 0,
  };
  const location = useLocation();
  const ownerTopicTarget =
    new URLSearchParams(location.search).get('field')?.startsWith('ownerDecisionTopics') === true;
  const main = useRef<HTMLDivElement>(null);
  const previousSection = useRef(section);
  const base = `/p/${key}/settings`;
  const legacy =
    location.hash === '#settings-problems' ? 'pipeline' : location.hash.replace(/^#settings-/, '');
  // An owner account holds no operator grant (that is the host's): its integrator section is its own client's key.
  const sectionLabel = (id: SettingsSectionId) =>
    id === 'integrator' ? t('integratorKey.title') : t(`settings.nav.${id}`);
  useDocumentTitle(
    section ? sectionLabel(section) : null,
    t('settings.title'),
    config.data?.config.project.name ?? me.projects.find((p) => p.key === key)?.name,
  );
  useEffect(() => {
    // The topic editor opens and focuses its own field for a configuration problem link.
    if (section === 'team' && ownerTopicTarget) {
      previousSection.current = section;
      return;
    }
    main.current?.closest('main')?.scrollTo?.(0, 0);
    if (wide && location.state?.settingsIssueTarget && section) {
      main.current?.querySelector<HTMLElement>(`#settings-${section}`)?.focus();
    } else if (!wide) {
      if (section) {
        const heading = main.current?.querySelector<HTMLElement>(
          section === 'owners' ? '#settings-host-requests, #settings-owners' : `#settings-${section}`,
        );
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
    ownerTopicTarget,
  ]);

  if (isSettingsSection(legacy))
    return <Navigate replace to={{ pathname: `${base}/${legacy}`, search: location.search }} />;
  if (routeSection && !section) return <Navigate replace to={base} />;
  if (section === 'owners' && !ownersShown) return <Navigate replace to={base} />;
  // The engines section is not there for a member who cannot manage them, or on a one-machine installation.
  if (section === 'engines' && !enginesShown && !(machineOwner && engineStatus.isPending))
    return <Navigate replace to={base} />;
  // The feedback tool's settings are for owners and admins.
  if (section && !sectionVisible(section)) return <Navigate replace to={base} />;
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
    (id) =>
      (id !== 'owners' || ownersShown) &&
      (id !== 'integrator' || machineOwner) &&
      (id !== 'engines' || enginesShown) &&
      sectionVisible(id),
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
              {sectionLabel(id)}{' '}
              {id === 'owners' && ownersSummary.open > 0 && (
                <span
                  className={styles.count}
                  aria-label={t('settings.ownersOpenMark', { n: ownersSummary.open })}
                >
                  {ownersSummary.open}
                </span>
              )}
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
                {summary(
                  id,
                  config.data,
                  me.name,
                  engineStatus.data?.engines,
                  emailHumans,
                  ownersSummary,
                  members,
                  myHandle,
                )}
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
  else if (section === 'owners') content = <OwnersSection />;
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
      case 'feedback':
        content = <FeedbackSection config={view.config} version={view.version} />;
        break;
      case 'email':
        content = <EmailSection config={view.config} version={view.version} />;
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
          {section !== 'account' && section !== 'engines' && section !== 'owners' ? (
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
