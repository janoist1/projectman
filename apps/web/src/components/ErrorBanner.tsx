import clsx from 'clsx';
import type { ReactNode } from 'react';
import styles from './ErrorBanner.module.css';

/**
 * A form's failure, announced: a tinted block above the form's actions. `silent` leaves the announcement
 * to the page, for a text that changes every second (a countdown).
 */
export function ErrorBanner({
  children,
  className,
  silent = false,
}: {
  children: ReactNode;
  className?: string;
  silent?: boolean;
}) {
  return (
    <p className={clsx(styles.banner, className)} role={silent ? undefined : 'alert'}>
      {children}
    </p>
  );
}
