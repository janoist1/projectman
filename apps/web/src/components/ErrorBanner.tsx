import clsx from 'clsx';
import type { ReactNode } from 'react';
import styles from './ErrorBanner.module.css';

/** A form's failure, announced: a tinted block above the form's actions. */
export function ErrorBanner({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={clsx(styles.banner, className)} role="alert">
      {children}
    </p>
  );
}
