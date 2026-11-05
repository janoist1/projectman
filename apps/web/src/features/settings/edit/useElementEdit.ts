import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  canonical,
  configSchemaIssues,
  introducedErrors,
  ownerOnlyChanges,
  ProjectConfig as ProjectConfigSchema,
} from '@projectman/shared';
import type { OwnerOnlyChange, PatchConfigRequest, ProjectConfig } from '@projectman/shared';
import { isApiError } from '../../../api/client';
import { useConfig, usePatchConfig } from '../../../api/queries';
import { useProject } from '../../../app/contexts';
import { useToast } from '../../../components/toastContext';
import { t } from '../../../i18n/t';
import type { IssueRef } from '../../../lib/configIssues';
import { errorMessage } from '../../../lib/errors';

export interface ElementEditOptions<D> {
  /** The element's identity, e.g. "stage:dev"; another key starts from the saved element again. */
  key: string;
  /** The element as the configuration holds it; null: the element is gone. */
  initial(config: ProjectConfig): D | null;
  /** The configuration the draft would make. */
  apply(config: ProjectConfig, draft: D): ProjectConfig;
  toPatch(candidate: ProjectConfig): Omit<PatchConfigRequest, 'baseVersion'>;
  /** "Mentve: Fejlesztés" */
  savedText(draft: D): string;
  /** The element's name, for the undo's confirmation. */
  name(draft: D): string;
  /** The configuration without the element; omitted where the element cannot be deleted. */
  without?(config: ProjectConfig): ProjectConfig;
  /** "Törölve: Sürgős" */
  removedText?(draft: D): string;
}

/** What the server answered to a save, beyond a version conflict. */
type SaveFailure =
  | { kind: 'issues'; issues: IssueRef[] }
  | { kind: 'owner_only' }
  /** `reason` is null when the request itself failed (the network, a server fault). */
  | { kind: 'error'; reason: string | null };

export interface ElementEdit<D> {
  draft: D | null;
  setDraft(draft: D): void;
  dirty: boolean;
  candidate: ProjectConfig | null;
  /** The errors the draft would add to the saved configuration, schema issues included. */
  errors: IssueRef[];
  /** The owner-only changes the draft holds, for someone who is not an owner. */
  locked: OwnerOnlyChange[];
  /** Another save came first: the view was reloaded and the draft stayed. */
  conflict: { author: string } | null;
  /** The element was deleted meanwhile. */
  gone: boolean;
  failure: SaveFailure | null;
  saving: boolean;
  /** Counts the successful saves (an undo too), so the screen can mark the moment. */
  saves: number;
  /** True when the draft was saved. */
  save(): Promise<boolean>;
  /** Deletes the element on its own, undoable like a save; resolves to whether it went through. */
  remove(): Promise<boolean>;
  /**
   * Saves `next` (the configuration without this element) at once, whatever the draft holds; the answer says
   * why nothing was deleted, null when it was. `restored` runs after the undo brought the element back.
   */
  removeElement(next: ProjectConfig, name: string, restored?: () => void): Promise<RemoveFailure | null>;
  discard(): void;
}

/** Why a delete went nowhere; `reason` is null when the request itself failed (the network, a server fault). */
export type RemoveFailure =
  /** Another save came first: the view was reloaded, the person has to look again. */
  { kind: 'conflict'; author: string } | { kind: 'error'; reason: string | null };

interface Pair<D> {
  key: string;
  draft: D | null;
  base: D | null;
}

const same = (a: unknown, b: unknown) => canonical(a ?? null) === canonical(b ?? null);

/**
 * One element of the configuration edited on its own: a draft over the saved element, saved with the
 * element's part of the configuration, undone with the version before. Nothing here is specific to a stage.
 */
export function useElementEdit<D>(options: ElementEditOptions<D>): ElementEdit<D> {
  const { key: projectKey, isOwner } = useProject();
  const query = useConfig(projectKey);
  const patch = usePatchConfig(projectKey);
  const toast = useToast();
  const view = query.data;
  const latest = useRef(options);
  latest.current = options;
  const saved = view ? options.initial(view.config) : null;
  const [pair, setPair] = useState<Pair<D>>(() => ({ key: options.key, draft: saved, base: saved }));
  const [conflict, setConflict] = useState<{ author: string } | null>(null);
  const [failure, setFailure] = useState<SaveFailure | null>(null);
  const [saves, setSaves] = useState(0);
  const [saving, setSaving] = useState(false);

  // Another element starts clean; the same element follows the saved configuration unless it holds changes.
  const current = pair.key === options.key ? pair : { key: options.key, draft: saved, base: saved };
  if (current !== pair) {
    setPair(current);
    setConflict(null);
    setFailure(null);
  }
  const savedSignature = canonical(saved ?? null);
  const latestPair = useRef(current);
  latestPair.current = current;
  const busy = useRef(false);
  busy.current = saving;
  // The saved element moved under a clean draft: follow it. Under a draft with changes the draft stays,
  // and when someone else changed this very element, saving it would overwrite their change unseen: the
  // conflict band asks for a look first. (This element's own save leaves the saved value equal to the draft.)
  useEffect(() => {
    const previous = latestPair.current;
    if (same(previous.base, saved)) return;
    const edited = !same(previous.draft, previous.base);
    setPair({ ...previous, base: saved, draft: edited ? previous.draft : saved });
    if (edited && saved !== null && !same(saved, previous.draft) && !busy.current)
      setConflict({ author: view?.history[0]?.author ?? '' });
  }, [savedSignature]);

  const draft = current.draft;
  const dirty = !same(draft, current.base);
  const gone = view !== undefined && saved === null;
  const candidate = useMemo(
    () => (view && draft !== null && !gone ? latest.current.apply(view.config, draft) : null),
    [view, draft, gone],
  );
  const errors = useMemo<IssueRef[]>(() => {
    if (!view || !candidate || !dirty) return [];
    const parsed = ProjectConfigSchema.safeParse(candidate);
    return parsed.success
      ? introducedErrors(view.config, candidate)
      : configSchemaIssues(parsed.error.issues);
  }, [view, candidate, dirty]);
  const locked = useMemo(
    () => (view && candidate && dirty && !isOwner ? ownerOnlyChanges(view.config, candidate) : []),
    [view, candidate, dirty, isOwner],
  );

  const setDraft = useCallback((next: D) => {
    setPair((previous) => ({ ...previous, draft: next }));
    setFailure(null);
  }, []);
  const discard = useCallback(() => {
    setPair((previous) => ({ ...previous, draft: previous.base }));
    setConflict(null);
    setFailure(null);
  }, []);

  // A save or an undo that finishes after another element was opened leaves that element's draft alone.
  const settle = (config: ProjectConfig, key: string) => {
    if (latest.current.key !== key) return;
    const element = latest.current.initial(config);
    setPair((previous) => ({ ...previous, draft: element, base: element }));
    setConflict(null);
    setFailure(null);
    setSaves((count) => count + 1);
  };

  /** Writes `next` and offers the undo on the version this write made. Throws what the server refused. */
  const write = async (
    next: ProjectConfig,
    text: string,
    undoneText: string,
    key: string,
    written?: (config: ProjectConfig) => void,
    restored?: () => void,
  ) => {
    const before = view!;
    const { toPatch } = latest.current;
    const result = await patch.mutateAsync({ baseVersion: before.version, ...toPatch(next) });
    written?.(result.config);
    toast.show(text, 'ok', {
      action: {
        label: t('settings.pipeline.edit.undo'),
        // Only on the version this write made: a later save by anyone is not overwritten.
        run: () => {
          patch
            .mutateAsync({ baseVersion: result.version, ...toPatch(before.config) })
            .then((undone) => {
              settle(undone.config, key);
              toast.show(undoneText);
              restored?.();
            })
            .catch(async (error: unknown) => {
              if (isApiError(error) && error.code === 'config_conflict') {
                await query.refetch();
                toast.show(t('settings.pipeline.edit.undoConflict'), 'error');
              } else toast.show(errorMessage(error), 'error');
            });
        },
      },
    });
  };

  /** Puts what the server refused on the screen: the conflict band, or the failure the form shows. */
  const refused = async (error: unknown) => {
    if (isApiError(error) && error.code === 'config_conflict') {
      const fresh = (await query.refetch()).data;
      setConflict({ author: fresh?.history[0]?.author ?? '' });
    } else if (isApiError(error) && error.code === 'config_invalid') {
      const issues = (error.details as { issues?: IssueRef[] } | undefined)?.issues ?? [];
      setFailure({ kind: 'issues', issues });
    } else if (isApiError(error) && error.code === 'owner_only') setFailure({ kind: 'owner_only' });
    else
      setFailure({
        kind: 'error',
        reason: isApiError(error) && error.status > 0 && error.status < 500 ? errorMessage(error) : null,
      });
  };

  /** True when the draft was saved. */
  const save = async (): Promise<boolean> => {
    if (!view || !candidate || draft === null || saving) return false;
    const { key, savedText, name } = latest.current;
    setSaving(true);
    setFailure(null);
    try {
      await write(
        candidate,
        savedText(draft),
        t('settings.pipeline.edit.undone', { name: name(draft) }),
        key,
        (config) => settle(config, key),
      );
      return true;
    } catch (error) {
      await refused(error);
      return false;
    } finally {
      setSaving(false);
    }
  };

  /** Deletes the element where `without` says how; a deleted element has no draft to settle, the caller closes. */
  const remove = async (): Promise<boolean> => {
    const { without, removedText, key, name } = latest.current;
    if (!view || draft === null || !without || !removedText || saving) return false;
    setSaving(true);
    setFailure(null);
    try {
      await write(
        without(view.config),
        removedText(draft),
        t('settings.pipeline.edit.undone', { name: name(draft) }),
        key,
      );
      return true;
    } catch (error) {
      await refused(error);
      return false;
    } finally {
      setSaving(false);
    }
  };

  /**
   * Saves `next` (the configuration without this element) at once, whatever the draft holds. The draft stays
   * untouched; the answer says why nothing was deleted, null when it was.
   */
  const removeElement = async (
    next: ProjectConfig,
    name: string,
    restored?: () => void,
  ): Promise<RemoveFailure | null> => {
    if (!view || saving) return { kind: 'error', reason: null };
    setSaving(true);
    try {
      await write(
        next,
        t('settings.pipeline.delete.deleted', { name }),
        t('settings.pipeline.edit.undone', { name }),
        latest.current.key,
        undefined,
        restored,
      );
      return null;
    } catch (error) {
      if (isApiError(error) && error.code === 'config_conflict') {
        const fresh = (await query.refetch()).data;
        return { kind: 'conflict', author: fresh?.history[0]?.author ?? '' };
      }
      if (isApiError(error) && error.status > 0 && error.status < 500)
        return { kind: 'error', reason: errorMessage(error) };
      return { kind: 'error', reason: null };
    } finally {
      setSaving(false);
    }
  };

  return {
    draft,
    setDraft,
    dirty,
    candidate,
    errors,
    locked,
    conflict,
    gone,
    failure,
    saving,
    saves,
    save,
    remove,
    removeElement,
    discard,
  };
}
