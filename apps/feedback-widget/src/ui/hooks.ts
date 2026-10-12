import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { RefObject } from 'preact';
import type { Controller, State } from '../controller';

/** The controller's state, re-rendered whenever it changes. */
export function useControllerState(controller: Controller): State {
  const [state, setState] = useState(controller.getState());
  useEffect(() => {
    setState(controller.getState());
    return controller.subscribe(() => setState(controller.getState()));
  }, [controller]);
  return state;
}

/**
 * A counter that grows when the page scrolls, resizes or settles, so pins and cards placed from the
 * live layout are placed again. Throttled to one update per frame.
 */
export function useViewTick(active: boolean): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    let frame = 0;
    const bump = (): void => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setTick((value) => value + 1);
      });
    };
    window.addEventListener('scroll', bump, { passive: true });
    window.addEventListener('resize', bump);
    window.addEventListener('load', bump);
    // Images and fonts that load late move the page without an event of ours.
    const interval = setInterval(bump, 2000);
    return () => {
      window.removeEventListener('scroll', bump);
      window.removeEventListener('resize', bump);
      window.removeEventListener('load', bump);
      clearInterval(interval);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [active]);
  return tick;
}

/** The viewport width at which sheets replace the floating cards. */
export const PHONE_WIDTH = 640;

export function useIsPhone(): boolean {
  const [phone, setPhone] = useState(window.innerWidth < PHONE_WIDTH);
  useEffect(() => {
    const onResize = (): void => setPhone(window.innerWidth < PHONE_WIDTH);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return phone;
}

/**
 * A dialog's focus: it moves in when the dialog opens (to `initial`, else the dialog) and goes back to
 * where it was when the dialog closes (the pin or the launcher that opened it).
 */
export function useDialogFocus(root: RefObject<HTMLElement>, initial?: () => HTMLElement | null): void {
  useLayoutEffect(() => {
    const node = root.current;
    const rootNode = node?.getRootNode() as ShadowRoot | Document | undefined;
    const opener = (rootNode?.activeElement ?? null) as HTMLElement | null;
    (initial?.() ?? node)?.focus({ preventScroll: true });
    return () => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
    // Only on open and close.
  }, []);
}

/** A ref that always holds the latest value (for handlers that outlive a render). */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
