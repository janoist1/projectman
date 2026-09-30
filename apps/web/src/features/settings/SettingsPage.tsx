import { useConfig } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Chip } from '../../components/Chip';
import { PageHeader } from '../../components/PageHeader';
import { ErrorState, LoadingState } from '../../components/States';
import { t } from '../../i18n/t';
import { useDocumentTitle } from '../../lib/hooks';
import { ConfigProblems } from './ConfigProblems';
import { DutiesMatrix } from './DutiesMatrix';
import { SettingsEditingProvider } from './SettingsEditor';
import shared from './settings.module.css';
import styles from './SettingsPage.module.css';
import { AccountSection } from './sections/AccountSection';
import { HistorySection } from './sections/HistorySection';
import { LabelsSection } from './sections/LabelsSection';
import { LimitsSection } from './sections/LimitsSection';
import { PipelineSection } from './sections/PipelineSection';
import { ProjectSection } from './sections/ProjectSection';
import { ReposSection } from './sections/ReposSection';
import { SettingsSection } from './sections/SettingsSection';
import { TeamSection } from './sections/TeamSection';

/** Project configuration with section editors, version history and owner-only revert. */
export function SettingsPage() {
  const { key, isOwner } = useProject();
  const config = useConfig(key);
  useDocumentTitle(t('settings.title'), config.data?.config.project.name);

  return (
    <div className={styles.page}>
      <PageHeader className={styles.header} title={t('settings.title')} subtitle={t('settings.subtitle')}>
        {config.data ? (
          <Chip tone="outline" size="md" mono>
            {t('settings.version', { version: config.data.version.slice(0, 7) })}
          </Chip>
        ) : null}
      </PageHeader>
      <div className={styles.grid}>
        <div className={styles.mainCol}>
          {config.isPending ? <LoadingState /> : null}
          {config.isError ? (
            <SettingsSection>
              <p className={shared.muted}>{t('settings.unavailable')}</p>
              <ErrorState compact error={config.error} onRetry={() => void config.refetch()} />
            </SettingsSection>
          ) : null}
          {config.data ? (
            <SettingsEditingProvider view={config.data} reload={async () => (await config.refetch()).data}>
              <ConfigProblems config={config.data.config} />
              <ProjectSection config={config.data.config} />
              <PipelineSection config={config.data.config} />
              <LabelsSection config={config.data.config} />
              <DutiesMatrix
                key={config.data.version}
                config={config.data.config}
                version={config.data.version}
              />
              <TeamSection config={config.data.config} />
              <LimitsSection config={config.data.config} />
              <ReposSection config={config.data.config} />
            </SettingsEditingProvider>
          ) : null}
        </div>
        <aside className={styles.sideCol}>
          {config.data ? (
            <HistorySection history={config.data.history} current={config.data.version} canRevert={isOwner} />
          ) : null}
          <AccountSection />
        </aside>
      </div>
    </div>
  );
}
