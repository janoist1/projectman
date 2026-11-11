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
  /** It took the place of another toast: a short cross-fade instead of the slide-in. */
  swapped: boolean;
  /** Counts the repeats of the same toast; its parity restarts the pulse animation. */
  pulse: number;
}

/** The two places: a kept toast (a button or sticky) is never pushed out by a plain one. */
type Slot = 'kept' | 'plain';

const SLOTS: readonly Slot[] = ['kept', 'plain'];

/** A toast with a button stays long enough to reach it. */
const ACTION_MIN_MS = 8000;

const slotOf = (options: ToastOptions): Slot => (options.action || options.sticky ? 'kept' : 'plain');

function isRepeat(a: ToastEntry, b: ToastEntry): boolean {
  return (
    a.message === b.message &&
    a.tone === b.tone &&
    a.action?.label === b.action?.label &&
    a.items.length === b.items.length &&
    a.items.every((item, index) => item.key === b.items[index]?.key && item.text === b.items[index]?.text)
  );
}

type Slots = Record<Slot, ToastEntry | null>;

const isHeld = (state: { pointer: boolean; focus: boolean }) => state.pointer || state.focus;

/** Short confirmations and errors, announced politely to screen readers. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [slots, setSlots] = useState<Slots>({ kept: null, plain: null });
  const slotsRef = useRef<Slots>(slots);
  const nextId = useRef(1);
  const timers = useRef<Map<Slot, ReturnType<typeof setTimeout>>>(new Map());
  /** A toast that came while the pointer or the focus was on its place: the latest one waits. */
  const pending = useRef<Record<Slot, ToastEntry | null>>({ kept: null, plain: null });
  const holding = useRef<Record<Slot, { pointer: boolean; focus: boolean }>>({
    kept: { pointer: false, focus: false },
    plain: { pointer: false, focus: false },
  });

  const place = useCallback((slot: Slot, entry: ToastEntry | null) => {
    slotsRef.current = { ...slotsRef.current, [slot]: entry };
    setSlots(slotsRef.current);
  }, []);

  const clearTimer = useCallback((slot: Slot) => {
    const timer = timers.current.get(slot);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(slot);
    }
  }, []);

  const arm = useCallback(
    (slot: Slot, duration: number | null) => {
      clearTimer(slot);
      if (duration === null) return;
      timers.current.set(
        slot,
        setTimeout(() => {
          timers.current.delete(slot);
          place(slot, null);
        }, duration),
      );
    },
    [clearTimer, place],
  );

  // The place takes the entry; the same toast again keeps its element and restarts its time.
  const put = useCallback(
    (slot: Slot, entry: ToastEntry) => {
      const current = slotsRef.current[slot];
      const next: ToastEntry =
        current && isRepeat(current, entry)
          ? { ...entry, id: current.id, swapped: current.swapped, pulse: current.pulse + 1 }
          : { ...entry, swapped: current !== null };
      place(slot, next);
      arm(slot, next.duration);
    },
    [arm, place],
  );

  const dismiss = useCallback(
    (slot: Slot) => {
      clearTimer(slot);
      holding.current[slot] = { pointer: false, focus: false };
      const waiting = pending.current[slot];
      pending.current[slot] = null;
      place(slot, null);
      if (waiting) put(slot, waiting);
    },
    [clearTimer, place, put],
  );

  const show = useCallback(
    (message: string, tone: ToastTone = 'ok', options: ToastOptions = {}) => {
      const base = tone === 'error' ? 7000 : 4500;
      const duration = options.sticky ? null : options.action ? Math.max(base, ACTION_MIN_MS) : base;
      const slot = slotOf(options);
      const entry: ToastEntry = {
        id: nextId.current++,
        message,
        tone,
        items: options.items ?? [],
        action: options.action,
        duration,
        swapped: false,
        pulse: 0,
      };
      if (slotsRef.current[slot] && isHeld(holding.current[slot])) pending.current[slot] = entry;
      else put(slot, entry);
    },
    [put],
  );

  // While the pointer or the focus is on a toast, its time stands still and nothing replaces it.
  const hold = useCallback(
    (slot: Slot, by: 'pointer' | 'focus') => {
      holding.current[slot][by] = true;
      clearTimer(slot);
    },
    [clearTimer],
  );
  const release = useCallback(
    (slot: Slot, by: 'pointer' | 'focus') => {
      holding.current[slot][by] = false;
      if (isHeld(holding.current[slot])) return;
      const waiting = pending.current[slot];
      pending.current[slot] = null;
      const current = slotsRef.current[slot];
      if (waiting) put(slot, waiting);
      else if (current) arm(slot, current.duration);
    },
    [arm, put],
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
        {SLOTS.map((slot) => {
          const toast = slots[slot];
          if (!toast) return null;
          return (
            <div
              key={toast.id}
              className={clsx(
                styles.toast,
                styles[toast.tone],
                toast.items.length > 0 && styles.listed,
                toast.swapped && styles.swapped,
                toast.pulse > 0 && (toast.pulse % 2 === 1 ? styles.pulseA : styles.pulseB),
              )}
              onMouseEnter={() => hold(slot, 'pointer')}
              onMouseLeave={() => release(slot, 'pointer')}
              onFocus={() => hold(slot, 'focus')}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) release(slot, 'focus');
              }}
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
                    dismiss(slot);
                    toast.action?.run();
                  }}
                >
                  {toast.action.label}
                </button>
              ) : null}
              <button
                type="button"
                className={styles.dismiss}
                onClick={() => dismiss(slot)}
                aria-label={t('toast.dismiss')}
              >
                <Icon name="close" size={14} strokeWidth={2.2} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
