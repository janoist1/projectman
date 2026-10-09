import clsx from 'clsx';
import type { Ref } from 'react';
import { Link } from 'react-router';
import type { LabelView, Task } from '@projectman/shared';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Chip, StatusDot } from '../../components/Chip';
import { StageProgress } from '../../components/StageProgress';
import { formatAgo } from '../../i18n/format';
import { t } from '../../i18n/t';
import type { MemberIndex } from '../../lib/members';
import { stagePosition } from '../../lib/pipeline';
import type { PipelineIndex } from '../../lib/pipeline';
import type { TaskState, TaskWorker } from '../../lib/taskState';
import { PmButton } from '../pm/PmButton';
import { prChip } from './cardModel';
import { CardSizeToggle, useCardLink } from './cardSize';
import { useDrawerBase } from './drawerBase';
import type { CardSize } from './cardSize';
import { TaskTitle } from './TaskEdit';
import { RefinementRow } from './RefinementRow';
import { TaskLifecycleMenu } from './TaskLifecycle';
import styles from './TaskHeader.module.css';

/**
 * What one worker does, in full (PM-239): "{name}: {summary}" and the longer text under it. A worker
 * who gave no sentence reads as before ("{name} átnézi"). The sentences are the member's own text.
 */
function WorkerText({ worker }: { worker: TaskWorker }) {
  const { doing } = worker;
  if (!doing) return <span className={styles.nowText}>{worker.sentence}</span>;
  return (
    <span className={styles.nowText}>
      <span className="visually-hidden">{worker.line}</span>
      {/* The key replays the fade-in when the member changes its sentence. */}
      <span key={`${doing.summary}\n${doing.detail ?? ''}`} className={styles.nowDoing}>
        {/* The hidden line above says name and summary; the longer text is read as it stands. */}
        <span aria-hidden="true">
          {t('taskStatus.workerName', { name: worker.member.displayName })}{' '}
          <span className={styles.nowSummary}>{doing.summary}</span>
        </span>
        {doing.detail ? <span className={styles.nowDetail}>{doing.detail}</span> : null}
      </span>
    </span>
  );
}

/**
 * The drawer's head: the parent task, the stage and PR chips with the "⋯" menu and close, the title
 * (edited in place), the pipeline stepper and where the task stands now. The other properties sit
 * below, in the properties rows.
 */
export function TaskHeader({
  task,
  parent,
  state,
  pipeline,
  members,
  labels,
  headingRef,
  size,
  onToggleSize,
  onClose,
  rule = true,
}: {
  task: Task;
  parent: Pick<Task, 'key' | 'title'> | null | undefined;
  state: TaskState;
  pipeline: PipelineIndex;
  members: MemberIndex;
  labels: readonly LabelView[];
  headingRef: Ref<HTMLHeadingElement>;
  size: CardSize;
  /** Switches between the quick view and the large window; missing where there is no large window (a phone). */
  onToggleSize: (() => void) | undefined;
  onClose: () => void;
  /** The line under the head; off where the view switch stands under it and carries the line itself. */
  rule?: boolean;
}) {
  const { myHandle, can } = useProject();
  const cardLink = useCardLink();
  const drawerBase = useDrawerBase();
  // While the card is being refined, the status box also says how far the steps are (PM-291).
  const refinement =
    state.startBlock?.kind === 'refining' ? (
      <RefinementRow
        key={task.key}
        refinement={state.startBlock.refinement}
        labels={labels}
        members={members}
        myHandle={myHandle}
        pipeline={pipeline}
      />
    ) : null;
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
    <div className={clsx(styles.head, !rule && styles.bare)}>
      {parent ? (
        <Link to={cardLink(drawerBase.card(parent.key))}>
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
        <span className={styles.key}>{task.key}</span>
        <span className={styles.spacer} />
        {can.manageTeam ? <TaskLifecycleMenu key={task.key} task={task} /> : null}
        <PmButton variant="drawer" />
        <CardSizeToggle size={size} onToggle={onToggleSize} />
        <Button variant="muted" iconOnly icon="close" onClick={onClose} aria-label={t('common.close')} />
      </div>
      <TaskTitle key={task.key} task={task} headingRef={headingRef} />
      <StageProgress pipeline={pipeline} stageId={task.stageId} phase={state.phase} variant="stepper" />
      {state.workers.length > 1 ? (
        // Several work on it: one row each, with their own verb, sentence and time.
        <ul className={styles.nowList} data-phase={state.phase} aria-label={state.label}>
          {state.workers.map((worker) => (
            <li key={worker.sessionId} className={styles.nowRow}>
              <StatusDot phase={state.phase} pulse size={9} />
              <WorkerText worker={worker} />
              <span className={styles.nowAge}>{formatAgo(worker.since)}</span>
            </li>
          ))}
          {refinement ? <li>{refinement}</li> : null}
        </ul>
      ) : (
        <div className={styles.now} data-phase={state.phase}>
          <StatusDot phase={state.phase} pulse={state.phase === 'working'} size={9} />
          {state.workers[0]?.doing ? (
            <WorkerText worker={state.workers[0]} />
          ) : (
            <span className={styles.nowText}>{state.label}</span>
          )}
          <span className={styles.nowAge}>{formatAgo(state.since)}</span>
          {refinement}
        </div>
      )}
    </div>
  );
}
