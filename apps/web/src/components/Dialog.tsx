import clsx from 'clsx';
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../i18n/t';
import { Icon } from './Icon';
import styles from './Dialog.module.css';

interface DialogSlots {
  error: HTMLElement | null;
  footer: HTMLElement | null;
}

const SlotsContext = createContext<DialogSlots | null>(null);

/**
 * A form's buttons and the server's refusal. Inside a Dialog they land in its pinned footer, so
 * the form keeps its own state and the buttons stay in view while the body scrolls; a submit
 * button names its form with `form={id}`. Outside a Dialog they stay where the form puts them.
 */
export function DialogActions({ error, children }: { error?: ReactNode; children: ReactNode }) {
  const slots = useContext(SlotsContext);
  if (!slots) {
    return (
      <>
        {error}
        <div className={styles.inlineActions}>{children}</div>
      </>
    );
  }
  return (
    <>
      {slots.error && error ? createPortal(error, slots.error) : null}
      {slots.footer ? createPortal(children, slots.footer) : null}
    </>
  );
}

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  kicker?: ReactNode;
  menu?: ReactNode;
  back?: ReactNode;
  /** Detail panels focus their heading after showModal, including when the item changes. */
  focusTitle?: boolean;
  description?: string;
  children?: ReactNode;
  /** The buttons, pinned under the scrolling body: [Cancel] [Primary], the primary one last. */
  footer?: ReactNode;
  /** The server's refusal, pinned above the footer so it shows without scrolling. */
  error?: ReactNode;
  /** `sm` is a confirmation: a bottom sheet on a phone. `md` and `lg` are forms: full screen there. */
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

/**
 * Modal dialog on the native <dialog> element (focus trap, Esc, top layer). Content is
 * mounted only while open, so forms start fresh every time.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  error,
  size = 'md',
  className,
  kicker,
  menu,
  back,
  focusTitle,
}: DialogProps) {
  if (!open) return null;
  return (
    <DialogInner
      onClose={onClose}
      title={title}
      description={description}
      footer={footer}
      error={error}
      size={size}
      className={className}
      kicker={kicker}
      menu={menu}
      back={back}
      focusTitle={focusTitle}
    >
      {children}
    </DialogInner>
  );
}

function DialogInner({
  onClose,
  title,
  description,
  children,
  footer,
  error,
  size = 'md',
  className,
  kicker,
  menu,
  back,
  focusTitle,
}: Omit<DialogProps, 'open'>) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const onCloseRef = useRef(onClose);
  const detailed = focusTitle || kicker !== undefined || menu !== undefined || back !== undefined;
  onCloseRef.current = onClose;
  const [errorSlot, setErrorSlot] = useState<HTMLElement | null>(null);
  const [footerSlot, setFooterSlot] = useState<HTMLElement | null>(null);
  const slots = useMemo(() => ({ error: errorSlot, footer: footerSlot }), [errorSlot, footerSlot]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
    return () => {
      if (typeof dialog.close === 'function' && dialog.open) dialog.close();
      if (previous?.isConnected) previous.focus();
      else
        document
          .querySelector<HTMLElement>('[data-settings-content] h2[id^="settings-"]:not(#settings-problems)')
          ?.focus();
    };
  }, []);

  useEffect(() => {
    if (focusTitle) titleRef.current?.focus();
  }, [focusTitle, title]);

  return (
    <dialog
      ref={ref}
      className={clsx(styles.dialog, styles[size], className)}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (focusTitle && ref.current?.querySelector('[role="menu"]')) return;
        onCloseRef.current();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && focusTitle && ref.current?.querySelector('[role="menu"]')) {
          event.preventDefault();
          return;
        }
        if (event.key === 'Escape' && typeof ref.current?.showModal !== 'function') onCloseRef.current();
      }}
      onMouseDown={(event) => {
        if (event.target === ref.current) onCloseRef.current();
      }}
    >
      <div className={styles.panel}>
        <header className={clsx(styles.header, detailed && styles.detailHeader)}>
          {detailed ? (
            <div className={styles.detailTop}>
              <span className={styles.kicker}>{kicker}</span>
              {menu}
              <button
                type="button"
                className={styles.close}
                onClick={() => onCloseRef.current()}
                aria-label={t('common.close')}
              >
                <Icon name="close" size={18} />
              </button>
            </div>
          ) : null}
          <div className={styles.titles}>
            <h2 ref={titleRef} id={titleId} tabIndex={focusTitle ? -1 : undefined} className={styles.title}>
              {title}
            </h2>
            {back}
            {description ? (
              <p id={descriptionId} className={styles.description}>
                {description}
              </p>
            ) : null}
          </div>
          {!detailed ? (
            <button
              type="button"
              className={styles.close}
              onClick={() => onCloseRef.current()}
              aria-label={t('common.close')}
            >
              <Icon name="close" size={18} strokeWidth={2} />
            </button>
          ) : null}
        </header>
        <SlotsContext.Provider value={slots}>
          {children ? <div className={styles.body}>{children}</div> : null}
          <div ref={setErrorSlot} className={styles.error} />
          <footer ref={setFooterSlot} className={styles.footer} />
          {footer || error ? <DialogActions error={error}>{footer}</DialogActions> : null}
        </SlotsContext.Provider>
      </div>
    </dialog>
  );
}
