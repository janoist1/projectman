import clsx from 'clsx';
import { useLayoutEffect, useRef, useState } from 'react';
import type { InboxOption } from '@projectman/shared';
import { Button } from '../../components/Button';
import type { ButtonSize, ButtonVariant } from '../../components/Button';
import { t } from '../../i18n/t';
import { optionLabel } from '../../lib/inbox';
import styles from './PermissionParts.module.css';

const variantFor: Record<InboxOption['style'], ButtonVariant> = {
  primary: 'primary',
  secondary: 'secondary',
  danger: 'danger',
};

/** The option that is rare enough to sit under the main row as a small text button. */
const SECONDARY_OPTION = 'allow_session';

/**
 * The buttons of a permission request, the same in the inbox list, the task sheet and the session's
 * chat: the decision itself in one row (refusal first, so the affirmative one is under the thumb), the
 * rarer "always in this session" as a small text button below.
 */
export function PermissionActions({
  options,
  size = 'lg',
  disabled = false,
  onPick,
}: {
  options: readonly InboxOption[];
  size?: ButtonSize;
  disabled?: boolean;
  onPick: (option: InboxOption) => void;
}) {
  const secondary = options.filter((option) => option.id === SECONDARY_OPTION);
  const main = options.filter((option) => option.id !== SECONDARY_OPTION);
  const ordered = [...main.filter((option) => option.id === 'deny'), ...main.filter((o) => o.id !== 'deny')];
  return (
    <div className={styles.actions}>
      <div className={styles.row}>
        {ordered.map((option) => (
          <Button
            key={option.id}
            variant={variantFor[option.style]}
            size={size}
            className={styles.main}
            disabled={disabled}
            onClick={() => onPick(option)}
          >
            {optionLabel(option)}
          </Button>
        ))}
      </div>
      {secondary.map((option) => (
        <Button
          key={option.id}
          variant="ghost"
          size="sm"
          className={styles.secondary}
          disabled={disabled}
          onClick={() => onPick(option)}
        >
          {optionLabel(option)}
        </Button>
      ))}
    </div>
  );
}

/** A command or target of a permission request: four lines at most, the rest behind "Teljes parancs". */
export function FoldedCommand({ text, className }: { text: string; className?: string | undefined }) {
  const [open, setOpen] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || open) return;
    const measure = () => setOverflowing(element.scrollHeight > element.clientHeight + 1);
    measure();
    // The width changes with the window and with a drawer or sidebar opening, not only on resize.
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, open]);

  return (
    <div className={styles.command}>
      <code ref={ref} className={clsx(className, !open && styles.clamped)}>
        {text}
      </code>
      {overflowing || open ? (
        <button
          type="button"
          className={styles.more}
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          {open ? t('inbox.commandLess') : t('inbox.commandFull')}
        </button>
      ) : null}
    </div>
  );
}
