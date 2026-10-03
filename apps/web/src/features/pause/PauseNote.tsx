import clsx from 'clsx';
import { Icon } from '../../components/Icon';
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
}: {
  id?: string;
  children: string;
  className?: string;
}) {
  return (
    <p id={id} className={clsx(styles.note, className)}>
      <Icon name="pause" size={14} strokeWidth={2.2} />
      <span>{children}</span>
    </p>
  );
}
