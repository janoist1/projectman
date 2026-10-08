import clsx from 'clsx';
import type { MapState } from '@projectman/shared';
import styles from './StateMark.module.css';

/**
 * The mark of one of the five map states (PM-379): colour and shape together, so it never relies on
 * colour alone. The text beside it names the state. The colour comes from the `[data-phase]` tones.
 */
export function StateMark({ state, className }: { state: MapState; className?: string }) {
  return (
    <span className={clsx(styles.mark, styles[state], className)} data-phase={state} aria-hidden="true" />
  );
}
