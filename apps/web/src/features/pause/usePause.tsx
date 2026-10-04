import { useId, useMemo } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { isWorkPaused } from '@projectman/shared';
import type { PausedSession } from '@projectman/shared';
import { useBoard } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { useIsMobile } from '../../lib/hooks';
import { PauseNote } from './PauseNote';
import { openPauses, pausedRowsOf } from './pauseView';

/** The rows of the open pauses in this project, for the member status; undefined while none is open. */
export function usePausedRows(): PausedSession[] | undefined {
  const { key } = useProject();
  const pause = useBoard(key).data?.pause;
  return useMemo(() => pausedRowsOf(pause, key), [pause, key]);
}

/**
 * A start the pause holds back: the props the button takes (`aria-disabled`, not `disabled`, so it
 * stays focusable; the explanation as its description, and as a tooltip where there is a mouse) and
 * the visible line to render under it. Both are empty while nothing holds the start.
 */
export function useHeldStart(
  held: boolean,
  text: string,
): {
  buttonProps: Pick<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-disabled' | 'aria-describedby' | 'title'>;
  note: ReactNode;
} {
  const id = useId();
  const isMobile = useIsMobile();
  if (!held) return { buttonProps: {}, note: null };
  return {
    buttonProps: {
      'aria-disabled': true,
      'aria-describedby': id,
      title: isMobile ? undefined : text,
    },
    note: <PauseNote id={id}>{text}</PauseNote>,
  };
}

/** A pause (the project's or the instance's) holds the work of this project: nothing new starts. */
export function useTeamPaused(): boolean {
  const { key } = useProject();
  const pause = useBoard(key).data?.pause;
  return isWorkPaused(openPauses(pause), key);
}
