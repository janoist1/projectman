import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { t } from '../i18n/t';
import { Icon } from './Icon';
import { ToastContext } from './toastContext';
import type { ToastItem, ToastOptions, ToastTone } from './toastContext';
import styles from './Toast.module.css';

interface ToastEntry {
  id: number;
  message: string;
  tone: ToastTone;
  items: readonly ToastItem[];
}

/** Short confirmations and errors, announced politely to screen readers. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const nextId = useRef(1);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((list) => list.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback(
    (message: string, tone: ToastTone = 'ok', options: ToastOptions = {}) => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-2), { id, message, tone, items: options.items ?? [] }]);
      if (!options.sticky) {
        const timer = setTimeout(
          () => {
            timers.current.delete(id);
            dismiss(id);
          },
          tone === 'error' ? 7000 : 4500,
        );
        timers.current.set(id, timer);
      }
    },
    [dismiss],
  );

  useEffect(() => {
    const activeTimers = timers.current;
    return () => {
      for (const timer of activeTimers.values()) {
        clearTimeout(timer);
      }
      activeTimers.clear();
    };
  }, []);

  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className={styles.region}
        data-inert-exempt
        role="status"
        aria-live="polite"
        aria-label={t('toast.region')}
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={clsx(styles.toast, styles[toast.tone], toast.items.length > 0 && styles.listed)}
          >
            <span className={styles.icon}>
              <Icon
                name={toast.tone === 'error' ? 'exclamation' : toast.tone === 'info' ? 'bell' : 'check'}
                size={15}
                strokeWidth={2.6}
              />
            </span>
            <span className={styles.message}>
              {toast.message}
              {toast.items.length > 0 && (
                <ul className={styles.items}>
                  {toast.items.map((item) => (
                    <li key={item.key}>
                      {item.bare ? null : item.to ? (
                        <Link to={item.to} className={styles.itemKey}>
                          {item.key}
                        </Link>
                      ) : (
                        <span className={styles.itemKey}>{item.key}</span>
                      )}
                      {item.bare ? null : ' '}
                      {item.text}
                    </li>
                  ))}
                </ul>
              )}
            </span>
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
