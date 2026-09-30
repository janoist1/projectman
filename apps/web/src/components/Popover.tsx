import clsx from 'clsx';
import { useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useDismiss } from '../lib/hooks';
import { Button } from './Button';
import type { ButtonSize, ButtonVariant } from './Button';
import type { IconName } from './Icon';
import styles from './Popover.module.css';

/**
 * A button that opens a small panel under it: a menu of rare actions or a compact form. The panel
 * closes on an outside click, on Escape, or when its content calls `close`. While it is open the
 * panel carries `data-popover-open`, so the surface around it (the task drawer) can leave Escape to
 * the panel.
 */
export function Popover({
  label,
  icon,
  iconRight,
  iconOnly = false,
  variant = 'secondary',
  size = 'md',
  align = 'left',
  className,
  children,
}: {
  /** The button's text; with `iconOnly` its accessible name. */
  label: string;
  icon?: IconName;
  iconRight?: IconName;
  iconOnly?: boolean;
  variant?: ButtonVariant;
  size?: ButtonSize;
  align?: 'left' | 'right';
  className?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const refs = useMemo(() => [wrapRef], []);
  const panelId = useId();
  useDismiss(open, () => setOpen(false), refs, triggerRef);
  return (
    <div ref={wrapRef} className={clsx(styles.wrap, className)}>
      <Button
        ref={triggerRef}
        variant={variant}
        size={size}
        icon={icon}
        iconRight={iconRight}
        iconOnly={iconOnly}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={iconOnly ? label : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        {iconOnly ? undefined : label}
      </Button>
      {open ? (
        <div
          id={panelId}
          data-popover-open="true"
          className={clsx(styles.panel, align === 'right' && styles.right)}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}
