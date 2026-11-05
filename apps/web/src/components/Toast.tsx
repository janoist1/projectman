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
  action?: ToastOptions['action'];
  /** How long it stays; null for a sticky toast. */
  duration: number | null;
}

/** A toast with a button stays long enough to reach it. */
const ACTION_MIN_MS = 8000;

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

  const schedule = useCallback(
    (id: number, duration: number) => {
      const timer = setTimeout(() => {
        timers.current.delete(id);
        dismiss(id);
      }, duration);
      timers.current.set(id, timer);
    },
    [dismiss],
  );

  const show = useCallback(
    (message: string, tone: ToastTone = 'ok', options: ToastOptions = {}) => {
      const id = nextId.current++;
      const base = tone === 'error' ? 7000 : 4500;
      const duration = options.sticky ? null : options.action ? Math.max(base, ACTION_MIN_MS) : base;
      setToasts((list) => [
        ...list.slice(-2),
        { id, message, tone, items: options.items ?? [], action: options.action, duration },
      ]);
      if (duration !== null) schedule(id, duration);
    },
    [schedule],
  );

  // While the pointer or the focus is on a toast, its time stands still.
  const hold = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    timers.current.delete(id);
  }, []);
  const release = useCallback(
    (toast: ToastEntry) => {
      if (toast.duration !== null && !timers.current.has(toast.id)) schedule(toast.id, toast.duration);
    },
    [schedule],
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
            onMouseEnter={toast.action ? () => hold(toast.id) : undefined}
            onMouseLeave={toast.action ? () => release(toast) : undefined}
            onFocus={toast.action ? () => hold(toast.id) : undefined}
            onBlur={toast.action ? () => release(toast) : undefined}
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
            {toast.action ? (
              <button
                type="button"
                className={styles.action}
                onClick={() => {
                  dismiss(toast.id);
                  toast.action?.run();
                }}
              >
                {toast.action.label}
              </button>
            ) : null}
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
