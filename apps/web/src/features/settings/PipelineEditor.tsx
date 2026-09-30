import { useState } from 'react';
import type { Stage } from '@projectman/shared';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { t } from '../../i18n/t';
import { AddStage } from './pipeline/AddStage';
import { ColumnsEditor } from './pipeline/ColumnsEditor';
import { RemovedStages } from './pipeline/RemovedStages';
import { StageCard } from './pipeline/StageCard';
import type { SectionEditorProps } from './SettingsEditor';
import shared from './settings.module.css';

/** The pipeline editor: board columns, then the stages in order, and the stages removed so far. */
export function PipelineEditor({ draft, change, isOwner, original, submitted, issues }: SectionEditorProps) {
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Stage | null>(null);
  return (
    <>
      <ColumnsEditor draft={draft} change={change} />
      <Button onClick={() => setAdding(true)} disabled={adding}>
        {t('settings.pipeline.addStage')}
      </Button>
      {adding && <AddStage config={draft} change={change} close={() => setAdding(false)} />}
      <ol className={shared.stages}>
        {draft.pipeline.stages.map((stage, index) => (
          <StageCard
            key={stage.id}
            draft={draft}
            index={index}
            change={change}
            isOwner={isOwner}
            issues={issues}
            sent={submitted ?? draft.pipeline}
            onRemove={setRemoving}
          />
        ))}
      </ol>
      <RemovedStages draft={draft} original={original} change={change} />
      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        size="sm"
        title={removing ? t('settings.pipeline.removeTitle', { stage: removing.name }) : ''}
        description={t('settings.pipeline.removeBody')}
        footer={
          <>
            <Button
              variant="dangerSolid"
              onClick={() => {
                change((config) => {
                  config.pipeline.stages = config.pipeline.stages.filter(
                    (stage) => stage.id !== removing?.id,
                  );
                });
                setRemoving(null);
              }}
            >
              {t('settings.pipeline.removeStage')}
            </Button>
            <Button onClick={() => setRemoving(null)}>{t('common.cancel')}</Button>
          </>
        }
      />
    </>
  );
}
