import clsx from 'clsx';
import type { ReactNode } from 'react';
import styles from './PageHeader.module.css';

/**
 * A page's header: its display title, an optional subtitle, and whatever sits beside them
 * (filters, actions). Pages lay the header out through `className`; `--page-title-size` and
 * `--page-subtitle-size` set there adjust the type.
 */
export function PageHeader({
  title,
  subtitle,
  className,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <header className={clsx(styles.header, className)}>
      <div className={styles.titles}>
        <h1 className={styles.title}>{title}</h1>
        {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
      </div>
      {children}
    </header>
  );
}
