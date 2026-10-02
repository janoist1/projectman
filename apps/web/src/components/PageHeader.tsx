import clsx from 'clsx';
import type { ReactNode } from 'react';
import styles from './PageHeader.module.css';

/**
 * A page's header: its display title, an optional subtitle, and whatever sits beside them
 * (filters, actions). Pages lay the header out through `className`; `--page-title-size` and
 * `--page-subtitle-size` set there adjust the type. `hideTitleOnPhone` is for the pages the
 * bottom tab bar already names: the title stays for screen readers, the phone gets the room.
 */
export function PageHeader({
  title,
  subtitle,
  className,
  hideTitleOnPhone = false,
  leading,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  className?: string;
  hideTitleOnPhone?: boolean;
  /** Something before the title, such as an avatar. */
  leading?: ReactNode;
  children?: ReactNode;
}) {
  const titles = (
    <div className={styles.titles}>
      <h1 className={styles.title}>{title}</h1>
      {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
    </div>
  );
  return (
    <header className={clsx(styles.header, hideTitleOnPhone && styles.titleHiddenOnPhone, className)}>
      {/* The leading element and the titles wrap together, so the avatar never ends up above the name. */}
      {leading ? (
        <div className={styles.lead}>
          {leading}
          {titles}
        </div>
      ) : (
        titles
      )}
      {children}
    </header>
  );
}
