import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { Button } from '../../components/Button';
import { ErrorBanner } from '../../components/ErrorBanner';
import { t } from '../../i18n/t';
import styles from './CopyRow.module.css';

const COPIED_MS = 1600;

/**
 * A command or text with its own "Másolás" button. `scroll` is for a long, multi-line text (an instruction
 * for an assistant): the box scrolls at a fixed height and can be reached with the keyboard.
 */
export function CopyRow({
  text,
  label,
  scroll = false,
  copyLabel = t('engines.copy'),
}: {
  text: string;
  label: string;
  scroll?: boolean;
  /** The button's text before the copy; a long text says what it copies ("Utasítás másolása"). */
  copyLabel?: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  // "Másolva" is a confirmation, not a state: it goes back to "Másolás" after a moment.
  useEffect(() => {
    if (state !== 'copied') return;
    const timer = window.setTimeout(() => setState('idle'), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [state]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
  };
  return (
    <>
      <div className={clsx(styles.copyRow, scroll && styles.stacked)}>
        <code
          className={clsx(styles.code, scroll && styles.scroll)}
          aria-label={label}
          tabIndex={scroll ? 0 : undefined}
        >
          {text}
        </code>
        <Button variant="secondary" size="md" onClick={() => void copy()}>
          {state === 'copied' ? t('engines.copied') : copyLabel}
        </Button>
      </div>
      {state === 'failed' && <ErrorBanner>{t('engines.copyFailed')}</ErrorBanner>}
    </>
  );
}
