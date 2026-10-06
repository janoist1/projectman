import { useEffect, useId, useLayoutEffect, useRef } from 'react';
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
  /** Stable selection identity: changing a draft title must not move the input focus. */
  itemKey?: string;
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
  itemKey,
}: DetailPanelProps) {
  const wide = useMediaQuery(SETTINGS_WIDE_QUERY);
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const panel = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
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
    if (open && wide && !window.matchMedia('(prefers-reduced-motion: reduce)').matches)
      content.current?.animate?.(
        [
          { opacity: 0, transform: 'translateX(8px)' },
          { opacity: 1, transform: 'none' },
        ],
        { duration: 160, easing: 'ease-out' },
      );
  }, [open, itemKey, wide]);
  useEffect(() => {
    const element = panel.current;
    if (!wide || !element) return;
    const measure = () => {
      const top = Math.max(12, element.getBoundingClientRect().top);
      element.style.setProperty('--settings-panel-height', `${Math.max(0, window.innerHeight - top - 12)}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    document.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      document.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [wide]);
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
        focusKey={itemKey}
        returnFocusRef={opener}
      >
        {children}
      </Dialog>
    );
  return (
    <aside
      ref={panel}
      className={styles.panel}
      aria-labelledby={open ? titleId : undefined}
      onKeyDown={(event) => {
        // Menus get the first Escape; their key handler may preventDefault or stop propagation.
        if (
          event.key === 'Escape' &&
          !event.defaultPrevented &&
          !event.currentTarget.querySelector('[data-popover-open]')
        ) {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      {open ? (
        <div ref={content} className={styles.content}>
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
