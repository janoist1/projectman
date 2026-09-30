import { useState } from 'react';
import type { ProjectConfig, Stage } from '@projectman/shared';
import { Button } from '../../../components/Button';
import { t } from '../../../i18n/t';
import shared from '../settings.module.css';
import styles from './AddStage.module.css';
import { pipelineId, StageFields, StageOwners } from './StageFields';
import type { StageUpdate } from './StageFields';

/** A new stage: its fields, where it goes and who owns it. */
export function AddStage({
  config,
  change,
  close,
}: {
  config: ProjectConfig;
  change: (update: (draft: ProjectConfig) => void) => void;
  close: () => void;
}) {
  const [stage, setStage] = useState<Stage>({
    id: '',
    name: '',
    kind: 'work',
    duty: 'implementation',
    columnId: config.pipeline.columns[0]!.id,
  });
  const [after, setAfter] = useState(config.pipeline.stages[0]?.id ?? '');
  const update: StageUpdate = (update) => {
    const next = structuredClone(stage);
    update(next);
    setStage(next);
  };
  const canAdd =
    !!stage.name.trim() &&
    (after === '' || config.pipeline.stages.some((entry) => entry.id === after)) &&
    config.pipeline.columns.some((entry) => entry.id === stage.columnId);
  const add = () => {
    if (!canAdd) return;
    change((draft) => {
      const id = pipelineId(
        stage.name,
        draft.pipeline.stages.map((stage) => stage.id),
      );
      const index = draft.pipeline.stages.findIndex((stage) => stage.id === after);
      draft.pipeline.stages.splice(index + 1, 0, { ...stage, id, name: stage.name.trim() });
    });
    close();
  };
  return (
    <fieldset
      className={styles.newStage}
      aria-label={t('settings.pipeline.addStage')}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
          event.preventDefault();
          add();
        }
      }}
    >
      <legend>{t('settings.pipeline.addStage')}</legend>
      <StageFields stage={stage} pipeline={config.pipeline} update={update} />
      <label className={shared.field}>
        {t('settings.pipeline.afterStage')}
        <select value={after} onChange={(event) => setAfter(event.target.value)}>
          <option value="">{t('settings.pipeline.atStart')}</option>
          {config.pipeline.stages.map((existing) => (
            <option key={existing.id} value={existing.id}>
              {existing.name}
            </option>
          ))}
        </select>
      </label>
      <StageOwners stage={stage} config={config} update={update} />
      <div className={shared.actions}>
        <Button disabled={!canAdd} onClick={add}>
          {t('settings.pipeline.createStage')}
        </Button>
        <Button onClick={close}>{t('common.cancel')}</Button>
      </div>
    </fieldset>
  );
}
