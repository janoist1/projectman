import { useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { dragHasFiles, droppedFiles } from '../../lib/attachmentInput';

export interface FileDropOptions {
  /** Whether the files may be taken here; when not, a drag over shows it and a drop does nothing. */
  allowed: boolean;
  onFiles: (files: File[]) => void;
  /**
   * The area is a layer of its own (the open card): its drag events do not reach what lies under it.
   * Otherwise they bubble, so that a larger area (the board) sees the same drag.
   */
  isolate?: boolean;
}

/**
 * Makes an area take files dragged from outside the page. Only a drag that carries files is
 * handled: a dragged card, text or a link is left to whoever listens for it. A drag over a place
 * that does not take the files is still cancelled with `dropEffect = 'none'`, so that the browser
 * does not open the file in place of the page. The enter and leave events of the area's own
 * children are counted, so the highlight does not flicker.
 */
export function useFileDrop({ allowed, onFiles, isolate = false }: FileDropOptions) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const reset = () => {
    depth.current = 0;
    setOver(false);
  };
  const props = {
    onDragEnter: (event: DragEvent) => {
      if (!dragHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      if (isolate) event.stopPropagation();
      depth.current += 1;
      setOver(true);
    },
    onDragOver: (event: DragEvent) => {
      if (!dragHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      if (isolate) event.stopPropagation();
      event.dataTransfer.dropEffect = allowed ? 'copy' : 'none';
    },
    onDragLeave: (event: DragEvent) => {
      if (!dragHasFiles(event.dataTransfer)) return;
      if (isolate) event.stopPropagation();
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    },
    onDrop: (event: DragEvent) => {
      if (!dragHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      // Taken here, whether or not it is allowed. A layer of its own keeps the areas under it out of it;
      // a larger area still hears of it, to end its own highlight.
      if (isolate) event.stopPropagation();
      reset();
      if (allowed) onFiles(droppedFiles(event.dataTransfer));
    },
  };
  return { state: over ? (allowed ? 'over' : 'denied') : null, props } as const;
}
