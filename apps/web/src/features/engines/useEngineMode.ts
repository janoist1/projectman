import { useCallback, useSyncExternalStore } from 'react';
import { useServerVersion } from '../../api/queries';
import { readStorage, writeStorage } from '../../lib/hooks';
import { engineAppDownloadUrl } from './engineView';
import type { EngineMode } from './engineView';

const STORAGE_KEY = 'engineMode';
const listeners = new Set<() => void>();

function readMode(): EngineMode {
  return readStorage(STORAGE_KEY) === 'checkout' ? 'checkout' : 'app';
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** How this browser installs engines (the motor app by default), the same in every place that shows a command. */
export function useEngineMode(): [EngineMode, (mode: EngineMode) => void] {
  const mode = useSyncExternalStore(subscribe, readMode, () => 'app' as const);
  const setMode = useCallback((next: EngineMode) => {
    writeStorage(STORAGE_KEY, next);
    listeners.forEach((listener) => listener());
  }, []);
  return [mode, setMode];
}

/** The motor app's download: `none` when no release is published yet (or the cloud could not say). */
export type EngineAppDownload = { state: 'loading' } | { state: 'none' } | { state: 'ready'; url: string };

export function useEngineAppDownload(): EngineAppDownload {
  const version = useServerVersion(true);
  if (version.isPending) return { state: 'loading' };
  const url = engineAppDownloadUrl(version.data?.latestRelease?.url);
  return url ? { state: 'ready', url } : { state: 'none' };
}
