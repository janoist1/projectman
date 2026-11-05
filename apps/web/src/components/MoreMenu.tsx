import { useId } from 'react';
import type { ReactNode } from 'react';
import { t } from '../i18n/t';
import { Button } from './Button';
import { Popover } from './Popover';
import styles from './MoreMenu.module.css';

/**
 * One action of the menu. When `disabled` it is greyed out but still reachable with the arrows, and `reason`
 * (what keeps it from working) stands under it, tied to it for a screen reader.
 */
export function MoreMenuItem({
  disabled = false,
  reason,
  onClick,
  children,
}: {
  disabled?: boolean;
  reason?: string | null;
  onClick(): void;
  children: ReactNode;
}) {
  const reasonId = useId();
  return (
    <>
      <Button
        variant="ghost"
        size="md"
        aria-disabled={disabled || undefined}
        aria-describedby={disabled && reason ? reasonId : undefined}
        className={disabled ? styles.disabled : undefined}
        onClick={() => {
          if (!disabled) onClick();
        }}
      >
        {children}
      </Button>
      {disabled && reason ? (
        <p id={reasonId} className={styles.reason}>
          {reason}
        </p>
      ) : null}
    </>
  );
}

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
