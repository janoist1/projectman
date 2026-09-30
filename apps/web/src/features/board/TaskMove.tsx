import { useState } from 'react';
import type { Task } from '@projectman/shared';
import { useLabels, useMoveTask } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { useToast } from '../../components/toastContext';
import { Button } from '../../components/Button';
import { SelectField } from '../../components/Field';
import { t } from '../../i18n/t';
import { isApprovalRequested } from '../../lib/errors';
import { gateConditionText } from '../../lib/gates';
import { nextStage } from '../../lib/pipeline';
import type { PipelineIndex } from '../../lib/pipeline';
import { enteredStages, moveErrorText } from './moveTask';
import styles from './TaskDrawer.module.css';

export function TaskMove({ task, pipeline }: { task: Task; pipeline: PipelineIndex }) {
  const { key } = useProject();
  const labels = useLabels(key);
  const move = useMoveTask(key);
  const toast = useToast();
  const options = pipeline.stages.filter((stage) => stage.id !== task.stageId);
  const [target, setTarget] = useState(nextStage(pipeline, task.stageId)?.id ?? options[0]?.id ?? '');
  if (!options.length) return null;
  const conditions = enteredStages(pipeline, task.stageId, target).flatMap((stage) =>
    (stage.gate?.conditions ?? []).map((condition) =>
      t('task.move.condition', {
        stage: stage.name,
        condition: gateConditionText(condition, labels),
      }),
    ),
  );
  return (
    <section className={styles.section}>
      <SelectField
        label={t('task.move.target')}
        value={target}
        disabled={move.isPending}
        onChange={(event) => {
          setTarget(event.target.value);
          move.reset();
        }}
      >
        {options.map((stage) => (
          <option key={stage.id} value={stage.id}>
            {stage.name}
          </option>
        ))}
      </SelectField>
      <p>{t('task.move.conditions')}</p>
      {conditions.length ? (
        <ul>
          {conditions.map((text, index) => (
            <li key={index}>{text}</li>
          ))}
        </ul>
      ) : (
        <p>{t('task.move.noConditions')}</p>
      )}
      {move.isError ? (
        <p
          role={isApprovalRequested(move.error) ? 'status' : 'alert'}
          className={isApprovalRequested(move.error) ? undefined : styles.error}
        >
          {moveErrorText(move.error, labels)}
        </p>
      ) : null}
      {move.isSuccess ? <p role="status">{t('task.move.success')}</p> : null}
      <Button
        loading={move.isPending}
        disabled={!target}
        onClick={async () => {
          try {
            await move.mutateAsync({ taskKey: task.key, stageId: target });
            toast.show(t('task.move.success'));
          } catch {
            // Gate and approval feedback stays inline through the mutation state.
          }
        }}
      >
        {t('task.move.submit')}
      </Button>
    </section>
  );
}
