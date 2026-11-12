import { useCallback, useEffect, useRef, useState } from 'react';
import type { TeamMessage } from '@projectman/shared';
import { useReadTeamMessages } from '../../api/queries';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { failText } from '../../lib/errors';

/** A message counts as read once its unread mark has been wholly on the screen this long without a break (L-03). */
const READ_AFTER_MS = 1000;
/** The ids that became eligible are gathered this long, from the first one, and go in one request. */
const READ_BATCH_MS = 200;
/** A mark is "wholly" shown from this share on: layout rounding keeps a fully shown one just below 1. */
const SHOWN_RATIO = 0.95;

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible;
}

/**
 * Whether the element lies under something that shrinks the visual viewport (a phone's on-screen keyboard): the
 * layout viewport the IntersectionObserver measures against may not follow it, so the element is checked against the
 * visual viewport too.
 */
function isCoveredByViewport(element: Element): boolean {
  const viewport = window.visualViewport;
  if (!viewport) return false;
  const rect = element.getBoundingClientRect();
  const area = rect.width * rect.height;
  if (area <= 0) return false;
  const width =
    Math.min(rect.right, viewport.offsetLeft + viewport.width) - Math.max(rect.left, viewport.offsetLeft);
  const height =
    Math.min(rect.bottom, viewport.offsetTop + viewport.height) - Math.max(rect.top, viewport.offsetTop);
  return Math.max(0, width) * Math.max(0, height) < SHOWN_RATIO * area;
}

type Watch = (id: string) => (element: Element | null) => void;

/**
 * Marks incoming messages read when they have really been seen (L-03): a message is read after its unread mark has
 * been wholly visible (within its scroller and the browser's screen, not under a phone's keyboard) for `READ_AFTER_MS`
 * while `active` and the tab is
 * in the foreground. Leaving the screen, hiding the tab or going inactive drops the time not yet elapsed; showing it
 * again starts it anew. The eligible ids are gathered for `READ_BATCH_MS` and sent in one request. A failed request
 * leaves the messages unread, shows one toast and is not retried by itself: showing the mark again tries again.
 *
 * `watch(id)` is the ref callback of the unread mark of message `id`; render the mark (and so the ref) only while the
 * message is unread. `onRead` receives the messages the server answered with.
 */
export function useReadWhenVisible(
  key: string,
  { active = true, onRead }: { active?: boolean; onRead?: (messages: TeamMessage[]) => void } = {},
): Watch {
  const toast = useToast();
  const { mutateAsync: markRead } = useReadTeamMessages(key);
  const documentVisible = useDocumentVisible();
  const enabled = active && documentVisible;

  const latest = useRef({ toast, onRead, markRead });
  useEffect(() => {
    latest.current = { toast, onRead, markRead };
  });

  const state = useRef({
    enabled: false,
    observer: null as IntersectionObserver | null,
    elements: new Map<string, Element>(),
    idOf: new Map<Element, string>(),
    shown: new Set<string>(),
    dwell: new Map<string, ReturnType<typeof setTimeout>>(),
    pending: new Set<string>(),
    requested: new Set<string>(),
    batch: null as ReturnType<typeof setTimeout> | null,
    callbacks: new Map<string, (element: Element | null) => void>(),
  });

  const stopTiming = useCallback(() => {
    const s = state.current;
    for (const timer of s.dwell.values()) clearTimeout(timer);
    s.dwell.clear();
    if (s.batch) clearTimeout(s.batch);
    s.batch = null;
    s.pending.clear();
  }, []);

  const flush = useCallback(() => {
    const s = state.current;
    s.batch = null;
    const ids = [...s.pending];
    s.pending.clear();
    if (ids.length === 0) return;
    for (const id of ids) s.requested.add(id);
    latest.current
      .markRead(ids)
      .then((view) => latest.current.onRead?.(view.messages))
      .catch((error: unknown) => {
        for (const id of ids) s.requested.delete(id);
        latest.current.toast.show(failText(error, t('messages.readFailed')), 'error');
      });
  }, []);

  const startDwell = useCallback(
    (id: string) => {
      const s = state.current;
      if (!s.enabled || s.dwell.has(id) || s.pending.has(id) || s.requested.has(id)) return;
      const element = s.elements.get(id);
      if (element && isCoveredByViewport(element)) return;
      s.dwell.set(
        id,
        setTimeout(() => {
          s.dwell.delete(id);
          s.pending.add(id);
          s.batch ??= setTimeout(flush, READ_BATCH_MS);
        }, READ_AFTER_MS),
      );
    },
    [flush],
  );

  const getObserver = useCallback((): IntersectionObserver | null => {
    const s = state.current;
    if (s.observer || typeof IntersectionObserver === 'undefined') return s.observer;
    s.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = s.idOf.get(entry.target);
          if (id === undefined) continue;
          if (entry.isIntersecting && entry.intersectionRatio >= SHOWN_RATIO) {
            s.shown.add(id);
            startDwell(id);
          } else {
            s.shown.delete(id);
            clearTimeout(s.dwell.get(id));
            s.dwell.delete(id);
          }
        }
      },
      { threshold: [0, SHOWN_RATIO, 1] },
    );
    return s.observer;
  }, [startDwell]);

  useEffect(() => {
    const s = state.current;
    s.enabled = enabled;
    if (enabled) for (const id of s.shown) startDwell(id);
    else stopTiming();
  }, [enabled, startDwell, stopTiming]);

  // The keyboard coming or going changes the visual viewport without any intersection change: a mark it covers loses
  // its time, one it uncovers starts anew.
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const s = state.current;
    const sync = () => {
      for (const id of s.shown) {
        const element = s.elements.get(id);
        if (element && isCoveredByViewport(element)) {
          clearTimeout(s.dwell.get(id));
          s.dwell.delete(id);
        } else {
          startDwell(id);
        }
      }
    };
    viewport.addEventListener('resize', sync);
    viewport.addEventListener('scroll', sync);
    return () => {
      viewport.removeEventListener('resize', sync);
      viewport.removeEventListener('scroll', sync);
    };
  }, [startDwell]);

  // The elements are registered when they mount, before this runs: observe them now, and let go of everything on leaving.
  useEffect(() => {
    const s = state.current;
    const observer = getObserver();
    for (const element of s.elements.values()) observer?.observe(element);
    return () => {
      s.observer?.disconnect();
      s.observer = null;
      s.shown.clear();
      stopTiming();
    };
  }, [getObserver, stopTiming]);

  return useCallback<Watch>(
    (id) => {
      const s = state.current;
      const cached = s.callbacks.get(id);
      if (cached) return cached;
      const callback = (element: Element | null) => {
        const previous = s.elements.get(id);
        if (previous && previous !== element) {
          s.observer?.unobserve(previous);
          s.idOf.delete(previous);
          s.elements.delete(id);
          s.shown.delete(id);
          clearTimeout(s.dwell.get(id));
          s.dwell.delete(id);
          s.requested.delete(id);
        }
        if (element) {
          if (s.elements.get(id) === element) return;
          s.elements.set(id, element);
          s.idOf.set(element, id);
          getObserver()?.observe(element);
        } else {
          s.callbacks.delete(id);
        }
      };
      s.callbacks.set(id, callback);
      return callback;
    },
    [getObserver],
  );
}
