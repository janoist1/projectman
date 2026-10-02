import clsx from 'clsx';
import { useMemo, useRef, useState } from 'react';
import { Outlet, useMatch, useNavigate } from 'react-router';
import type { DragEvent } from 'react';
import type { BoardColumnView, LabelView, Task } from '@projectman/shared';
import { useProject } from '../../app/contexts';
import { Icon } from '../../components/Icon';
import { SegmentedControl } from '../../components/SegmentedControl';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { t } from '../../i18n/t';
import { useDocumentTitle, useIsMobile } from '../../lib/hooks';
import type { PipelineIndex } from '../../lib/pipeline';
import { matchesFilter } from '../../lib/taskState';
import type { BoardFilter, TaskPhase } from '../../lib/taskState';
import { dragHasFiles } from '../../lib/attachmentInput';
import { useCanAttach, useUploadQueue, useUploadingCounts } from './attachmentUploads';
import { coverSrcOf, matchesSearch } from './cardModel';
import { useFileDrop } from './useFileDrop';
import { MobileBoardList } from './MobileBoardList';
import { TaskCard } from './TaskCard';
import { TeamStrip } from './TeamStrip';
import { ThemeStrip } from './ThemeStrip';
import { sortedThemes } from './themeModel';
import { sortEntries, useBoardModel } from './useBoardModel';
import type { BoardEntry } from './useBoardModel';
import { useLabels, useMoveTask } from '../../api/queries';
import { useToast } from '../../components/toastContext';
import { isApprovalRequested } from '../../lib/errors';
import { PrerequisiteWarning } from './PrerequisiteWarning';
import { canMoveTask, dropStage, moveErrorText, prerequisitesToWarnAbout } from './moveTask';
import styles from './BoardPage.module.css';

const inProgress: ReadonlySet<TaskPhase> = new Set(['needs_you', 'working', 'waiting', 'blocked']);

/** Moving a card between columns by dragging it. */
interface ColumnDrag {
  allowed: boolean;
  pendingKey: string | null;
  targetColumn: string | null;
  start: (event: DragEvent, task: Task) => void;
  end: () => void;
  over: (event: DragEvent, column: BoardColumnView) => void;
  leave: (event: DragEvent) => void;
  drop: (event: DragEvent, column: BoardColumnView) => void;
}

function Column({
  column,
  entries,
  subtasksByParent,
  pipeline,
  projectKey,
  selectedKey,
  drag,
  uploadingCounts,
  filtered,
}: {
  /** A filter or a search narrows the board: only then does an empty column say so. */
  filtered: boolean;
  subtasksByParent: Map<string, Task[]>;
  column: BoardColumnView;
  entries: BoardEntry[];
  pipeline: PipelineIndex;
  projectKey: string;
  selectedKey: string | null;
  drag: ColumnDrag;
  /** Files on their way, by task key. */
  uploadingCounts: ReadonlyMap<string, number>;
}) {
  const labels = useLabels(projectKey);
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
        {entries.length === 0 && filtered ? (
          <p className={styles.columnEmpty}>{t('board.columnEmpty')}</p>
        ) : null}
        {entries.map(({ task, state }) => (
          <BoardCard
            key={task.id}
            task={task}
            subtasks={subtasksByParent.get(task.key)}
            state={state}
            pipeline={pipeline}
            projectKey={projectKey}
            selected={task.key === selectedKey}
            labels={labels}
            uploading={uploadingCounts.get(task.key) ?? 0}
            drag={drag}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * A card on the board. It is dragged to move it between columns, and it takes files dragged from
 * outside the page (attached to this card, by the same queue and rules as in the open card). The
 * two never meet: a dragged card carries no files, and a file is never a dragged card.
 */
function BoardCard({
  task,
  subtasks,
  state,
  pipeline,
  projectKey,
  selected,
  labels,
  uploading,
  drag,
}: {
  task: Task;
  subtasks: Task[] | undefined;
  state: BoardEntry['state'];
  pipeline: PipelineIndex;
  projectKey: string;
  selected: boolean;
  labels: readonly LabelView[];
  uploading: number;
  drag: ColumnDrag;
}) {
  const canAttach = useCanAttach();
  const queue = useUploadQueue();
  const fileDrop = useFileDrop({
    allowed: canAttach(task),
    onFiles: (files) => queue.add(task.key, files, { announce: true }),
  });
  return (
    <div
      draggable={canMoveTask(task, drag.allowed) && !drag.pendingKey}
      onDragStart={(event) => drag.start(event, task)}
      onDragEnd={drag.end}
      aria-busy={drag.pendingKey === task.key}
      className={drag.pendingKey === task.key ? styles.pending : undefined}
      {...fileDrop.props}
    >
      {drag.pendingKey === task.key ? <p role="status">{t('task.move.pending')}</p> : null}
      <TaskCard
        task={task}
        subtasks={subtasks}
        state={state}
        pipeline={pipeline}
        to={`/p/${projectKey}/tasks/${task.key}`}
        selected={selected}
        labels={labels}
        coverSrc={coverSrcOf(projectKey, task)}
        uploading={uploading}
        fileState={fileDrop.state}
      />
    </div>
  );
}

/** "Folyamat": the pipeline board; the task drawer renders through the nested route. */
export function BoardPage() {
  const { key, search, can, themeFilter, setThemeFilter, openNewTask } = useProject();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { board, inbox, pipeline, model } = useBoardModel();
  const move = useMoveTask(key);
  const toast = useToast();
  const [dragged, setDragged] = useState<Task | null>(null);
  const [targetColumn, setTargetColumn] = useState<string | null>(null);
  const [pending, setPending] = useState<{ taskKey: string; stageId: string } | null>(null);
  // A drop that waits for the person to accept the open prerequisites (PM-204).
  const [warning, setWarning] = useState<{ taskKey: string; stageId: string; keys: string[] } | null>(null);
  const [filter, setFilter] = useState<BoardFilter>('all');
  const selected = useMatch('/p/:projectKey/tasks/:taskKey')?.params.taskKey ?? null;
  const uploadingCounts = useUploadingCounts();
  // A file from outside is dragged over the board: over a card, or not (then it says where to drop it).
  const [fileDrag, setFileDrag] = useState<'card' | 'board' | null>(null);
  const fileDepth = useRef(0);
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
    () => optimisticEntries.filter((entry) => matchesSearch(entry.task, search, model?.ctx.labels)),
    [optimisticEntries, search, model],
  );
  // The theme filter narrows with the search and the phase filter: a card matches by its computed theme,
  // so the subtasks of a collecting card in the theme are in the list too (PM-192).
  const activeTheme = useMemo(
    () => sortedThemes(board.data?.tasks ?? []).find((theme) => theme.key === themeFilter) ?? null,
    [board.data, themeFilter],
  );
  const themed = useMemo(
    () => (activeTheme ? searched.filter((entry) => entry.task.themeKey === activeTheme.key) : searched),
    [searched, activeTheme],
  );
  const visible = useMemo(
    () => themed.filter((entry) => matchesFilter(entry.state.phase, filter)),
    [themed, filter],
  );

  const runMove = (variables: { taskKey: string; stageId: string; despitePrerequisites?: boolean }) => {
    setPending(variables);
    move.mutate(variables, {
      onSuccess: () => toast.show(t('task.move.success')),
      onError: (error) =>
        toast.show(
          moveErrorText(error, board.data?.labels ?? []),
          isApprovalRequested(error) ? 'info' : 'error',
        ),
      onSettled: () => setPending(null),
    });
  };

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
      // A card that would start with an open prerequisite asks first (PM-204).
      const open = prerequisitesToWarnAbout(dragged, stageId, pipeline, board.data?.tasks ?? []);
      if (open.length > 0) setWarning({ taskKey: dragged.key, stageId, keys: open });
      else runMove({ taskKey: dragged.key, stageId });
    },
  };

  const counts = {
    all: themed.filter((entry) => matchesFilter(entry.state.phase, 'all')).length,
    needsYou: themed.filter((entry) => matchesFilter(entry.state.phase, 'needsYou')).length,
    waiting: themed.filter((entry) => matchesFilter(entry.state.phase, 'waiting')).length,
  };
  const activeCount = model.entries.filter((entry) => inProgress.has(entry.state.phase)).length;
  const total = model.entries.filter((entry) => entry.state.phase !== 'cancelled').length;

  const filters = (
    <SegmentedControl<BoardFilter>
      label={t('board.filtersLabel')}
      value={filter}
      onChange={setFilter}
      size={isMobile ? 'sm' : 'md'}
      className={styles.filters}
      options={[
        { value: 'all', label: t('board.filters.all'), count: counts.all },
        { value: 'needsYou', label: t('board.filters.needsYou'), count: counts.needsYou },
        { value: 'waiting', label: t('board.filters.waiting'), count: counts.waiting },
      ]}
    />
  );

  // A file dropped anywhere but on a card must not open in the browser in place of the board. The
  // cards (and the open card) take a file's drag first; what they did not take is refused here.
  const fileProps = {
    onDragEnter: (event: DragEvent) => {
      if (!dragHasFiles(event.dataTransfer)) return;
      const overCard = event.defaultPrevented;
      event.preventDefault();
      fileDepth.current += 1;
      setFileDrag(overCard ? 'card' : 'board');
    },
    onDragOver: (event: DragEvent) => {
      if (!dragHasFiles(event.dataTransfer)) return;
      const taken = event.defaultPrevented;
      event.preventDefault();
      if (!taken) event.dataTransfer.dropEffect = 'none';
    },
    onDragLeave: (event: DragEvent) => {
      if (!dragHasFiles(event.dataTransfer)) return;
      fileDepth.current = Math.max(0, fileDepth.current - 1);
      if (fileDepth.current === 0) setFileDrag(null);
    },
    onDrop: (event: DragEvent) => {
      if (!dragHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      fileDepth.current = 0;
      setFileDrag(null);
    },
  };

  return (
    <div className={styles.page} {...fileProps}>
      {fileDrag === 'board' ? (
        <p className={styles.fileHint} role="status">
          <Icon name="paperclip" size={15} strokeWidth={2.2} />
          {t('attachments.boardHint')}
        </p>
      ) : null}
      {isMobile ? null : (
        <TeamStrip members={board.data.members} inbox={inbox.data?.items} activeTaskCount={activeCount} />
      )}
      <PageHeader
        className={styles.header}
        hideTitleOnPhone
        title={t('board.title')}
        subtitle={
          isMobile
            ? null
            : activeTheme
              ? t('board.subtitleFiltered', { title: activeTheme.title, count: counts.all })
              : t('board.subtitle', { count: total, active: activeCount })
        }
      >
        {filters}
      </PageHeader>
      <ThemeStrip
        tasks={board.data.tasks}
        active={activeTheme?.key ?? null}
        onFilter={setThemeFilter}
        onOpen={(themeKey) => navigate(`/p/${key}/tasks/${themeKey}`)}
        {...(can.createTasks ? { onNew: () => openNewTask({ kind: 'theme' }) } : {})}
      />
      {total === 0 ? (
        <div className={styles.emptyWrap}>
          <EmptyState icon="board" title={t('board.noTasks')} />
        </div>
      ) : search && searched.length === 0 ? (
        <div className={styles.emptyWrap}>
          <EmptyState icon="search" title={t('board.noResults', { query: search })} />
        </div>
      ) : isMobile ? (
        <MobileBoardList
          subtasksByParent={model.subtasksByParent}
          entries={visible}
          pipeline={pipeline}
          projectKey={key}
          searching={search !== ''}
        />
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
                subtasksByParent={model.subtasksByParent}
                entries={entries}
                pipeline={pipeline}
                projectKey={key}
                selectedKey={selected}
                drag={drag}
                uploadingCounts={uploadingCounts}
                filtered={filter !== 'all' || search !== '' || activeTheme !== null}
              />
            );
          })}
        </div>
      )}
      <PrerequisiteWarning
        keys={warning?.keys ?? null}
        tasks={board.data.tasks}
        onConfirm={() => {
          if (warning)
            runMove({ taskKey: warning.taskKey, stageId: warning.stageId, despitePrerequisites: true });
          setWarning(null);
        }}
        onWait={() => {
          if (warning) runMove({ taskKey: warning.taskKey, stageId: warning.stageId });
          setWarning(null);
        }}
        onClose={() => setWarning(null)}
      />
      <Outlet />
    </div>
  );
}
