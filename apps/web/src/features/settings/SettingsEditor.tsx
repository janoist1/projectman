import { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';
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

type Section = 'project' | 'limits' | 'pipeline' | 'labels';
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
} | null>(null);

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
  return (
    <EditingContext.Provider value={{ edit, setEdit, view, reload }}>{children}</EditingContext.Provider>
  );
}

/** The part of the configuration a section saves (labels live in the pipeline). */
function patchBody(section: Section, draft: ProjectConfig, baseVersion: string): PatchConfigRequest {
  // A removed cap is sent as null: a missing field would leave the stored one as it is.
  if (section === 'limits')
    return {
      baseVersion,
      limits: { ...draft.team.limits, maxConcurrentAi: draft.team.limits.maxConcurrentAi ?? null },
      ...(draft.team.boundary ? { boundary: draft.team.boundary } : {}),
    };
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
