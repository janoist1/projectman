import type { Ref } from 'react';
import { Link } from 'react-router';
import type { Task } from '@projectman/shared';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Chip, StatusDot } from '../../components/Chip';
import { StageProgress } from '../../components/StageProgress';
import { formatAgo } from '../../i18n/format';
import { t } from '../../i18n/t';
import { nameOf } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import { stagePosition } from '../../lib/pipeline';
import type { PipelineIndex } from '../../lib/pipeline';
import type { TaskState } from '../../lib/taskState';
import { prChip } from './cardModel';
import { TaskRepo } from './TaskRepo';
import styles from './TaskHeader.module.css';

/**
 * The drawer's head: the parent task, the stage and PR chips with close, the title, the facts
 * (key, repo, assignee, visibility), the pipeline stepper and where the task stands now.
 */
export function TaskHeader({
  task,
  parent,
  state,
  pipeline,
  members,
  headingRef,
  onClose,
}: {
  task: Task;
  parent: Pick<Task, 'key' | 'title'> | null | undefined;
  state: TaskState;
  pipeline: PipelineIndex;
  members: MemberIndex;
  headingRef: Ref<HTMLHeadingElement>;
  onClose: () => void;
}) {
  const { key, myHandle } = useProject();
  const stage = pipeline.stageById.get(task.stageId);
  const column = pipeline.columnOfStage.get(task.stageId);
  const position = stagePosition(pipeline, task.stageId);
  const stageLabel =
    column && stage && column.name !== stage.name
      ? `${column.name} · ${stage.name}`
      : (stage?.name ?? task.stageId);
  const pr = prChip(task);
  const prBadge = pr ? (
    <Chip tone="neutral" size="md" icon={pr.merged ? 'prMerged' : 'prOpen'}>
      {pr.label}
    </Chip>
  ) : null;
  return (
    <div className={styles.head}>
      {parent ? (
        <Link to={`/p/${key}/tasks/${parent.key}`}>
          {t('task.parent', { key: parent.key, title: parent.title })}
        </Link>
      ) : null}
      <div className={styles.chips}>
        <Chip tone="column" data-column-color={column?.color} size="md">
          {t('task.stageChip', { stage: stageLabel, index: position.index, total: position.total })}
        </Chip>
        {pr?.href ? (
          <a href={pr.href} target="_blank" rel="noreferrer noopener" className={styles.prLink}>
            {prBadge}
          </a>
        ) : (
          prBadge
        )}
        <span className={styles.spacer} />
        <Button variant="muted" iconOnly icon="close" onClick={onClose} aria-label={t('common.close')} />
      </div>
      <h2 ref={headingRef} tabIndex={-1} className={styles.title}>
        {task.title}
      </h2>
      <div className={styles.facts}>
        <span className={styles.key}>{task.key}</span>
        <TaskRepo key={task.key} task={task} />
        {task.assignee ? (
          <span>{t('task.assignee', { name: nameOf(task.assignee, members, myHandle) })}</span>
        ) : null}
        <span>{t(`visibility.${task.visibility}`)}</span>
      </div>
      <StageProgress pipeline={pipeline} stageId={task.stageId} phase={state.phase} variant="stepper" />
      <div className={styles.now} data-phase={state.phase}>
        <StatusDot phase={state.phase} pulse={state.phase === 'working'} size={9} />
        <span className={styles.nowText}>{state.label}</span>
        <span className={styles.nowAge}>{formatAgo(state.since)}</span>
      </div>
    </div>
  );
}
