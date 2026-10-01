import type { ReactNode } from 'react';
import { t } from '../i18n/t';
import { Popover } from './Popover';
import styles from './MoreMenu.module.css';

/**
 * The "⋯" button that holds a surface's rare actions (cancel, retire, stop, remove) so the common
 * ones stay in view. The content is a column of buttons; call `close` when one is picked.
 */
export function MoreMenu({
  label = t('common.moreActions'),
  align = 'right',
  children,
}: {
  /** The button's accessible name. */
  label?: string;
  align?: 'left' | 'right' | 'row';
  children: (close: () => void) => ReactNode;
}) {
  return (
    <Popover label={label} icon="more" iconOnly variant="muted" size="md" align={align}>
      {(close) => <div className={styles.menu}>{children(close)}</div>}
    </Popover>
  );
}
