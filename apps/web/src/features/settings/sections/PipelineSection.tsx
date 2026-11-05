import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { teamMap, validateProjectConfig } from '@projectman/shared';
import type { ProjectConfig } from '@projectman/shared';
import { useProject } from '../../../app/contexts';
import { Button } from '../../../components/Button';
import { Icon } from '../../../components/Icon';
import { t } from '../../../i18n/t';
import { readStorage, writeStorage } from '../../../lib/hooks';
import { SettingsDetailLayout } from '../DetailPanel';
import { LeaveGuardProvider } from '../edit/LeaveGuard';
import { issueTarget } from '../issueTarget';
import { focusRow } from '../pipeline/focusRow';
import { emptyColumns } from '../pipeline/flow';
import { PipelineFlow } from '../pipeline/PipelineFlow';
import { PipelinePanel } from '../pipeline/PipelinePanel';
import { usePipelineMove } from '../pipeline/useMove';
import { useSettingsSelection } from '../selection';
import type { SettingsShow } from '../selection';
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

/** Moves the focus to the row that stands where a deleted one was (the add button when none is left). */
function focusAfterDelete(config: ProjectConfig, kind: 'stage' | 'column', id: string) {
  const { stages } = config.pipeline;
  let target: string | null = null;
  if (kind === 'stage') {
    const index = stages.findIndex((stage) => stage.id === id);
    const near = stages[index + 1] ?? stages[index - 1];
    if (near) target = `stage:${near.id}`;
  } else {
    const stageless = emptyColumns(config.pipeline).filter((column) => column.id !== id);
    const index = emptyColumns(config.pipeline).findIndex((column) => column.id === id);
    const near = stageless[index] ?? stageless[index - 1];
    target = near ? `column:${near.id}` : 'new-column';
  }
  // After the panel closed and the path was drawn again.
  window.setTimeout(() => focusRow(target), 0);
}

function PipelineBody({ config }: { config: ProjectConfig }) {
  const { key, can } = useProject();
  const selection = useSettingsSelection();
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
    selection.show?.type === 'stage' ||
    selection.show?.type === 'column' ||
    selection.show?.type === 'new-column'
      ? selection.show
      : null;
  const flashStage = (id: string) => setFlash((previous) => ({ id, count: (previous?.count ?? 0) + 1 }));
  const mover = usePipelineMove(flashStage);
  return (
    <SettingsSection id="settings-pipeline" title={t('settings.sections.pipeline')}>
      <div className={styles.head}>
        <span className={styles.summary}>
          {t('settings.pipeline.summary', {
            stages: config.pipeline.stages.length,
            columns: config.pipeline.columns.length,
          })}
        </span>
        <Link to={`/p/${key}/how-we-work`}>{t('settings.pipeline.howWeWorkLink')}</Link>
        {can.manageTeam ? (
          <Button
            variant="secondary"
            size="sm"
            data-add-stage=""
            onClick={() => selection.open({ type: 'new-stage' })}
          >
            <Icon name="plus" size={14} /> {t('settings.pipeline.addStage')}
          </Button>
        ) : null}
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
            <p>{t(can.manageTeam ? 'settings.pipeline.intro.bodyAdmin' : 'settings.pipeline.intro.body')}</p>
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
          canEdit={can.manageTeam}
          mover={mover}
          onSelect={selection.open}
          onNewStage={(after) => selection.open({ type: 'new-stage', after })}
          onNewColumn={() => selection.open({ type: 'new-column' })}
        />
        <PipelinePanel
          config={config}
          show={selection.show}
          fromHowWeWork={selection.from === 'how-we-work'}
          legendOpen={legendOpen}
          mover={mover}
          onSelect={selection.open}
          onClose={() => {
            if (selection.show) selection.close();
            setLegendOpen(false);
          }}
          onSaved={flashStage}
          onDeleted={(kind, id) => {
            selection.close();
            focusAfterDelete(config, kind, id);
          }}
          onCreated={(show: SettingsShow) => {
            selection.replace(show);
            if (show.type === 'stage') flashStage(show.id);
          }}
        />
      </SettingsDetailLayout>
    </SettingsSection>
  );
}
