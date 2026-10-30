import { useEffect } from 'react';

/**
 * A language change remounts the routes, which drops the focus on the control that was used. The control
 * asks here for the focus back, and the same control in the new tree takes it when it mounts.
 */
export type LanguageFocusTarget = 'account' | 'switch';

let pending: LanguageFocusTarget | null = null;

export function focusAfterLanguageChange(target: LanguageFocusTarget): void {
  pending = target;
}

/** Takes the focus on mount when this control asked for it; a hidden copy (display: none) leaves the request open. */
export function useRestoredLanguageFocus(
  target: LanguageFocusTarget,
  find: () => HTMLElement | null | undefined,
): void {
  useEffect(() => {
    if (pending !== target) return;
    const element = find();
    element?.focus();
    if (element && document.activeElement === element) pending = null;
    // Only the mount counts: the request belongs to the change that remounted the tree.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
