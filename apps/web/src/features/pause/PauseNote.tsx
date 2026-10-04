import clsx from 'clsx';
import { Icon } from '../../components/Icon';
import type { IconName } from '../../components/Icon';
import styles from './PauseNote.module.css';

/**
 * The line that explains a start the team pause holds back (PM-220): the pause icon and the
 * reason, in view (a touch screen has no hover and a disabled button has no focus). The button
 * names it with `aria-describedby`.
 */
export function PauseNote({
  id,
  children,
  className,
  icon = 'pause',
}: {
  id?: string;
  children: string;
  className?: string;
  /** The pause's own icon by default; the closed-session line (PM-296) shows the history icon. */
  icon?: IconName;
}) {
  return (
    <p id={id} className={clsx(styles.note, className)}>
      <Icon name={icon} size={14} strokeWidth={2.2} />
      <span>{children}</span>
    </p>
  );
}
