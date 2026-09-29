import clsx from 'clsx';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { t } from '../i18n/t';
import { Icon } from './Icon';
import { ToastContext } from './toastContext';
import type { ToastTone } from './toastContext';
import styles from './Toast.module.css';

interface ToastEntry {
  id: number;
  message: string;
  tone: ToastTone;
}

/** Short confirmations ("Felvéve: QA 2") and errors, announced politely to screen readers. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback(
    (message: string, tone: ToastTone = 'ok') => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-2), { id, message, tone }]);
      setTimeout(() => dismiss(id), tone === 'error' ? 7000 : 4500);
    },
    [dismiss],
  );

  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className={styles.region} role="status" aria-live="polite" aria-label={t('toast.region')}>
        {toasts.map((toast) => (
          <div key={toast.id} className={clsx(styles.toast, styles[toast.tone])}>
            <span className={styles.icon}>
              <Icon
                name={toast.tone === 'error' ? 'exclamation' : toast.tone === 'info' ? 'bell' : 'check'}
                size={15}
                strokeWidth={2.6}
              />
            </span>
            <span className={styles.message}>{toast.message}</span>
            <button
              type="button"
              className={styles.dismiss}
              onClick={() => dismiss(toast.id)}
              aria-label={t('toast.dismiss')}
            >
              <Icon name="close" size={14} strokeWidth={2.2} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
