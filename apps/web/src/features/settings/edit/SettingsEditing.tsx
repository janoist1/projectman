import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { ProjectConfig } from '@projectman/shared';

export type SettingsView = { config: ProjectConfig; version: string };

interface SettingsEditingApi {
  view: SettingsView;
  reload: () => Promise<SettingsView | undefined>;
  /** Some element edit of this part of the page holds changes that are not saved. */
  unsaved: boolean;
  /** Counts one more (or one less) edit with unsaved changes. */
  hold: (delta: 1 | -1) => void;
}

const SettingsEditingContext = createContext<SettingsEditingApi | null>(null);

/**
 * What the parts of one settings section share: the configuration as the page last loaded it, a way to
 * reload it, and whether an open element edit holds unsaved changes (the controls that save at once wait
 * for it, as a saved change moves the version on under the open edit).
 */
export function SettingsEditingProvider({
  view,
  reload,
  children,
}: {
  view: SettingsView;
  reload: () => Promise<SettingsView | undefined>;
  children: ReactNode;
}) {
  const [holding, setHolding] = useState(0);
  const hold = useCallback((delta: 1 | -1) => setHolding((count) => count + delta), []);
  return (
    <SettingsEditingContext.Provider value={{ view, reload, unsaved: holding > 0, hold }}>
      {children}
    </SettingsEditingContext.Provider>
  );
}

export function useSettingsEditing(): SettingsEditingApi | null {
  return useContext(SettingsEditingContext);
}

/** Tells the controls that save at once that this part of the page holds unsaved changes, while `dirty` is true. */
export function useReportUnsaved(dirty: boolean) {
  const hold = useContext(SettingsEditingContext)?.hold;
  useEffect(() => {
    if (!dirty || !hold) return;
    hold(1);
    return () => hold(-1);
  }, [dirty, hold]);
}
