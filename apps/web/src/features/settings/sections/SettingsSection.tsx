import type { ReactNode } from 'react';
import styles from './SettingsSection.module.css';

/** A card on the settings page: a titled region, with an optional note beside the title. */
export function SettingsSection({
  id,
  title,
  meta,
  children,
}: {
  /** Id of the heading, which names the region. */
  id?: string;
  title?: string;
  meta?: ReactNode;
  children: ReactNode;
}) {
  const heading =
    title !== undefined ? (
      <h2 id={id} className={styles.cardTitle}>
        {title}
      </h2>
    ) : null;
  return (
    <section className={styles.card} aria-labelledby={title !== undefined ? id : undefined}>
      {meta !== undefined ? (
        <div className={styles.cardHead}>
          {heading}
          {meta}
        </div>
      ) : (
        heading
      )}
      {children}
    </section>
  );
}
