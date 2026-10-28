import { useEffect, useState } from 'react';
import { Button } from './Button';
import { ErrorBanner } from './ErrorBanner';
import { t } from '../i18n/t';
import styles from './CopyRow.module.css';

export function CopyRow({
  text,
  label,
  failedText = t('engines.copyFailed'),
}: {
  text: string;
  label: string;
  failedText?: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state !== 'copied') return;
    const timer = window.setTimeout(() => setState('idle'), 1600);
    return () => window.clearTimeout(timer);
  }, [state]);
  return (
    <>
      <div className={styles.copyRow}>
        <code className={styles.code} aria-label={label}>
          {text}
        </code>
        <Button
          size="md"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setState('copied');
            } catch {
              setState('failed');
            }
          }}
        >
          {t(state === 'copied' ? 'engines.copied' : 'engines.copy')}
        </Button>
      </div>
      {state === 'failed' && <ErrorBanner>{failedText}</ErrorBanner>}
    </>
  );
}
