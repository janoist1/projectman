import { useEffect, useState } from 'react';
import { mergeRepoOf, mergeTargetOf } from '@projectman/shared';
import type { ProjectConfig, Task } from '@projectman/shared';
import { useLabels, useMoveTask } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { useToast } from '../../components/toastContext';
import { Button } from '../../components/Button';
import { SelectField } from '../../components/Field';
import { Icon } from '../../components/Icon';
import { Popover } from '../../components/Popover';
import { t } from '../../i18n/t';
import { isApprovalRequested } from '../../lib/errors';
import { gateConditionText } from '../../lib/gates';
import { mergeConditionKey, mergeConditionState, notMergedOf, refusalFactsOf } from '../../lib/merge';
import type { MergeConditionState } from '../../lib/merge';
import { nextStage } from '../../lib/pipeline';
import type { PipelineIndex } from '../../lib/pipeline';
import { MergeRefusal } from './MergeRefusal';
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
  config,
  sendBack,
}: {
  task: Task;
  pipeline: PipelineIndex;
  tasks: readonly Task[];
  /** The configuration, for the merge condition of the move; missing where the viewer may not read it. */
  config?: ProjectConfig;
  /** Grows when the merge box sends the card back: the panel opens at the work stage. */
  sendBack?: number;
}) {
  const { key, myHandle } = useProject();
  const { members } = useProjectIndexes(key);
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
  // "Vissza a fejlesztőnek" from the merge box: the nearest work stage before this one.
  const workStage = [...pipeline.stages.slice(0, pipeline.stageIndex.get(task.stageId) ?? 0)]
    .reverse()
    .find((stage) => stage.kind === 'work');
  useEffect(() => {
    if (!sendBack || !workStage) return;
    setTarget(workStage.id);
    move.reset();
    // Only a new request moves the target; the stage found is read as it is then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendBack]);
  if (!options.length) return null;
  const conditions: { text: string; merge?: MergeConditionState }[] = enteredStages(
    pipeline,
    task.stageId,
    target,
  ).flatMap((stage) =>
    (stage.gate?.conditions ?? []).map((condition) => ({
      text: t('task.move.condition', {
        stage: stage.name,
        condition: gateConditionText(condition, labels),
      }),
    })),
  );
  // The work must be in the main branch before the move (PM-453): where the card stands, from its own fields.
  const mergeRepo = config ? mergeRepoOf(config, task, task.stageId, target) : null;
  if (config && mergeRepo) {
    conditions.push({
      text: t('task.move.condition', {
        stage: pipeline.stageById.get(mergeTargetOf(config)?.id ?? target)?.name ?? '',
        condition: t('task.move.merge.condition', { base: mergeRepo.defaultBranch }),
      }),
      merge: mergeConditionState(task),
    });
  }
  const refusalFacts = refusalFactsOf({
    task,
    config,
    members,
    myHandle,
    target: pipeline.stageById.get(target)?.name ?? '',
  });
  return (
    <Popover label={t('task.move.open')} iconRight="chevronDown" align="row" openRequest={sendBack}>
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
                {conditions.map((condition, index) => (
                  <li key={index} data-merge={condition.merge}>
                    {condition.text}
                    {condition.merge ? (
                      <>
                        {' '}
                        {condition.merge === 'met' ? <Icon name="check" size={12} strokeWidth={3} /> : null}
                        <span>({t(mergeConditionKey[condition.merge])})</span>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {move.isError && notMergedOf(move.error) ? (
            <MergeRefusal
              error={move.error}
              task={task}
              facts={refusalFacts}
              onStarted={() => {
                move.reset();
                close();
              }}
            />
          ) : move.isError ? (
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
            onWait={() => {
              setWarning(null);
              void submit(close);
            }}
            onClose={() => setWarning(null)}
          />
        </>
      )}
    </Popover>
  );
}
