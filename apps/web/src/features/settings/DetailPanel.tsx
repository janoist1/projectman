import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { Dialog } from '../../components/Dialog';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/Button';
import { t } from '../../i18n/t';
import { useMediaQuery } from '../../lib/hooks';
import { SETTINGS_WIDE_QUERY } from './sections';
import styles from './DetailPanel.module.css';

interface DetailPanelProps {
  open: boolean;
  title: ReactNode;
  kicker?: ReactNode;
  menu?: ReactNode;
  back?: ReactNode;
  footer?: ReactNode;
  empty?: ReactNode;
  onClose(): void;
  children?: ReactNode;
}

/** A shared list/panel grid; narrow screens keep the modal outside the document flow. */
export function SettingsDetailLayout({ children }: { children: ReactNode }) {
  return <div className={styles.layout}>{children}</div>;
}

export function MissingSettingsElement({ onClose }: { onClose(): void }) {
  return (
    <>
      <p className={styles.muted}>{t('settings.detail.goneBody')}</p>
      <Button variant="secondary" onClick={onClose}>
        {t('common.close')}
      </Button>
    </>
  );
}

export function DetailPanel({
  open,
  title,
  kicker,
  menu,
  back,
  footer,
  empty,
  onClose,
  children,
}: DetailPanelProps) {
  const wide = useMediaQuery(SETTINGS_WIDE_QUERY);
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (opener.current?.isConnected) opener.current.focus();
      else
        document
          .querySelector<HTMLElement>('[data-settings-content] h2[id^="settings-"]:not(#settings-problems)')
          ?.focus();
    };
  }, [open]);
  useEffect(() => {
    if (open && wide) heading.current?.focus();
  }, [open, title, wide]);
  if (!wide)
    return (
      <Dialog
        open={open}
        size="md"
        title={title}
        kicker={kicker}
        menu={menu}
        back={back}
        footer={footer}
        onClose={onClose}
        focusTitle
      >
        {children}
      </Dialog>
    );
  return (
    <aside
      className={styles.panel}
      aria-labelledby={open ? titleId : undefined}
      onKeyDown={(event) => {
        // Menus get the first Escape; their key handler may preventDefault or stop propagation.
        if (
          event.key === 'Escape' &&
          !event.defaultPrevented &&
          !event.currentTarget.querySelector('[role="menu"]')
        ) {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      {open ? (
        <div className={styles.content}>
          <header className={styles.header}>
            <div className={styles.top}>
              <span className={styles.kicker}>{kicker}</span>
              {menu}
              <button className={styles.close} type="button" onClick={onClose} aria-label={t('common.close')}>
                <Icon name="close" size={18} />
              </button>
            </div>
            <h2 ref={heading} id={titleId} tabIndex={-1}>
              {title}
            </h2>
            {back}
          </header>
          <div className={styles.body}>{children}</div>
          {footer ? <footer className={styles.footer}>{footer}</footer> : null}
        </div>
      ) : (
        <div className={styles.empty}>{empty}</div>
      )}
    </aside>
  );
}
