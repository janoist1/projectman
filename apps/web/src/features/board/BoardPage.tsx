import clsx from 'clsx';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useMatch, useNavigate } from 'react-router';
import type { DragEvent, KeyboardEvent } from 'react';
import { isChronologicalColumn, placeInOrder, placementAt } from '@projectman/shared';
import type { BoardColumnView, BoardPlacement, LabelView, Task } from '@projectman/shared';
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
import { sortColumnEntries, useBoardModel } from './useBoardModel';
import type { BoardEntry } from './useBoardModel';
import { useBoardMove, useLabels } from '../../api/queries';
import { useToast } from '../../components/toastContext';
import { isApprovalRequested } from '../../lib/errors';
import { PrerequisiteWarning } from './PrerequisiteWarning';
import { canMoveTask, dropStage, moveErrorText, prerequisitesToWarnAbout } from './moveTask';
import styles from './BoardPage.module.css';

const inProgress: ReadonlySet<TaskPhase> = new Set(['needs_you', 'working', 'waiting', 'blocked']);

/** How long a card that has just landed is marked. */
const LANDED_MS = 900;
/** A dragged card within this many pixels of a column's top or bottom scrolls the column. */
const SCROLL_EDGE = 40;
const HELP_ID = 'board-reorder-help';

/** A card dropped on the board: a place in a column. `stageId` is the stage it will stand in. */
interface BoardDrop {
  taskKey: string;
  columnId: string;
  fromStageId: string;
  stageId: string;
  placement: BoardPlacement;
  despitePrerequisites?: boolean;
}

/** Where the dragged card is held: over which column, and at which place among the column's other cards. */
interface DragHover {
  columnId: string;
  /** Null: no line (the card would stay where it is, or the column is ordered by time). */
  index: number | null;
}

/** Moving a card by dragging it: between columns, and to a place in a column. */
interface ColumnDrag {
  allowed: boolean;
  pendingKey: string | null;
  draggedKey: string | null;
  /** The column the dragged card stands in. */
  draggedColumn: string | null;
  hover: DragHover | null;
  /** The card that has just landed on its place. */
  landedKey: string | null;
  start: (event: DragEvent, task: Task) => void;
  end: () => void;
  over: (event: DragEvent, column: BoardColumnView) => void;
  leave: (event: DragEvent) => void;
  drop: (event: DragEvent, column: BoardColumnView) => void;
  keyDown: (event: KeyboardEvent, task: Task) => void;
}

/** Where a card dropped at `clientY` lands among the cards of a column, the dragged card not counted. */
function dropIndexAt(column: HTMLElement, clientY: number, draggedKey: string): number {
  let index = 0;
  for (const card of Array.from(column.querySelectorAll<HTMLElement>('[data-card-key]'))) {
    if (card.dataset.cardKey === draggedKey) continue;
    const box = card.getBoundingClientRect();
    if (clientY > box.top + box.height / 2) index += 1;
  }
  return index;
}

/** A column near its edge scrolls while a card is held there. */
function scrollNearEdge(column: HTMLElement, clientY: number) {
  const cards = column.querySelector<HTMLElement>('[data-cards]');
  if (!cards) return;
  const box = cards.getBoundingClientRect();
  if (clientY < box.top + SCROLL_EDGE) cards.scrollTop -= 14;
  else if (clientY > box.bottom - SCROLL_EDGE) cards.scrollTop += 14;
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
  const chronological = isChronologicalColumn(pipeline.stages, column.id);
  const hovered = drag.hover?.columnId === column.id;
  // Another column's card is held over this one: the column takes it by its first stage.
  const entering = hovered && drag.draggedColumn !== column.id;
  const lineIndex = hovered && !chronological ? (drag.hover?.index ?? null) : null;
  // The line stands before the card that would follow the dragged one, so the dragged card is not counted.
  let place = 0;
  const line = (edge?: 'start' | 'end') => (
    <div className={styles.dropLine} data-edge={edge} aria-hidden="true" />
  );
  return (
    <section
      className={clsx(styles.column, entering && styles.dropTarget)}
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
          {chronological ? <span className={styles.columnOrder}>{t('board.doneChronological')}</span> : null}
        </div>
        {column.hint ? <span className={styles.columnHint}>{column.hint}</span> : null}
      </div>
      {entering ? (
        <p role="status" className={styles.dropTargetRow}>
          {t('task.move.dropTarget', {
            stage:
              pipeline.stages.find((stage) => pipeline.columnOfStage.get(stage.id)?.id === column.id)?.name ??
              column.name,
          })}
        </p>
      ) : null}
      <div className={styles.cards} data-cards>
        {entries.length === 0 && filtered ? (
          <p className={styles.columnEmpty}>{t('board.columnEmpty')}</p>
        ) : null}
        {entries.map(({ task, state }, position) => {
          const isDragged = task.key === drag.draggedKey;
          const before = !isDragged && lineIndex === place;
          if (!isDragged) place += 1;
          return (
            <Fragment key={task.id}>
              {before ? line(position === 0 ? 'start' : undefined) : null}
              <BoardCard
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
            </Fragment>
          );
        })}
        {lineLast(lineIndex, place) ? line(entries.length === 0 ? 'start' : 'end') : null}
      </div>
    </section>
  );
}

/** The line after the last card: the dragged card would be the column's last. */
function lineLast(lineIndex: number | null, cards: number): boolean {
  return lineIndex !== null && lineIndex >= cards;
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
  const movable = canMoveTask(task, drag.allowed);
  return (
    <div
      data-card-key={task.key}
      draggable={movable && !drag.pendingKey}
      onDragStart={(event) => drag.start(event, task)}
      onDragEnd={drag.end}
      onKeyDown={(event) => drag.keyDown(event, task)}
      aria-busy={drag.pendingKey === task.key}
      className={clsx(
        drag.pendingKey === task.key && styles.pending,
        drag.draggedKey === task.key && styles.dragging,
        drag.landedKey === task.key && styles.landed,
      )}
      {...fileDrop.props}
    >
      {drag.pendingKey === task.key ? <p role="status">{t('task.move.pending')}</p> : null}
      <TaskCard
        reorderHelpId={drag.allowed ? HELP_ID : undefined}
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
  const { board, pipeline, model } = useBoardModel();
  const move = useBoardMove(key);
  const toast = useToast();
  const [dragged, setDragged] = useState<Task | null>(null);
  const [hover, setHover] = useState<DragHover | null>(null);
  const [pending, setPending] = useState<BoardDrop | null>(null);
  const [landedKey, setLandedKey] = useState<string | null>(null);
  // What a screen reader hears after a keyboard move.
  const [announcement, setAnnouncement] = useState('');
  // The card whose link had the focus when it was moved by keyboard: it keeps the focus in its new place.
  const refocus = useRef<string | null>(null);
  // A drop that waits for the person to accept the open prerequisites (PM-204).
  const [warning, setWarning] = useState<{ drop: BoardDrop; keys: string[] } | null>(null);
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

  // Every column's cards in the order shown: the stored order, the card on its way already in its new place.
  const columnOrder = useMemo(() => {
    const order = new Map<string, BoardEntry[]>();
    if (!pipeline) return order;
    for (const column of pipeline.columns) {
      const chronological = isChronologicalColumn(pipeline.stages, column.id);
      let entries = sortColumnEntries(
        visible.filter((entry) => pipeline.columnOfStage.get(entry.task.stageId)?.id === column.id),
        chronological,
      );
      const moving = pending ? entries.find((entry) => entry.task.key === pending.taskKey) : undefined;
      if (pending && moving) {
        if (chronological) entries = [moving, ...entries.filter((entry) => entry !== moving)];
        else {
          const byKey = new Map(entries.map((entry) => [entry.task.key, entry]));
          const keys = placeInOrder(
            entries.map((entry) => entry.task.key),
            pending.taskKey,
            pending.placement,
          );
          if (keys) entries = keys.flatMap((key) => byKey.get(key) ?? []);
        }
      }
      order.set(column.id, entries);
    }
    return order;
  }, [visible, pipeline, pending]);
  const orderedKeys = (columnId: string) => (columnOrder.get(columnId) ?? []).map((entry) => entry.task.key);

  useEffect(() => {
    if (!landedKey) return;
    const timer = setTimeout(() => setLandedKey(null), LANDED_MS);
    return () => clearTimeout(timer);
  }, [landedKey]);

  // A card moved by keyboard keeps the focus: the browser drops it when the element changes its place.
  useLayoutEffect(() => {
    if (!refocus.current) return;
    const link = document.querySelector<HTMLElement>(`[data-card-key="${refocus.current}"] a`);
    if (link && document.activeElement !== link) link.focus();
    if (!pending) refocus.current = null;
  });

  const runMove = (drop: BoardDrop) => {
    setPending(drop);
    move.mutate(
      {
        taskKey: drop.taskKey,
        columnId: drop.columnId,
        fromStageId: drop.fromStageId,
        placement: drop.placement,
        ...(drop.despitePrerequisites ? { despitePrerequisites: true } : {}),
      },
      {
        onSuccess: (result) => {
          if (result.outcome === 'unchanged') return;
          setLandedKey(drop.taskKey);
          // Within a column the card landing says it; changing the column is said too (and may start work).
          if (result.outcome === 'moved') toast.show(t('task.move.success'));
        },
        onError: (error) =>
          toast.show(
            moveErrorText(error, board.data?.labels ?? []),
            isApprovalRequested(error) ? 'info' : 'error',
          ),
        onSettled: () => setPending(null),
      },
    );
  };

  if (board.isPending) return <LoadingState />;
  if (board.isError) return <ErrorState error={board.error} onRetry={() => void board.refetch()} />;
  if (!model || !pipeline) return <LoadingState />;

  const columnOf = (task: Task) => pipeline.columnOfStage.get(task.stageId)?.id ?? null;
  const dropOf = (task: Task, column: BoardColumnView, placement: BoardPlacement): BoardDrop | null => {
    // A card of another column enters the column's first stage; within the column it keeps its own.
    const stageId = columnOf(task) === column.id ? task.stageId : dropStage(task, column, pipeline);
    return stageId
      ? { taskKey: task.key, columnId: column.id, fromStageId: task.stageId, stageId, placement }
      : null;
  };
  // A card that would start with an open prerequisite asks first (PM-204).
  const startDrop = (drop: BoardDrop, task: Task) => {
    const open =
      drop.stageId === drop.fromStageId
        ? []
        : prerequisitesToWarnAbout(task, drop.stageId, pipeline, board.data?.tasks ?? []);
    if (open.length > 0) setWarning({ drop, keys: open });
    else runMove(drop);
  };
  /** Where the held card would land over `column` (null: it is not taken there). */
  const hoverOver = (event: DragEvent, task: Task, column: BoardColumnView): DragHover | null => {
    const own = columnOf(task) === column.id;
    const chronological = isChronologicalColumn(pipeline.stages, column.id);
    if (own ? chronological : !dropStage(task, column, pipeline)) return null;
    if (chronological) return { columnId: column.id, index: null };
    const index = dropIndexAt(event.currentTarget as HTMLElement, event.clientY, task.key);
    const stays = own && placementAt(orderedKeys(column.id), task.key, index) === null;
    return { columnId: column.id, index: stays ? null : index };
  };

  const drag: ColumnDrag = {
    allowed: can.createTasks && !isMobile,
    pendingKey: pending?.taskKey ?? null,
    draggedKey: dragged?.key ?? null,
    draggedColumn: dragged ? columnOf(dragged) : null,
    hover,
    landedKey,
    start: (event, task) => {
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
      setHover(null);
    },
    over: (event, column) => {
      if (!dragged || !can.createTasks || isMobile || pending) return;
      const next = hoverOver(event, dragged, column);
      if (!next) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      scrollNearEdge(event.currentTarget as HTMLElement, event.clientY);
      setHover((current) =>
        current?.columnId === next.columnId && current.index === next.index ? current : next,
      );
    },
    leave: (event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHover(null);
    },
    drop: (event, column) => {
      event.preventDefault();
      setHover(null);
      setDragged(null);
      if (!dragged || !canMoveTask(dragged, can.createTasks) || isMobile || pending) return;
      const own = columnOf(dragged) === column.id;
      const chronological = isChronologicalColumn(pipeline.stages, column.id);
      if (own && chronological) return;
      // A column of finished work has no order of its own: the card goes to its top, where the newest stands.
      const placement: BoardPlacement | null = chronological
        ? { at: 'top' }
        : (placementAt(
            orderedKeys(column.id),
            dragged.key,
            dropIndexAt(event.currentTarget as HTMLElement, event.clientY, dragged.key),
          ) ?? (own ? null : { at: 'top' }));
      const drop = placement ? dropOf(dragged, column, placement) : null;
      if (drop) startDrop(drop, dragged);
    },
    keyDown: (event, task) => {
      if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
      if (!can.createTasks || isMobile) return;
      event.preventDefault();
      const column = pipeline.columnOfStage.get(task.stageId);
      if (!column || pending) return;
      if (isChronologicalColumn(pipeline.stages, column.id)) {
        setAnnouncement(t('board.reorder.doneFixed'));
        return;
      }
      if (!canMoveTask(task, true)) return;
      const keys = orderedKeys(column.id);
      const at = keys.indexOf(task.key) + (event.key === 'ArrowUp' ? -1 : 1);
      if (at < 0 || at >= keys.length) {
        setAnnouncement(t(at < 0 ? 'board.reorder.atTop' : 'board.reorder.atBottom'));
        return;
      }
      const placement = placementAt(keys, task.key, at);
      const drop = placement ? dropOf(task, column, placement) : null;
      if (!drop) return;
      refocus.current = task.key;
      setAnnouncement(t('board.reorder.moved', { column: column.name, position: at + 1, key: task.key }));
      runMove(drop);
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
        <TeamStrip
          members={board.data.members}
          titles={new Map(board.data.tasks.map((task) => [task.key, task.title]))}
        />
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
          {pipeline.columns.map((column) => (
            <Column
              key={column.id}
              column={column}
              subtasksByParent={model.subtasksByParent}
              entries={columnOrder.get(column.id) ?? []}
              pipeline={pipeline}
              projectKey={key}
              selectedKey={selected}
              drag={drag}
              uploadingCounts={uploadingCounts}
              filtered={filter !== 'all' || search !== '' || activeTheme !== null}
            />
          ))}
        </div>
      )}
      {drag.allowed ? (
        <>
          <p id={HELP_ID} className="visually-hidden">
            {t('board.reorder.help')}
          </p>
          <div className="visually-hidden" role="status" aria-live="polite">
            {announcement}
          </div>
        </>
      ) : null}
      <PrerequisiteWarning
        keys={warning?.keys ?? null}
        tasks={board.data.tasks}
        onConfirm={() => {
          if (warning) runMove({ ...warning.drop, despitePrerequisites: true });
          setWarning(null);
        }}
        onWait={() => {
          if (warning) runMove(warning.drop);
          setWarning(null);
        }}
        onClose={() => setWarning(null)}
      />
      <Outlet />
    </div>
  );
}
