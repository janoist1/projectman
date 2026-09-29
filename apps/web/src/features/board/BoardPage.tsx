import clsx from 'clsx';
import { useMemo, useState } from 'react';
import { Outlet, useMatch } from 'react-router';
import type { BoardColumnView } from '@projectman/shared';
import { useProject } from '../../app/contexts';
import { SegmentedControl } from '../../components/SegmentedControl';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { t } from '../../i18n/t';
import { useDocumentTitle, useIsMobile } from '../../lib/hooks';
import { columnKind } from '../../lib/pipeline';
import type { PipelineIndex } from '../../lib/pipeline';
import { matchesFilter } from '../../lib/taskState';
import type { BoardFilter, TaskPhase } from '../../lib/taskState';
import { matchesSearch } from './cardModel';
import { MobileBoardList } from './MobileBoardList';
import { TaskCard } from './TaskCard';
import { TeamStrip } from './TeamStrip';
import { sortEntries, useBoardModel } from './useBoardModel';
import type { BoardEntry } from './useBoardModel';
import styles from './BoardPage.module.css';

const inProgress: ReadonlySet<TaskPhase> = new Set(['needs_you', 'working', 'waiting', 'blocked']);

function Column({
  column,
  entries,
  pipeline,
  projectKey,
  selectedKey,
}: {
  column: BoardColumnView;
  entries: BoardEntry[];
  pipeline: PipelineIndex;
  projectKey: string;
  selectedKey: string | null;
}) {
  const kind = columnKind(pipeline, column);
  const headingId = `col-${column.id}`;
  return (
    <section
      className={clsx(styles.column, kind === 'done' && styles.columnDone)}
      aria-labelledby={headingId}
    >
      <div className={styles.columnHead}>
        <div className={styles.columnTitle}>
          <span className={styles.columnDot} data-stage-kind={kind} aria-hidden="true" />
          <h2 id={headingId} className={styles.columnName}>
            {column.name}
          </h2>
          <span className={styles.columnCount} aria-label={t('board.columnCount', { count: entries.length })}>
            {entries.length}
          </span>
        </div>
        {column.hint ? <span className={styles.columnHint}>{column.hint}</span> : null}
      </div>
      <div className={styles.cards}>
        {entries.length === 0 ? <p className={styles.columnEmpty}>{t('board.columnEmpty')}</p> : null}
        {entries.map(({ task, state }) => (
          <TaskCard
            key={task.id}
            task={task}
            state={state}
            pipeline={pipeline}
            to={`/p/${projectKey}/tasks/${task.key}`}
            selected={task.key === selectedKey}
          />
        ))}
      </div>
    </section>
  );
}

/** "Folyamat": the pipeline board; the task drawer renders through the nested route. */
export function BoardPage() {
  const { key, search } = useProject();
  const isMobile = useIsMobile();
  const { board, inbox, pipeline, model } = useBoardModel();
  const [filter, setFilter] = useState<BoardFilter>('all');
  const selected = useMatch('/p/:projectKey/tasks/:taskKey')?.params.taskKey ?? null;
  useDocumentTitle(t('board.title'), board.data?.project.name);

  const searched = useMemo(
    () => (model ? model.entries.filter((entry) => matchesSearch(entry.task, search)) : []),
    [model, search],
  );
  const visible = useMemo(
    () => searched.filter((entry) => matchesFilter(entry.state.phase, filter)),
    [searched, filter],
  );

  if (board.isPending) return <LoadingState />;
  if (board.isError) return <ErrorState error={board.error} onRetry={() => void board.refetch()} />;
  if (!model || !pipeline) return <LoadingState />;

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
              />
            );
          })}
        </div>
      )}
      <Outlet />
    </div>
  );
}
