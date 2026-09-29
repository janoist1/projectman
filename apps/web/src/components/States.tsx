import clsx from 'clsx';
import type { ReactNode } from 'react';
import { t } from '../i18n/t';
import { errorCode, errorMessage } from '../lib/errors';
import { Button } from './Button';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import styles from './States.module.css';

export function Spinner({ size = 18, label }: { size?: number; label?: string }) {
  return (
    <span
      className={styles.spinner}
      style={{ width: size, height: size }}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

export function LoadingState({ className, compact }: { className?: string; compact?: boolean }) {
  return (
    <div className={clsx(styles.state, compact && styles.compact, className)} role="status">
      <Spinner />
      <span>{t('app.loading')}</span>
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  className,
  compact,
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
  compact?: boolean;
}) {
  const code = errorCode(error);
  return (
    <div className={clsx(styles.state, styles.error, compact && styles.compact, className)} role="alert">
      <span className={styles.errorIcon}>
        <Icon name="exclamation" size={18} strokeWidth={2.6} />
      </span>
      <div className={styles.errorText}>
        <span className={styles.errorMessage}>{errorMessage(error)}</span>
        {code ? <span className={styles.code}>{t('errors.code', { code })}</span> : null}
      </div>
      {onRetry ? (
        <Button size="md" variant="secondary" icon="undo" onClick={onRetry}>
          {t('app.retry')}
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  icon = 'check',
  title,
  body,
  action,
  tone = 'neutral',
  className,
}: {
  icon?: IconName;
  title: string;
  body?: string;
  action?: ReactNode;
  tone?: 'neutral' | 'ok';
  className?: string;
}) {
  return (
    <div className={clsx(styles.empty, className)}>
      <span className={clsx(styles.emptyIcon, tone === 'ok' && styles.emptyIconOk)}>
        <Icon name={icon} size={22} strokeWidth={2.4} />
      </span>
      <div className={styles.emptyText}>
        <span className={styles.emptyTitle}>{title}</span>
        {body ? <span className={styles.emptyBody}>{body}</span> : null}
      </div>
      {action}
    </div>
  );
}
