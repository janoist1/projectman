import { useContext, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { teamMap, validateProjectConfig } from '@projectman/shared';
import type { ProjectConfig } from '@projectman/shared';
import { useProject } from '../../../app/contexts';
import { Button } from '../../../components/Button';
import { t } from '../../../i18n/t';
import { readStorage, writeStorage } from '../../../lib/hooks';
import { SettingsDetailLayout } from '../DetailPanel';
import { LeaveGuardContext, LeaveGuardProvider } from '../edit/LeaveGuard';
import { issueTarget } from '../issueTarget';
import { PipelineEditor } from '../PipelineEditor';
import { PipelineFlow } from '../pipeline/PipelineFlow';
import { PipelinePanel } from '../pipeline/PipelinePanel';
import { useSettingsSelection } from '../selection';
import { EditableSection } from '../SettingsEditor';
import styles from './PipelineSection.module.css';
import { SettingsSection } from './SettingsSection';

const INTRO_KEY = 'pm.settings.pipelineIntro';

/** The pipeline as a path from top to bottom; the selected stage or column opens in a panel beside it. */
export function PipelineSection({ config }: { config: ProjectConfig }) {
  return (
    <LeaveGuardProvider>
      <PipelineBody config={config} />
    </LeaveGuardProvider>
  );
}

function PipelineBody({ config }: { config: ProjectConfig }) {
  const { key, can } = useProject();
  const selection = useSettingsSelection();
  const guard = useContext(LeaveGuardContext);
  const [legendOpen, setLegendOpen] = useState(false);
  const [introSeen, setIntroSeen] = useState(() => readStorage(INTRO_KEY) === '1');
  /** The stage that was just saved; `count` makes the same stage flash again. */
  const [flash, setFlash] = useState<{ id: string; count: number } | null>(null);
  const map = useMemo(() => teamMap(config), [config]);
  const problemStages = useMemo(() => {
    const stages = new Set<string>();
    for (const issue of validateProjectConfig(config)) {
      if (issue.severity === 'warning') continue;
      const target = issueTarget(issue.path, config);
      if (target?.section === 'pipeline' && target.show?.type === 'stage') stages.add(target.show.id);
    }
    return stages;
  }, [config]);
  const select =
    selection.show?.type === 'stage' || selection.show?.type === 'column' ? selection.show : null;
  return (
    <SettingsSection id="settings-pipeline" title={t('settings.sections.pipeline')}>
      <EditableSection
        section="pipeline"
        editor={(props) => <PipelineEditor {...props} />}
        editLabel={t('settings.pipeline.manage')}
        beforeStart={guard ? guard.request : undefined}
        onStartEdit={selection.show ? selection.close : undefined}
      >
        <div className={styles.head}>
          <span className={styles.summary}>
            {t('settings.pipeline.summary', {
              stages: config.pipeline.stages.length,
              columns: config.pipeline.columns.length,
            })}
          </span>
          <Link to={`/p/${key}/how-we-work`}>{t('settings.pipeline.howWeWorkLink')}</Link>
          <Button
            className={styles.legendButton}
            variant="secondary"
            size="sm"
            onClick={() => setLegendOpen(true)}
          >
            {t('howWeWork.legendButton')}
          </Button>
        </div>
        {introSeen ? null : (
          <div className={styles.intro} role="note">
            <div>
              <h3>{t('settings.pipeline.intro.title')}</h3>
              <p>
                {t(can.manageTeam ? 'settings.pipeline.intro.bodyAdmin' : 'settings.pipeline.intro.body')}
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                writeStorage(INTRO_KEY, '1');
                setIntroSeen(true);
              }}
            >
              {t('settings.pipeline.intro.dismiss')}
            </Button>
          </div>
        )}
        <SettingsDetailLayout>
          <PipelineFlow
            config={config}
            map={map}
            selected={select}
            problemStages={problemStages}
            flash={flash}
            onSelect={selection.open}
          />
          <PipelinePanel
            config={config}
            show={selection.show}
            fromHowWeWork={selection.from === 'how-we-work'}
            legendOpen={legendOpen}
            onSelect={selection.open}
            onClose={() => {
              if (selection.show) selection.close();
              setLegendOpen(false);
            }}
            onSaved={(id) => setFlash((previous) => ({ id, count: (previous?.count ?? 0) + 1 }))}
          />
        </SettingsDetailLayout>
      </EditableSection>
    </SettingsSection>
  );
}
