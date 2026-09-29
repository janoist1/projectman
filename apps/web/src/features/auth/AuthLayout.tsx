import clsx from 'clsx';
import type { ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import { t } from '../../i18n/t';
import styles from './AuthLayout.module.css';

export function AuthLayout({
  title,
  subtitle,
  wide = false,
  children,
}: {
  title: string;
  subtitle: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={styles.page}>
      <main className={clsx(styles.card, wide && styles.wide)}>
        <div className={styles.brand}>
          <span className={styles.logo}>
            <Icon name="logo" size={20} strokeWidth={2.4} />
          </span>
          <span className={styles.name}>{t('app.name')}</span>
        </div>
        <div className={styles.heading}>
          <h1 className={styles.title}>{title}</h1>
          <p className={styles.subtitle}>{subtitle}</p>
        </div>
        {children}
      </main>
    </div>
  );
}
