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
  save(): Promise<void>;
  discard(): void;
}

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
  useEffect(() => {
    setPair((previous) =>
      same(previous.base, saved)
        ? previous
        : { ...previous, base: saved, draft: same(previous.draft, previous.base) ? saved : previous.draft },
    );
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

  const save = async () => {
    if (!view || !candidate || draft === null || saving) return;
    const before = view;
    const { key, toPatch, savedText, name } = latest.current;
    setSaving(true);
    setFailure(null);
    try {
      const result = await patch.mutateAsync({ baseVersion: before.version, ...toPatch(candidate) });
      settle(result.config, key);
      toast.show(savedText(draft), 'ok', {
        action: {
          label: t('settings.pipeline.edit.undo'),
          // Only on the version this save made: a later save by anyone is not overwritten.
          run: () => {
            patch
              .mutateAsync({ baseVersion: result.version, ...toPatch(before.config) })
              .then((undone) => {
                settle(undone.config, key);
                toast.show(t('settings.pipeline.edit.undone', { name: name(draft) }));
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
    } catch (error) {
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
    discard,
  };
}
