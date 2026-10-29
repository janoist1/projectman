import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  complexitySettersOf,
  PrioritySetter,
  prioritySettersOf,
  ProjectManagerLifecycleAction,
  projectManagerLifecycleOf,
  taskCreateAccessOf,
} from '@projectman/shared';
import type { ProjectConfig, PatchConfigRequest, Pipeline } from '@projectman/shared';
import { usePatchConfig } from '../../api/queries';
import { isApiError } from '../../api/client';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { issueMessage } from '../../lib/configIssues';
import type { IssueRef } from '../../lib/configIssues';
import { errorMessage } from '../../lib/errors';
import styles from './settings.module.css';

type Section = 'project' | 'pipeline' | 'labels';
type Edit = {
  section: Section;
  draft: ProjectConfig;
  version: string;
  originalPipeline: ProjectConfig['pipeline'];
};
type View = { config: ProjectConfig; version: string };
const EditingContext = createContext<{
  edit: Edit | null;
  setEdit: (edit: Edit | null) => void;
  view: View;
  reload: () => Promise<View | undefined>;
  /** A draft outside the section editors (the duty matrix) holds changes that are not saved. */
  unsaved: boolean;
  setUnsaved: (unsaved: boolean) => void;
} | null>(null);

/** Tells the limits that this part of the page holds unsaved changes, while `dirty` is true. */
export function useReportUnsaved(dirty: boolean) {
  const setUnsaved = useContext(EditingContext)?.setUnsaved;
  useEffect(() => {
    setUnsaved?.(dirty);
    return () => setUnsaved?.(false);
  }, [dirty, setUnsaved]);
}

/** What a section's editor gets: the draft, a way to change it, and the server's issues. */
export interface SectionEditorProps {
  draft: ProjectConfig;
  change: (update: (draft: ProjectConfig) => void) => void;
  isOwner: boolean;
  /** The pipeline when editing began (removed stages can be restored from it). */
  original: Pipeline;
  /** The pipeline last sent, which issue paths refer to. */
  submitted?: Pipeline;
  issues: IssueRef[];
}

export function SettingsEditingProvider({
  view,
  reload,
  children,
}: {
  view: View;
  reload: () => Promise<View | undefined>;
  children: ReactNode;
}) {
  const [edit, setEdit] = useState<Edit | null>(null);
  const [unsaved, setUnsaved] = useState(false);
  return (
    <EditingContext.Provider value={{ edit, setEdit, view, reload, unsaved, setUnsaved }}>
      {children}
    </EditingContext.Provider>
  );
}

/**
 * The limits part of the configuration, as the limits section saves it, and what else saves the moment
 * it changes: who merges, and which repositories require a merge (PM-453). Those two go only where they
 * differ from the saved configuration, the merger as the kind chosen and a repository's value as
 * true, false or null (the project's default applies).
 */
function limitsBody(draft: ProjectConfig, saved: ProjectConfig, baseVersion: string): PatchConfigRequest {
  const repoMerge = draft.project.repos.flatMap((repo) => {
    const before = saved.project.repos.find((entry) => entry.name === repo.name)?.requireMerge ?? null;
    const requireMerge = repo.requireMerge ?? null;
    return requireMerge === before ? [] : [{ repo: repo.name, requireMerge }];
  });
  const merger =
    draft.team.merger && JSON.stringify(draft.team.merger) !== JSON.stringify(saved.team.merger)
      ? draft.team.merger
      : null;
  const cardMover =
    draft.team.cardMover && JSON.stringify(draft.team.cardMover) !== JSON.stringify(saved.team.cardMover)
      ? draft.team.cardMover
      : null;
  const projectManagerMoves =
    draft.team.projectManagerMoves !== saved.team.projectManagerMoves
      ? draft.team.projectManagerMoves
      : undefined;
  // The lifecycle actions go as the whole list when it differs from the saved one (PM-1098); [] is a value.
  const lifecycleOf = (config: ProjectConfig) => {
    const chosen = projectManagerLifecycleOf(config);
    return ProjectManagerLifecycleAction.options.filter((action) => chosen.includes(action));
  };
  const projectManagerLifecycle = lifecycleOf(draft);
  const lifecycleChanged = JSON.stringify(projectManagerLifecycle) !== JSON.stringify(lifecycleOf(saved));
  const prerequisiteOverride =
    draft.team.prerequisiteOverride !== saved.team.prerequisiteOverride
      ? draft.team.prerequisiteOverride
      : undefined;
  // The priority setters go as the whole list when it changed, [] too; compared in the options' order.
  const settersOf = (config: ProjectConfig) => {
    const chosen = prioritySettersOf(config);
    return PrioritySetter.options.filter((setter) => chosen.includes(setter));
  };
  const prioritySetters = settersOf(draft);
  const prioritySettersChanged = JSON.stringify(prioritySetters) !== JSON.stringify(settersOf(saved));
  const viewerRecipients =
    draft.team.viewerRecipients !== saved.team.viewerRecipients ? draft.team.viewerRecipients : undefined;
  // Who may open a new card goes only when it differs from the saved value (PM-1100); owner-only on the server.
  const taskCreateAccess =
    taskCreateAccessOf(draft) !== taskCreateAccessOf(saved) ? taskCreateAccessOf(draft) : undefined;
  // The complexity setters go as the whole list when it differs from the saved one (PM-1097); [] is a value.
  const complexitySetters = complexitySettersOf(draft);
  const complexityChanged = JSON.stringify(complexitySetters) !== JSON.stringify(complexitySettersOf(saved));
  // The assignee-fit choice goes only when it differs from the saved one (PM-1137); a missing value is the default.
  const assigneeFit =
    (draft.team.assigneeFit ?? 'automatic') !== (saved.team.assigneeFit ?? 'automatic')
      ? (draft.team.assigneeFit ?? 'automatic')
      : undefined;
  // The contacts go as the whole list when it changed, an empty one too: a missing field keeps the stored list.
  const contacts = draft.team.contacts ?? [];
  const contactsChanged = JSON.stringify(contacts) !== JSON.stringify(saved.team.contacts ?? []);
  // A removed cap or warning limit is sent as null: a missing field would leave the stored one as it is.
  return {
    baseVersion,
    ...(merger ? { merger } : {}),
    ...(cardMover ? { cardMover } : {}),
    ...(taskCreateAccess ? { taskCreateAccess } : {}),
    ...(projectManagerMoves ? { projectManagerMoves } : {}),
    ...(lifecycleChanged ? { projectManagerLifecycle } : {}),
    ...(prerequisiteOverride ? { prerequisiteOverride } : {}),
    ...(prioritySettersChanged ? { prioritySetters } : {}),
    ...(complexityChanged ? { complexitySetters: [...complexitySetters] } : {}),
    ...(contactsChanged ? { contacts } : {}),
    ...(viewerRecipients ? { viewerRecipients } : {}),
    ...(assigneeFit ? { assigneeFit } : {}),
    ...(repoMerge.length ? { repoMerge } : {}),
    limits: {
      ...draft.team.limits,
      maxConcurrentAi: draft.team.limits.maxConcurrentAi ?? null,
      warnAboveSessionTokens: draft.team.limits.warnAboveSessionTokens ?? null,
      autoCompactWindowTokens: draft.team.limits.autoCompactWindowTokens ?? null,
    },
    ...(draft.team.boundary ? { boundary: draft.team.boundary } : {}),
  };
}

/** The part of the configuration a section saves (labels live in the pipeline). */
function patchBody(section: Section, draft: ProjectConfig, baseVersion: string): PatchConfigRequest {
  if (section === 'project')
    return {
      baseVersion,
      project: {
        name: draft.project.name,
        language: draft.project.language,
        timezone: draft.project.timezone,
      },
    };
  return { baseVersion, pipeline: draft.pipeline };
}

/**
 * The limits save the moment a control changes, with no edit mode: each change is applied to the
 * last known configuration, shown at once, and sent in turn (one at a time, each on the version the
 * one before produced). The first refusal drops the changes queued behind it and shows the
 * server's answer; a version conflict also reloads the configuration.
 */
export function useInstantLimits(config: ProjectConfig) {
  const context = useContext(EditingContext);
  const { key } = useProject();
  const save = usePatchConfig(key);
  const toast = useToast();
  const latest = useRef<View | undefined>(context?.view);
  const reload = context?.reload;
  const view = context?.view;
  useEffect(() => {
    latest.current = view;
  }, [view]);
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

  const commit = (update: (draft: ProjectConfig) => void) => {
    const base = optimisticRef.current ?? latest.current?.config ?? config;
    const next = structuredClone(base);
    update(next);
    optimisticRef.current = next;
    setOptimistic(next);
    setWaitingPast(null);
    setError(null);
    if (inflight.current === 0) burstStart.current = latest.current?.version ?? null;
    inflight.current += 1;
    queue.current = queue.current.then(async () => {
      try {
        if (failed.current || !latest.current) return;
        const result = await save.mutateAsync(
          limitsBody(next, latest.current.config, latest.current.version),
        );
        latest.current = result;
        toast.show(t('settings.edit.saved'));
      } catch (caught) {
        failed.current = true;
        setError(caught);
        // The control may be off screen (a phone), so the refusal is also a toast, except when the control
        // itself shows the field's error (the merger, the card mover): the toast would cover it.
        const conflict = isApiError(caught) && caught.code === 'config_conflict';
        const atField =
          isApiError(caught) &&
          (caught.details as { issues?: IssueRef[] } | undefined)?.issues?.some(
            (issue) => issue.code === 'merger_unresolved' || issue.code.startsWith('mover_'),
          );
        if (!atField) toast.show(conflict ? t('settings.limits.conflict') : errorMessage(caught), 'error');
        if (conflict) await reload?.();
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
  };
  // A saved change moves the version on: the open editor's save would be a conflict, and the duty
  // matrix would be rebuilt without its draft.
  const locked = context?.edit != null || context?.unsaved === true;
  return { shown: optimistic ?? config, saving: optimistic !== null, commit, error, locked };
}

/**
 * A section of the settings that admins can edit: its read-only view with an edit button, or
 * while editing, the section's editor with save and cancel, and the server's refusal.
 */
export function EditableSection({
  section,
  editor,
  children,
}: {
  section: Section;
  editor: (props: SectionEditorProps) => ReactNode;
  children: ReactNode;
}) {
  const context = useContext(EditingContext);
  const { key, can, isOwner } = useProject();
  const save = usePatchConfig(key);
  const toast = useToast();
  const [reloading, setReloading] = useState(false);
  if (!context) return children;
  const { edit, setEdit, view, reload } = context;
  const active = edit?.section === section ? edit : null;
  const change = (update: (config: ProjectConfig) => void) => {
    if (!active) return;
    const draft = structuredClone(active.draft);
    update(draft);
    setEdit({ ...active, draft });
  };
  if (!active)
    return (
      <>
        {can.manageTeam ? (
          <div className={styles.actions}>
            <Button
              variant="secondary"
              disabled={edit !== null}
              onClick={() => {
                save.reset();
                setEdit({
                  section,
                  draft: structuredClone(view.config),
                  version: view.version,
                  originalPipeline: view.config.pipeline,
                });
              }}
            >
              {t('memberEdit.edit')}
            </Button>
          </div>
        ) : null}
        {children}
      </>
    );
  const details = isApiError(save.error)
    ? (save.error.details as { issues?: IssueRef[] } | undefined)
    : undefined;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(patchBody(section, active.draft, active.version), {
          onSuccess: () => {
            setEdit(null);
            toast.show(t('settings.edit.saved'));
          },
        });
      }}
    >
      <fieldset className={styles.editor} disabled={save.isPending || reloading}>
        {editor({
          draft: active.draft,
          change,
          isOwner,
          original: active.originalPipeline,
          submitted: save.variables?.pipeline,
          issues: details?.issues ?? [],
        })}
        <div className={styles.actions}>
          <Button type="submit" variant="primary" loading={save.isPending}>
            {t('memberEdit.save')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              save.reset();
              setEdit(null);
            }}
          >
            {t('common.cancel')}
          </Button>
        </div>
      </fieldset>
      {save.error ? (
        <div role="alert" className={styles.validation}>
          <p>
            {isApiError(save.error) && save.error.code === 'config_conflict'
              ? t('settings.edit.conflict')
              : errorMessage(save.error)}
          </p>
          {details?.issues?.length ? (
            <ul>
              {details.issues.map((issue, i) => (
                <li key={i}>
                  {issue.path}: {issueMessage(issue)}
                </li>
              ))}
            </ul>
          ) : null}
          {isApiError(save.error) && save.error.code === 'config_conflict' ? (
            <Button
              variant="secondary"
              loading={reloading}
              disabled={save.isPending}
              onClick={async () => {
                setReloading(true);
                try {
                  const latest = await reload();
                  if (latest) {
                    save.reset();
                    setEdit({
                      section,
                      draft: structuredClone(latest.config),
                      version: latest.version,
                      originalPipeline: latest.config.pipeline,
                    });
                  }
                } finally {
                  setReloading(false);
                }
              }}
            >
              {t('settings.edit.reload')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
