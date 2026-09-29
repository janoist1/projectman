import clsx from 'clsx';
import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { t } from '../i18n/t';
import { Icon } from './Icon';
import styles from './Dialog.module.css';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
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
  size = 'md',
  className,
}: DialogProps) {
  if (!open) return null;
  return (
    <DialogInner
      onClose={onClose}
      title={title}
      description={description}
      footer={footer}
      size={size}
      className={className}
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
  size = 'md',
  className,
}: Omit<DialogProps, 'open'>) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

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
      previous?.focus();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className={clsx(styles.dialog, styles[size], className)}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        onCloseRef.current();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && typeof ref.current?.showModal !== 'function') onCloseRef.current();
      }}
      onMouseDown={(event) => {
        if (event.target === ref.current) onCloseRef.current();
      }}
    >
      <div className={styles.panel}>
        <header className={styles.header}>
          <div className={styles.titles}>
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className={styles.description}>
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            className={styles.close}
            onClick={() => onCloseRef.current()}
            aria-label={t('common.close')}
          >
            <Icon name="close" size={18} strokeWidth={2} />
          </button>
        </header>
        {children ? <div className={styles.body}>{children}</div> : null}
        {footer ? <footer className={styles.footer}>{footer}</footer> : null}
      </div>
    </dialog>
  );
}
