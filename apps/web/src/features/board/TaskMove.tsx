import { useState } from 'react';
import type { Task } from '@projectman/shared';
import { useLabels, useMoveTask } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { useToast } from '../../components/toastContext';
import { Button } from '../../components/Button';
import { SelectField } from '../../components/Field';
import { Popover } from '../../components/Popover';
import { t } from '../../i18n/t';
import { isApprovalRequested } from '../../lib/errors';
import { gateConditionText } from '../../lib/gates';
import { nextStage } from '../../lib/pipeline';
import type { PipelineIndex } from '../../lib/pipeline';
import { PrerequisiteWarning } from './PrerequisiteWarning';
import { enteredStages, moveErrorText, prerequisitesToWarnAbout } from './moveTask';
import styles from './drawer.module.css';

/**
 * Moving the task: one small button that opens a panel with the target stage. The gate conditions
 * show only when the move enters a stage that has some.
 */
export function TaskMove({
  task,
  pipeline,
  tasks,
}: {
  task: Task;
  pipeline: PipelineIndex;
  tasks: readonly Task[];
}) {
  const { key } = useProject();
  const labels = useLabels(key);
  const move = useMoveTask(key);
  const toast = useToast();
  const [warning, setWarning] = useState<string[] | null>(null);
  const submit = async (close: () => void, despitePrerequisites?: boolean) => {
    try {
      await move.mutateAsync({ taskKey: task.key, stageId: target, despitePrerequisites });
      toast.show(t('task.move.success'));
      close();
    } catch {
      // Gate and approval feedback stays inline through the mutation state.
    }
  };
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
    <Popover label={t('task.move.open')} iconRight="chevronDown" align="row">
      {(close) => (
        <>
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
          {conditions.length ? (
            <div className={styles.conditions}>
              <p>{t('task.move.conditions')}</p>
              <ul>
                {conditions.map((text, index) => (
                  <li key={index}>{text}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {move.isError ? (
            <p
              role={isApprovalRequested(move.error) ? 'status' : 'alert'}
              className={isApprovalRequested(move.error) ? undefined : styles.error}
            >
              {moveErrorText(move.error, labels)}
            </p>
          ) : null}
          <Button
            size="md"
            loading={move.isPending}
            disabled={!target}
            onClick={() => {
              // A card that would start with an open prerequisite asks first (PM-204).
              const open = prerequisitesToWarnAbout(task, target, pipeline, tasks);
              if (open.length > 0) setWarning(open);
              else void submit(close);
            }}
          >
            {t('task.move.submit')}
          </Button>
          <PrerequisiteWarning
            keys={warning}
            tasks={tasks}
            loading={move.isPending}
            onConfirm={() => {
              setWarning(null);
              void submit(close, true);
            }}
            onClose={() => setWarning(null)}
          />
        </>
      )}
    </Popover>
  );
}
