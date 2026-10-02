import clsx from 'clsx';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useMatch, useNavigate } from 'react-router';
import type { DragEvent, KeyboardEvent } from 'react';
import { isChronologicalColumn, placeInOrder, placementAt, subtasksMovingAlong } from '@projectman/shared';
import type { BoardColumnView, BoardPlacement, LabelView, Task } from '@projectman/shared';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { t } from '../../i18n/t';
import { useDocumentTitle, useIsMobile } from '../../lib/hooks';
import type { MemberIndex } from '../../lib/members';
import type { PipelineIndex } from '../../lib/pipeline';
import type { TaskPhase } from '../../lib/taskState';
import { dragHasFiles } from '../../lib/attachmentInput';
import { useCanAttach, useUploadQueue, useUploadingCounts } from './attachmentUploads';
import { DesktopFilters, FilterChips, PhoneFilters } from './BoardFilterControls';
import { coverSrcOf } from './cardModel';
import { useDoneFold } from './doneFold';
import { useFileDrop } from './useFileDrop';
import { useBoardFilters } from './useBoardFilters';
import { MobileBoardList } from './MobileBoardList';
import { TaskCard } from './TaskCard';
import { TeamStrip } from './TeamStrip';
import { ThemeStrip } from './ThemeStrip';
import { sortColumnEntries, useBoardModel } from './useBoardModel';
import type { BoardEntry } from './useBoardModel';
import { ApiError } from '../../api/client';
import { useBoardMove, useLabels } from '../../api/queries';
import { useToast } from '../../components/toastContext';
import { isApprovalRequested } from '../../lib/errors';
import { PrerequisiteWarning } from './PrerequisiteWarning';
import { groupMoveToast, groupOutcome } from './groupMove';
import { canMoveTask, dropStage, moveErrorText, prerequisitesToWarnAbout } from './moveTask';
import styles from './BoardPage.module.css';

const inProgress: ReadonlySet<TaskPhase> = new Set(['needs_you', 'working', 'waiting', 'blocked']);

/** How long a card that has just landed is marked. */
const LANDED_MS = 900;
/** How long a card of a group move that stayed behind is marked. */
const HELD_MS = 2400;
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
  /** The name of the column, for what is told once the move is done. */
  columnName: string;
  /** The subtasks of the card's column that go along with it (PM-121); empty: the card moves alone. */
  groupKeys: readonly string[];
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
  /** The cards of the pending drop: the card and the subtasks that go along with it. */
  pendingKeys: ReadonlySet<string>;
  /** The pending drop changes the card's column (a reorder within one is told by the dimming alone). */
  pendingMoves: boolean;
  draggedKey: string | null;
  /** The column the dragged card stands in. */
  draggedColumn: string | null;
  hover: DragHover | null;
  /** The subtasks that would go along with the held card over the column it is held over (PM-121). */
  goingAlong: ReadonlySet<string>;
  /** The cards that have just landed on their place. */
  landedKeys: ReadonlySet<string>;
  /** The cards of a group move that stayed where they were. */
  heldKeys: ReadonlySet<string>;
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
  searching,
  members,
  myHandle,
}: {
  /** A filter or a search narrows the board: only then does an empty column say so. */
  filtered: boolean;
  /** A search shows every finished card; without one the finished column shows its newest few. */
  searching: boolean;
  members: MemberIndex;
  myHandle: string | null;
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
  // The finished column is the one with a stage of the done kind, not the one named "Kész".
  const finishes = pipeline.stages.some(
    (stage) => stage.kind === 'done' && pipeline.columnOfStage.get(stage.id)?.id === column.id,
  );
  const done = useDoneFold(
    finishes ? entries.filter((entry) => entry.state.phase === 'done') : [],
    searching,
  );
  const shown = finishes
    ? [...entries.filter((entry) => entry.state.phase !== 'done'), ...done.shown]
    : entries;
  const chronological = isChronologicalColumn(pipeline.stages, column.id);
  const hovered = drag.hover?.columnId === column.id;
  // Another column's card is held over this one: the column takes it by its first stage.
  const entering = hovered && drag.draggedColumn !== column.id;
  const lineIndex = hovered && !chronological ? (drag.hover?.index ?? null) : null;
  const targetName =
    pipeline.stages.find((stage) => pipeline.columnOfStage.get(stage.id)?.id === column.id)?.name ??
    column.name;
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
          {drag.goingAlong.size > 0
            ? t('board.dropHereWithSubtasks', { stage: targetName, count: drag.goingAlong.size })
            : t('task.move.dropTarget', { stage: targetName })}
        </p>
      ) : null}
      <div className={styles.cards} data-cards>
        {entries.length === 0 && filtered ? (
          <p className={styles.columnEmpty}>{t('board.columnEmpty')}</p>
        ) : null}
        {shown.map(({ task, state }, position) => {
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
                members={members}
                myHandle={myHandle}
                uploading={uploadingCounts.get(task.key) ?? 0}
                drag={drag}
              />
            </Fragment>
          );
        })}
        {lineLast(lineIndex, place) ? line(entries.length === 0 ? 'start' : 'end') : null}
        {done.toggle}
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
  members,
  myHandle,
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
  members: MemberIndex;
  myHandle: string | null;
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
      aria-busy={drag.pendingKeys.has(task.key)}
      className={clsx(
        drag.pendingKeys.has(task.key) && styles.pending,
        drag.draggedKey === task.key && styles.dragging,
        drag.goingAlong.has(task.key) && styles.alongMark,
        drag.landedKeys.has(task.key) && styles.landed,
        drag.heldKeys.has(task.key) && styles.held,
      )}
      {...fileDrop.props}
    >
      {drag.goingAlong.has(task.key) ? (
        <span className={styles.alongBadge} aria-hidden="true">
          {t('board.goesAlong')}
        </span>
      ) : null}
      {drag.pendingKey === task.key && drag.pendingMoves ? (
        <p role="status">{t('task.move.pending')}</p>
      ) : null}
      <TaskCard
        reorderHelpId={drag.allowed ? HELP_ID : undefined}
        task={task}
        subtasks={subtasks}
        state={state}
        pipeline={pipeline}
        to={`/p/${projectKey}/tasks/${task.key}`}
        selected={selected}
        labels={labels}
        members={members}
        myHandle={myHandle}
        coverSrc={coverSrcOf(projectKey, task)}
        uploading={uploading}
        fileState={fileDrop.state}
      />
    </div>
  );
}

/** "Folyamat": the pipeline board; the task drawer renders through the nested route. */
export function BoardPage() {
  const { key, myHandle, search, can, setThemeFilter, openNewTask } = useProject();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { board, pipeline, model } = useBoardModel();
  const move = useBoardMove(key);
  const toast = useToast();
  const [dragged, setDragged] = useState<Task | null>(null);
  const [hover, setHover] = useState<DragHover | null>(null);
  const [pending, setPending] = useState<BoardDrop | null>(null);
  const [landed, setLanded] = useState<readonly string[]>([]);
  const [held, setHeld] = useState<readonly string[]>([]);
  // What a screen reader hears after a keyboard move.
  const [announcement, setAnnouncement] = useState('');
  // The card whose link had the focus when it was moved by keyboard: it keeps the focus in its new place.
  const refocus = useRef<string | null>(null);
  // A drop that waits for the person to accept the open prerequisites (PM-204).
  const [warning, setWarning] = useState<{
    drop: BoardDrop;
    keys: string[];
    /** A group move: the cards that would wait, each with its open prerequisites. */
    rows?: { key: string; prerequisites: string[] }[];
  } | null>(null);
  const selected = useMatch('/p/:projectKey/tasks/:taskKey')?.params.taskKey ?? null;
  const uploadingCounts = useUploadingCounts();
  // A file from outside is dragged over the board: over a card, or not (then it says where to drop it).
  const [fileDrag, setFileDrag] = useState<'card' | 'board' | null>(null);
  const fileDepth = useRef(0);
  useDocumentTitle(t('board.title'), board.data?.project.name);

  const optimisticEntries = useMemo(
    () =>
      model?.entries.map((entry) =>
        // A group stays where it is until the server says which of its cards moved.
        pending?.taskKey === entry.task.key && pending.groupKeys.length === 0
          ? { ...entry, task: { ...entry.task, stageId: pending.stageId } }
          : entry,
      ) ?? [],
    [model, pending],
  );
  // What the search, the theme and the state, member and label filters leave of the board (PM-120).
  const view = useBoardFilters({ entries: optimisticEntries, model, board: board.data });
  const { visible, activeTheme, counts } = view;

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
      const moving =
        pending && pending.groupKeys.length === 0
          ? entries.find((entry) => entry.task.key === pending.taskKey)
          : undefined;
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
    if (landed.length === 0) return;
    const timer = setTimeout(() => setLanded([]), LANDED_MS);
    return () => clearTimeout(timer);
  }, [landed]);
  useEffect(() => {
    if (held.length === 0) return;
    const timer = setTimeout(() => setHeld([]), HELD_MS);
    return () => clearTimeout(timer);
  }, [held]);

  // A card moved by keyboard keeps the focus: the browser drops it when the element changes its place.
  useLayoutEffect(() => {
    if (!refocus.current) return;
    const link = document.querySelector<HTMLElement>(`[data-card-key="${refocus.current}"] a`);
    if (link && document.activeElement !== link) link.focus();
    if (!pending) refocus.current = null;
  });

  /** Sets the live region; it is emptied first, or a text said twice in a row would not be read twice. */
  const announce = (text: string) => {
    setAnnouncement('');
    setTimeout(() => setAnnouncement(text), 0);
  };

  /** `told` is said to a screen reader once the move went through. */
  const runMove = (drop: BoardDrop, told?: string) => {
    setPending(drop);
    move.mutate(
      {
        taskKey: drop.taskKey,
        columnId: drop.columnId,
        fromStageId: drop.fromStageId,
        placement: drop.placement,
        ...(drop.despitePrerequisites ? { despitePrerequisites: true } : {}),
        ...(drop.groupKeys.length > 0 ? { withSubtasks: true } : {}),
      },
      {
        onSuccess: (result) => {
          // A group move tells each card's own result in one toast, and takes none of them back.
          if (result.group) {
            const { moved, held: stayed } = groupOutcome(result);
            setLanded(moved);
            setHeld(stayed.map((item) => item.taskKey));
            const summary = groupMoveToast({
              result,
              parentKey: drop.taskKey,
              columnName: drop.columnName,
              projectKey: key,
              labels: board.data?.labels ?? [],
            });
            toast.show(summary.message, summary.tone, { items: summary.items, sticky: summary.sticky });
            return;
          }
          if (result.outcome === 'unchanged') return;
          setLanded([drop.taskKey]);
          if (told) announce(told);
          // Within a column the card landing says it; changing the column is said too (and may start work).
          if (result.outcome === 'moved') toast.show(t('task.move.success'));
        },
        // A stale board is no failure: the refetch after it already shows the new order.
        onError: (error) =>
          toast.show(
            moveErrorText(error, board.data?.labels ?? []),
            isApprovalRequested(error) || (error instanceof ApiError && error.code === 'board_stale')
              ? 'info'
              : 'error',
          ),
        onSettled: () => setPending(null),
      },
    );
  };

  if (board.isPending) return <LoadingState />;
  if (board.isError) return <ErrorState error={board.error} onRetry={() => void board.refetch()} />;
  if (!model || !pipeline) return <LoadingState />;

  const columnOf = (task: Task) => pipeline.columnOfStage.get(task.stageId)?.id ?? null;
  // The subtasks of a collecting card that stand in its column: they go along when it changes column
  // (all of them, the ones a filter hides too).
  const alongOf = (task: Task): Task[] =>
    subtasksMovingAlong(pipeline.stages, task, model.subtasksByParent.get(task.key) ?? []);
  const dropOf = (task: Task, column: BoardColumnView, placement: BoardPlacement): BoardDrop | null => {
    // A card of another column enters the column's first stage; within the column it keeps its own.
    const own = columnOf(task) === column.id;
    const stageId = own ? task.stageId : dropStage(task, column, pipeline);
    return stageId
      ? {
          taskKey: task.key,
          columnId: column.id,
          fromStageId: task.stageId,
          stageId,
          placement,
          columnName: column.name,
          groupKeys: own ? [] : alongOf(task).map((subtask) => subtask.key),
        }
      : null;
  };
  // A card that would start with an open prerequisite asks first (PM-204); a group asks once for all of its cards.
  const startDrop = (drop: BoardDrop, task: Task) => {
    if (drop.stageId === drop.fromStageId) {
      runMove(drop);
      return;
    }
    const tasks = board.data?.tasks ?? [];
    const rows = [task, ...alongOf(task)]
      .map((card) => ({
        key: card.key,
        prerequisites: prerequisitesToWarnAbout(card, drop.stageId, pipeline, tasks),
      }))
      .filter((row) => row.prerequisites.length > 0);
    if (rows.length === 0) runMove(drop);
    else if (drop.groupKeys.length === 0) setWarning({ drop, keys: rows[0]!.prerequisites });
    else
      setWarning({
        drop,
        keys: [...new Set(rows.flatMap((row) => row.prerequisites))],
        rows,
      });
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

  const draggedColumn = dragged ? columnOf(dragged) : null;
  const drag: ColumnDrag = {
    allowed: can.createTasks && !isMobile,
    pendingKey: pending?.taskKey ?? null,
    pendingKeys: new Set(pending ? [pending.taskKey, ...pending.groupKeys] : []),
    pendingMoves: !!pending && pending.stageId !== pending.fromStageId,
    draggedKey: dragged?.key ?? null,
    draggedColumn,
    hover,
    // Only over another column the card is taken to: within its own column nothing goes along.
    goingAlong: new Set(
      dragged && hover && hover.columnId !== draggedColumn ? alongOf(dragged).map((card) => card.key) : [],
    ),
    landedKeys: new Set(landed),
    heldKeys: new Set(held),
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
        announce(t('board.reorder.doneFixed'));
        return;
      }
      if (!canMoveTask(task, true)) return;
      const keys = orderedKeys(column.id);
      const at = keys.indexOf(task.key) + (event.key === 'ArrowUp' ? -1 : 1);
      if (at < 0 || at >= keys.length) {
        announce(t(at < 0 ? 'board.reorder.atTop' : 'board.reorder.atBottom'));
        return;
      }
      const placement = placementAt(keys, task.key, at);
      const drop = placement ? dropOf(task, column, placement) : null;
      if (!drop) return;
      refocus.current = task.key;
      setAnnouncement('');
      runMove(drop, t('board.reorder.moved', { column: column.name, position: at + 1, key: task.key }));
    },
  };

  const activeCount = model.entries.filter((entry) => inProgress.has(entry.state.phase)).length;
  const total = model.entries.filter((entry) => entry.state.phase !== 'cancelled').length;
  const filters = isMobile ? <PhoneFilters view={view} /> : <DesktopFilters view={view} />;

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
            : view.values.length > 0
              ? t('board.subtitleFiltered', { values: view.values.join(', '), count: counts.all })
              : t('board.subtitle', { count: total, active: activeCount })
        }
      >
        {filters}
      </PageHeader>
      {isMobile ? <FilterChips view={view} /> : null}
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
      ) : search && view.searched.length === 0 ? (
        <div className={styles.emptyWrap}>
          <EmptyState icon="search" title={t('board.noResults', { query: search })} />
        </div>
      ) : visible.length === 0 && view.narrowing ? (
        <div className={styles.emptyWrap}>
          <EmptyState
            icon="board"
            title={t('board.filteredEmpty')}
            action={
              view.clearable > 0 ? (
                <Button variant="secondary" size="sm" onClick={view.clear}>
                  {t('board.clearFilters')}
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : isMobile ? (
        <MobileBoardList
          subtasksByParent={model.subtasksByParent}
          entries={visible}
          pipeline={pipeline}
          projectKey={key}
          searching={search !== ''}
          members={model.ctx.members}
          myHandle={myHandle}
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
              filtered={view.narrowing}
              searching={search !== ''}
              members={model.ctx.members}
              myHandle={myHandle}
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
        rows={warning?.rows}
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
