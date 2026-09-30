import { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';
import type { ProjectConfig, PatchConfigRequest } from '@projectman/shared';
import { usePatchConfig, useRoles } from '../../api/queries';
import { isApiError } from '../../api/client';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import styles from './SettingsPage.module.css';
import { LabelsEditor } from './LabelsEditor';
import { PipelineEditor, issueMessage } from './PipelineEditor';

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

export function EditableSection({ section, children }: { section: Section; children: ReactNode }) {
  const context = useContext(EditingContext);
  const { key, can, isOwner } = useProject();
  const roles = useRoles(key);
  const save = usePatchConfig(key);
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
  const draft = active.draft;
  const details = isApiError(save.error)
    ? (save.error.details as { issues?: { code: string; path: string }[] } | undefined)
    : undefined;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        // Labels live in the pipeline configuration.
        const body: PatchConfigRequest = {
          baseVersion: active.version,
          [section === 'labels' ? 'pipeline' : section]:
            section === 'limits'
              ? draft.team.limits
              : section === 'project'
                ? {
                    name: draft.project.name,
                    language: draft.project.language,
                    timezone: draft.project.timezone,
                  }
                : draft.pipeline,
        };
        save.mutate(body, { onSuccess: () => setEdit(null) });
      }}
    >
      <fieldset className={styles.editor} disabled={save.isPending || reloading}>
        {section === 'project' ? (
          <>
            {(['name', 'language', 'timezone'] as const).map((field) => (
              <label key={field} className={styles.field}>
                {t(`settings.project.${field}`)}
                <input
                  value={draft.project[field]}
                  onChange={(event) =>
                    change((config) => {
                      config.project[field] = event.target.value;
                    })
                  }
                />
              </label>
            ))}
          </>
        ) : section === 'limits' ? (
          <>
            <label className={styles.field}>
              {t('settings.limits.maxConcurrentAi')}
              <input
                type="number"
                min={1}
                max={20}
                value={draft.team.limits.maxConcurrentAi}
                onChange={(event) =>
                  change((config) => {
                    config.team.limits.maxConcurrentAi = Number(event.target.value);
                  })
                }
              />
            </label>
            <label className={styles.field}>
              {t('settings.limits.pauseAbove')}
              <input
                type="range"
                min={10}
                max={100}
                value={draft.team.limits.pauseAbovePlanUsagePercent}
                onChange={(event) =>
                  change((config) => {
                    config.team.limits.pauseAbovePlanUsagePercent = Number(event.target.value);
                  })
                }
              />
              <output>
                {t('settings.limits.pauseAboveValue', {
                  percent: draft.team.limits.pauseAbovePlanUsagePercent,
                })}
              </output>
            </label>
            <label className={styles.field}>
              {t('settings.limits.tempWorkers')}
              <input
                type="checkbox"
                checked={draft.team.limits.tempWorkers.enabled}
                onChange={(event) =>
                  change((config) => {
                    config.team.limits.tempWorkers.enabled = event.target.checked;
                  })
                }
              />
            </label>
            <label className={styles.field}>
              {t('settings.edit.tempMax')}
              <input
                type="number"
                min={0}
                max={5}
                value={draft.team.limits.tempWorkers.max}
                onChange={(event) =>
                  change((config) => {
                    config.team.limits.tempWorkers.max = Number(event.target.value);
                  })
                }
              />
            </label>
            <label className={styles.field}>
              {t('settings.team.role')}
              <select
                value={draft.team.limits.tempWorkers.role}
                disabled={!roles.data}
                onChange={(event) =>
                  change((config) => {
                    config.team.limits.tempWorkers.role = event.target.value;
                  })
                }
              >
                {(roles.data?.roles ?? [])
                  .filter((role) => role.holders !== 'human')
                  .map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
              </select>
            </label>
            {roles.isError ? <p role="alert">{errorMessage(roles.error)}</p> : null}
          </>
        ) : section === 'labels' ? (
          <LabelsEditor draft={draft} change={change} isOwner={isOwner} />
        ) : (
          <PipelineEditor
            draft={draft}
            change={change}
            isOwner={isOwner}
            original={active.originalPipeline}
            submitted={save.variables?.pipeline}
            issues={details?.issues ?? []}
          />
        )}
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
