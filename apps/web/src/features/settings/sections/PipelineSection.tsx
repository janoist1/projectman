import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { teamMap, validateProjectConfig } from '@projectman/shared';
import type { ProjectConfig } from '@projectman/shared';
import { useProject } from '../../../app/contexts';
import { Button } from '../../../components/Button';
import { t } from '../../../i18n/t';
import { readStorage, writeStorage } from '../../../lib/hooks';
import { SettingsDetailLayout } from '../DetailPanel';
import { issueTarget } from '../issueTarget';
import { PipelineEditor } from '../PipelineEditor';
import { PipelineFlow } from '../pipeline/PipelineFlow';
import { PipelinePanel } from '../pipeline/PipelinePanel';
import { useSettingsSelection } from '../selection';
import { EditableSection } from '../SettingsEditor';
import styles from './PipelineSection.module.css';
import { SettingsSection } from './SettingsSection';

const INTRO_KEY = 'pm.settings.pipelineIntro';

/** The pipeline as a path from top to bottom, with a read-only panel for the selected stage or column. */
export function PipelineSection({ config }: { config: ProjectConfig }) {
  const { key } = useProject();
  const selection = useSettingsSelection();
  const [legendOpen, setLegendOpen] = useState(false);
  const [introSeen, setIntroSeen] = useState(() => readStorage(INTRO_KEY) === '1');
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
              <p>{t('settings.pipeline.intro.body')}</p>
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
          />
        </SettingsDetailLayout>
      </EditableSection>
    </SettingsSection>
  );
}
