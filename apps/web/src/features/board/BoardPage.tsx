import clsx from 'clsx';
import { useMemo, useState } from 'react';
import { Outlet, useMatch } from 'react-router';
import type { DragEvent } from 'react';
import type { BoardColumnView, Task } from '@projectman/shared';
import { useProject } from '../../app/contexts';
import { SegmentedControl } from '../../components/SegmentedControl';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { t } from '../../i18n/t';
import { useDocumentTitle, useIsMobile } from '../../lib/hooks';
import type { PipelineIndex } from '../../lib/pipeline';
import { matchesFilter } from '../../lib/taskState';
import type { BoardFilter, TaskPhase } from '../../lib/taskState';
import { matchesSearch } from './cardModel';
import { MobileBoardList } from './MobileBoardList';
import { TaskCard } from './TaskCard';
import { TeamStrip } from './TeamStrip';
import { sortEntries, useBoardModel } from './useBoardModel';
import type { BoardEntry } from './useBoardModel';
import { useMoveTask } from '../../api/queries';
import { useToast } from '../../components/toastContext';
import { isApprovalRequested } from '../../lib/errors';
import { canMoveTask, dropStage, moveErrorText } from './moveTask';
import styles from './BoardPage.module.css';

const inProgress: ReadonlySet<TaskPhase> = new Set(['needs_you', 'working', 'waiting', 'blocked']);

function Column({
  column,
  entries,
  pipeline,
  projectKey,
  selectedKey,
  drag,
}: {
  column: BoardColumnView;
  entries: BoardEntry[];
  pipeline: PipelineIndex;
  projectKey: string;
  selectedKey: string | null;
  drag: {
    allowed: boolean;
    pendingKey: string | null;
    targetColumn: string | null;
    start: (event: DragEvent, task: Task) => void;
    end: () => void;
    over: (event: DragEvent, column: BoardColumnView) => void;
    leave: (event: DragEvent) => void;
    drop: (event: DragEvent, column: BoardColumnView) => void;
  };
}) {
  const headingId = `col-${column.id}`;
  return (
    <section
      className={clsx(styles.column, drag.targetColumn === column.id && styles.dropTarget)}
      data-column-color={column.color}
      aria-labelledby={headingId}
      onDragOver={(event) => drag.over(event, column)}
      onDragLeave={drag.leave}
      onDrop={(event) => drag.drop(event, column)}
    >
      <div className={styles.columnHead}>
        <div className={styles.columnTitle}>
          <span className={styles.columnDot} aria-hidden="true" />
          <h2 id={headingId} className={styles.columnName}>
            {column.name}
          </h2>
          <span className={styles.columnCount} aria-label={t('board.columnCount', { count: entries.length })}>
            {entries.length}
          </span>
        </div>
        {column.hint ? <span className={styles.columnHint}>{column.hint}</span> : null}
      </div>
      {drag.targetColumn === column.id ? (
        <p role="status">
          {t('task.move.dropTarget', {
            stage:
              pipeline.stages.find((stage) => pipeline.columnOfStage.get(stage.id)?.id === column.id)?.name ??
              column.name,
          })}
        </p>
      ) : null}
      <div className={styles.cards}>
        {entries.length === 0 ? <p className={styles.columnEmpty}>{t('board.columnEmpty')}</p> : null}
        {entries.map(({ task, state }) => (
          <div
            key={task.id}
            draggable={canMoveTask(task, drag.allowed) && !drag.pendingKey}
            onDragStart={(event) => drag.start(event, task)}
            onDragEnd={drag.end}
            aria-busy={drag.pendingKey === task.key}
            className={drag.pendingKey === task.key ? styles.pending : undefined}
          >
            {drag.pendingKey === task.key ? <p role="status">{t('task.move.pending')}</p> : null}
            <TaskCard
              task={task}
              state={state}
              pipeline={pipeline}
              to={`/p/${projectKey}/tasks/${task.key}`}
              selected={task.key === selectedKey}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

/** "Folyamat": the pipeline board; the task drawer renders through the nested route. */
export function BoardPage() {
  const { key, search, can, myHandle } = useProject();
  const isMobile = useIsMobile();
  const { board, inbox, pipeline, model, members } = useBoardModel();
  const move = useMoveTask(key);
  const toast = useToast();
  const [dragged, setDragged] = useState<Task | null>(null);
  const [targetColumn, setTargetColumn] = useState<string | null>(null);
  const [pending, setPending] = useState<{ taskKey: string; stageId: string } | null>(null);
  const [filter, setFilter] = useState<BoardFilter>('all');
  const selected = useMatch('/p/:projectKey/tasks/:taskKey')?.params.taskKey ?? null;
  useDocumentTitle(t('board.title'), board.data?.project.name);

  const optimisticEntries = useMemo(
    () =>
      model?.entries.map((entry) =>
        pending?.taskKey === entry.task.key
          ? { ...entry, task: { ...entry.task, stageId: pending.stageId } }
          : entry,
      ) ?? [],
    [model, pending],
  );
  const searched = useMemo(
    () => optimisticEntries.filter((entry) => matchesSearch(entry.task, search)),
    [optimisticEntries, search],
  );
  const visible = useMemo(
    () => searched.filter((entry) => matchesFilter(entry.state.phase, filter)),
    [searched, filter],
  );

  if (board.isPending) return <LoadingState />;
  if (board.isError) return <ErrorState error={board.error} onRetry={() => void board.refetch()} />;
  if (!model || !pipeline) return <LoadingState />;

  const drag = {
    allowed: can.createTasks && !isMobile,
    pendingKey: pending?.taskKey ?? null,
    targetColumn,
    start: (event: DragEvent, task: Task) => {
      if (!canMoveTask(task, can.createTasks) || isMobile || pending) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.setData('application/x-projectman-task', task.key);
      event.dataTransfer.effectAllowed = 'move';
      setDragged(task);
    },
    end: () => {
      setDragged(null);
      setTargetColumn(null);
    },
    over: (event: DragEvent, column: BoardColumnView) => {
      if (!dragged || !can.createTasks || isMobile || pending || !dropStage(dragged, column, pipeline))
        return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      setTargetColumn(column.id);
    },
    leave: (event: DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setTargetColumn(null);
    },
    drop: (event: DragEvent, column: BoardColumnView) => {
      event.preventDefault();
      setTargetColumn(null);
      setDragged(null);
      if (!dragged || !canMoveTask(dragged, can.createTasks) || isMobile || pending) return;
      const stageId = dropStage(dragged, column, pipeline);
      if (!stageId) return;
      const variables = { taskKey: dragged.key, stageId };
      setPending(variables);
      move.mutate(variables, {
        onSuccess: () => toast.show(t('task.move.success')),
        onError: (error) =>
          toast.show(moveErrorText(error, members, myHandle), isApprovalRequested(error) ? 'info' : 'error'),
        onSettled: () => setPending(null),
      });
    },
  };

  const counts = {
    all: searched.filter((entry) => matchesFilter(entry.state.phase, 'all')).length,
    needsYou: searched.filter((entry) => matchesFilter(entry.state.phase, 'needsYou')).length,
    waiting: searched.filter((entry) => matchesFilter(entry.state.phase, 'waiting')).length,
  };
  const activeCount = model.entries.filter((entry) => inProgress.has(entry.state.phase)).length;
  const total = model.entries.filter((entry) => entry.state.phase !== 'cancelled').length;

  const filters = (
    <SegmentedControl<BoardFilter>
      label={t('board.filtersLabel')}
      value={filter}
      onChange={setFilter}
      size={isMobile ? 'sm' : 'md'}
      options={[
        { value: 'all', label: t('board.filters.all'), count: counts.all },
        { value: 'needsYou', label: t('board.filters.needsYou'), count: counts.needsYou },
        { value: 'waiting', label: t('board.filters.waiting'), count: counts.waiting },
      ]}
    />
  );

  return (
    <div className={styles.page}>
      {isMobile ? null : (
        <TeamStrip members={board.data.members} inbox={inbox.data?.items} activeTaskCount={activeCount} />
      )}
      <div className={styles.header}>
        <div className={styles.titles}>
          <h1 className={styles.title}>{t('board.title')}</h1>
          <span className={styles.subtitle}>
            {t('board.subtitle', { count: total, active: activeCount })}
          </span>
        </div>
        <span className={styles.spacer} />
        {filters}
      </div>
      {total === 0 ? (
        <div className={styles.emptyWrap}>
          <EmptyState icon="board" title={t('board.noTasks')} />
        </div>
      ) : search && searched.length === 0 ? (
        <div className={styles.emptyWrap}>
          <EmptyState icon="search" title={t('board.noResults', { query: search })} />
        </div>
      ) : isMobile ? (
        <MobileBoardList entries={visible} pipeline={pipeline} projectKey={key} />
      ) : (
        <div className={styles.columns}>
          {pipeline.columns.map((column) => {
            const ids = new Set(column.stageIds);
            const entries = sortEntries(
              visible.filter(
                (entry) =>
                  ids.has(entry.task.stageId) ||
                  pipeline.columnOfStage.get(entry.task.stageId)?.id === column.id,
              ),
            );
            return (
              <Column
                key={column.id}
                column={column}
                entries={entries}
                pipeline={pipeline}
                projectKey={key}
                selectedKey={selected}
                drag={drag}
              />
            );
          })}
        </div>
      )}
      <Outlet />
    </div>
  );
}
