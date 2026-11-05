import { useEffect, useRef, useState } from 'react';
import type { PatchConfigRequest, ProjectConfig } from '@projectman/shared';
import { usePatchConfig } from '../../../api/queries';
import { useProject } from '../../../app/contexts';
import { useSettingsEditing } from './SettingsEditing';
import type { SettingsView } from './SettingsEditing';

export interface InstantOptions<Note> {
  /** The request that makes `next` of the last saved configuration. */
  body(next: ProjectConfig, saved: SettingsView): PatchConfigRequest;
  /** A save went through; `before` is the configuration it was made over, `note` what the caller passed to `commit`. */
  saved(result: SettingsView, before: SettingsView, note: Note): void;
  /** The server refused a save (or the request failed): says so where the person looks, and reloads on a conflict. */
  refused(caught: unknown): void | Promise<void>;
}

/**
 * Controls that save the moment they change, with no edit mode: each change is applied to the last
 * known configuration, shown at once, and sent in turn (one at a time, each on the version the one
 * before produced). The first refusal drops the changes queued behind it.
 */
export function useInstantConfig<Note = undefined>(config: ProjectConfig, options: InstantOptions<Note>) {
  const context = useSettingsEditing();
  const { key } = useProject();
  const save = usePatchConfig(key);
  const latest = useRef<SettingsView | undefined>(context?.view);
  const view = context?.view;
  useEffect(() => {
    latest.current = view;
  }, [view]);
  const handlers = useRef(options);
  handlers.current = options;
  const [optimistic, setOptimistic] = useState<ProjectConfig | null>(null);
  /** The version the page showed before the changes that were saved; the page is up to date once it moves on. */
  const [waitingPast, setWaitingPast] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const optimisticRef = useRef<ProjectConfig | null>(null);
  const inflight = useRef(0);
  const burstStart = useRef<string | null>(null);
  const failed = useRef(false);
  const queue = useRef<Promise<void>>(Promise.resolve());

  // The shown values stay until the page itself has the saved configuration, so a control does not
  // flicker back to the old value (and out of existence) in between.
  useEffect(() => {
    if (waitingPast === null || !view || view.version === waitingPast || inflight.current > 0) return;
    optimisticRef.current = null;
    setOptimistic(null);
    setWaitingPast(null);
  }, [view, waitingPast]);

  /** The configuration the next change is made over: what is shown, saved or not yet. */
  const base = () => optimisticRef.current ?? latest.current?.config ?? config;

  const commit = (update: (draft: ProjectConfig) => void, note?: Note): Promise<boolean> => {
    const next = structuredClone(base());
    update(next);
    optimisticRef.current = next;
    setOptimistic(next);
    setWaitingPast(null);
    setError(null);
    if (inflight.current === 0) burstStart.current = latest.current?.version ?? null;
    inflight.current += 1;
    let succeeded = false;
    queue.current = queue.current.then(async () => {
      try {
        if (failed.current || !latest.current) return;
        const before = latest.current;
        const result = await save.mutateAsync(handlers.current.body(next, before));
        latest.current = result;
        succeeded = true;
        handlers.current.saved(result, before, note as Note);
      } catch (caught) {
        failed.current = true;
        setError(caught);
        await handlers.current.refused(caught);
      } finally {
        inflight.current -= 1;
        if (inflight.current === 0) {
          failed.current = false;
          if (latest.current?.version === burstStart.current) {
            // Nothing was saved: the page already shows the real values.
            optimisticRef.current = null;
            setOptimistic(null);
          } else setWaitingPast(burstStart.current);
        }
      }
    });
    return queue.current.then(() => succeeded);
  };
  return { shown: optimistic ?? config, saving: optimistic !== null, base, commit, error };
}
