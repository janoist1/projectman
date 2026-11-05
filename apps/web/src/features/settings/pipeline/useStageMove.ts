import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import type { Pipeline, ProjectConfig, Stage } from '@projectman/shared';
import { t } from '../../../i18n/t';
import { moveStage, stageMoveStep } from './flow';
import type { ColumnRun, StagePlace } from './flow';
import { moveRefusal } from './move';
import type { PipelineMove } from './useMove';

/** Where a drag hovers: between two stages (on the half of one), or on a box header (the column's first place). */
type Anchor = { kind: 'stage'; id: string; edge: 'before' | 'after' } | { kind: 'head'; run: ColumnRun };

/** A hovered place with the reason the stage cannot go there (null when it can). */
export interface DropMark {
  anchor: Anchor;
  reason: string | null;
}

interface Grab {
  id: string;
  origin: StagePlace;
  dest: StagePlace;
}

const sameplace = (a: StagePlace, b: StagePlace) => a.index === b.index && a.columnId === b.columnId;

const columnName = (pipeline: Pipeline, columnId: string) =>
  pipeline.columns.find((column) => column.id === columnId)?.name ?? columnId;

/** The handle of a stage in the document, when it is drawn. */
const handleOf = (id: string) =>
  [...document.querySelectorAll<HTMLElement>('[data-handle]')].find(
    (element) => element.dataset.handle === id,
  );

interface Options {
  config: ProjectConfig;
  isOwner: boolean;
  mover: PipelineMove;
}

/**
 * Moving a stage on the path: dragging its handle, or the keyboard on the handle (Space grabs, the arrows
 * carry it, Space puts it down and saves, Esc puts it back). Everything before the drop is view state: only
 * the drop saves, once, through `mover`.
 */
export function useStageMove({ config, isOwner, mover }: Options) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [mark, setMark] = useState<DropMark | null>(null);
  const [grab, setGrab] = useState<Grab | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const grabRef = useRef(grab);
  grabRef.current = grab;
  /** The stage whose handle gets the focus back when the path is drawn again and the focus fell off. */
  const focusId = useRef<string | null>(null);
  const markKey = useRef('');
  const markRefused = useRef(false);
  const { pipeline } = config;

  const preview = useMemo(() => (grab ? moveStage(pipeline, grab.id, grab.dest) : null), [pipeline, grab]);
  const grabReason = useMemo(
    () =>
      grab && preview && !sameplace(grab.dest, grab.origin) ? moveRefusal(config, preview, isOwner) : null,
    [config, grab, preview, isOwner],
  );

  // A stage that changes column is drawn in another box, which moves its handle: the focus must stay on it.
  useLayoutEffect(() => {
    const id = focusId.current;
    if (id && (!document.activeElement || document.activeElement === document.body)) handleOf(id)?.focus();
  });

  const nameOf = (id: string) => pipeline.stages.find((stage) => stage.id === id)?.name ?? id;

  const place = (shown: Pipeline, id: string) => {
    const index = shown.stages.findIndex((stage) => stage.id === id);
    return {
      n: index + 1,
      column: columnName(shown, shown.stages[index]?.columnId ?? ''),
    };
  };

  const forbidden = (reason: string) => t('settings.pipeline.move.forbidden', { reason });

  /** The place a hover means for the dragged stage; null when it is the stage's own place. */
  const destOf = (id: string, anchor: Anchor): StagePlace | null => {
    const from = pipeline.stages.findIndex((stage) => stage.id === id);
    if (from < 0) return null;
    let dest: StagePlace;
    if (anchor.kind === 'head') {
      dest = {
        index: anchor.run.start - (from < anchor.run.start ? 1 : 0),
        columnId: anchor.run.column.id,
      };
    } else {
      const over = pipeline.stages.findIndex((stage) => stage.id === anchor.id);
      if (over < 0 || over === from) return null;
      dest = {
        index: over - (from < over ? 1 : 0) + (anchor.edge === 'after' ? 1 : 0),
        columnId: pipeline.stages[over]!.columnId,
      };
    }
    const origin = pipeline.stages[from]!;
    return sameplace(dest, { index: from, columnId: origin.columnId }) ? null : dest;
  };

  const commit = async (id: string, dest: StagePlace) => {
    const moved = moveStage(pipeline, id, dest);
    const saved = await mover.move({ pipeline: moved, name: nameOf(id), stageIds: [id] });
    if (saved)
      setAnnouncement(t('settings.pipeline.move.live.dropped', { name: nameOf(id), ...place(moved, id) }));
  };

  const hover = (event: DragEvent, anchor: Anchor) => {
    if (!dragId) return;
    event.preventDefault();
    const key = anchor.kind === 'head' ? `head:${anchor.run.start}` : `${anchor.id}:${anchor.edge}`;
    if (key !== markKey.current) {
      markKey.current = key;
      const dest = destOf(dragId, anchor);
      const reason = dest ? moveRefusal(config, moveStage(pipeline, dragId, dest), isOwner) : null;
      markRefused.current = reason !== null;
      setMark(dest ? { anchor, reason } : null);
    }
    if (event.dataTransfer) event.dataTransfer.dropEffect = markRefused.current ? 'none' : 'move';
  };

  const clearDrag = () => {
    setDragId(null);
    setMark(null);
    markKey.current = '';
    markRefused.current = false;
  };

  const drop = (event: DragEvent, anchor: Anchor) => {
    if (!dragId) return;
    event.preventDefault();
    const id = dragId;
    const dest = destOf(id, anchor);
    const reason = dest ? moveRefusal(config, moveStage(pipeline, id, dest), isOwner) : null;
    clearDrag();
    if (!dest) return;
    if (reason) setAnnouncement(forbidden(reason));
    else void commit(id, dest);
  };

  const release = (announce: string | null) => {
    setGrab(null);
    if (announce) setAnnouncement(announce);
  };

  const keyDown = (event: KeyboardEvent, stage: Stage) => {
    if (mover.pending) return;
    const grabbed = grabRef.current;
    if (!grabbed) {
      if (event.key !== ' ' && event.key !== 'Enter') return;
      event.preventDefault();
      const index = pipeline.stages.findIndex((candidate) => candidate.id === stage.id);
      const origin = { index, columnId: stage.columnId };
      focusId.current = stage.id;
      setGrab({ id: stage.id, origin, dest: origin });
      setAnnouncement(t('settings.pipeline.move.live.grabbed', { name: stage.name }));
      return;
    }
    if (grabbed.id !== stage.id) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      // Only the grab ends: the panel beside the path stays open.
      event.stopPropagation();
      release(t('settings.pipeline.move.live.cancelled', { name: stage.name }));
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const direction = event.key === 'ArrowUp' ? 'up' : 'down';
      const current = preview ?? pipeline;
      const step = stageMoveStep(current, stage.id, direction);
      if (!step) {
        setAnnouncement(
          t(direction === 'up' ? 'settings.pipeline.move.live.start' : 'settings.pipeline.move.live.end'),
        );
        return;
      }
      const next = moveStage(pipeline, stage.id, step);
      const reason = sameplace(step, grabbed.origin) ? null : moveRefusal(config, next, isOwner);
      setGrab({ ...grabbed, dest: step });
      const text = t('settings.pipeline.move.live.step', { name: stage.name, ...place(next, stage.id) });
      setAnnouncement(reason ? `${text} ${forbidden(reason)}` : text);
      return;
    }
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      if (grabReason) {
        setAnnouncement(forbidden(grabReason));
        return;
      }
      if (sameplace(grabbed.dest, grabbed.origin)) {
        release(t('settings.pipeline.move.live.unchanged'));
        return;
      }
      release(null);
      void commit(grabbed.id, grabbed.dest);
    }
  };

  /** The focus left the handle: that ends a grab like Esc. */
  const blur = (stage: Stage) => {
    window.setTimeout(() => {
      if (document.activeElement === handleOf(stage.id)) return;
      if (focusId.current === stage.id) focusId.current = null;
      if (grabRef.current?.id === stage.id)
        release(t('settings.pipeline.move.live.cancelled', { name: stage.name }));
    }, 0);
  };

  return {
    /** The pipeline to draw instead of the saved one: the grabbed stage in its new place, or the move being saved. */
    shown: preview ?? mover.pending?.pipeline ?? null,
    saving: mover.pending?.stageIds ?? [],
    dragging: dragId,
    grabbed: grab?.id ?? null,
    grabReason,
    mark,
    announcement,
    /** The wrapper takes the pointer and the drag (a button cannot be dragged in every browser); the button the keys. */
    handleProps: (stage: Stage) => ({
      wrap: {
        draggable: !mover.pending,
        onDragStart: (event: DragEvent) => {
          setDragId(stage.id);
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', stage.id);
          }
        },
        onDragEnd: clearDrag,
      },
      button: {
        'data-handle': stage.id,
        'aria-pressed': grab?.id === stage.id,
        // Not `disabled`: the button keeps the focus while the move is saved.
        'aria-disabled': mover.pending !== null,
        onKeyDown: (event: KeyboardEvent) => keyDown(event, stage),
        onBlur: () => blur(stage),
      },
    }),
    stageDrop: (stage: Stage) => ({
      onDragOver: (event: DragEvent<HTMLElement>) => {
        const rect = event.currentTarget.getBoundingClientRect();
        hover(event, {
          kind: 'stage',
          id: stage.id,
          edge: event.clientY < rect.top + rect.height / 2 ? 'before' : 'after',
        });
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        const rect = event.currentTarget.getBoundingClientRect();
        drop(event, {
          kind: 'stage',
          id: stage.id,
          edge: event.clientY < rect.top + rect.height / 2 ? 'before' : 'after',
        });
      },
    }),
    headDrop: (run: ColumnRun) => ({
      onDragOver: (event: DragEvent) => hover(event, { kind: 'head', run }),
      onDrop: (event: DragEvent) => drop(event, { kind: 'head', run }),
    }),
  };
}
