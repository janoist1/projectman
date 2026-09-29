import { getLocale } from '@projectman/templates';
import { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';
import { CheckName, DUTY_IDS, DutyId } from '@projectman/shared';
import type { ProjectConfig, GateCondition, PatchConfigRequest, MemberConfig } from '@projectman/shared';
import { usePatchConfig, useRoles } from '../../api/queries';
import { isApiError } from '../../api/client';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { t, tDynamic } from '../../i18n/t';
import { codeMessage, errorMessage } from '../../lib/errors';
import styles from './SettingsPage.module.css';

type Section = 'project' | 'limits' | 'pipeline';
type Edit = { section: Section; draft: ProjectConfig; version: string };
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

function MemberSelect({
  label,
  members,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  members: MemberConfig[];
  value: string[];
  onChange: (handles: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <label className={styles.field}>
      {label}
      <select
        multiple
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Array.from(event.target.selectedOptions, (option) => option.value))}
      >
        {members.map((member) => (
          <option key={member.handle} value={member.handle}>
            {member.displayName}
          </option>
        ))}
      </select>
    </label>
  );
}

function PipelineEditor({
  draft,
  change,
  isOwner,
}: {
  draft: ProjectConfig;
  change: (update: (draft: ProjectConfig) => void) => void;
  isOwner: boolean;
}) {
  const humans = draft.team.members.filter((member) => member.kind === 'human');
  return (
    <ol className={styles.stages}>
      {draft.pipeline.stages.map((stage, index) => {
        const conditions = stage.gate?.conditions ?? [];
        const updateConditions = (next: GateCondition[]) =>
          change((config) => {
            config.pipeline.stages[index]!.gate = next.length ? { conditions: next } : undefined;
          });
        return (
          <li key={stage.id} className={styles.stage}>
            <p>{t('settings.pipeline.kind', { kind: t(`stageKinds.${stage.kind}`) })}</p>
            <label className={styles.field}>
              {t('settings.project.name')}
              <input
                value={stage.name}
                onChange={(event) =>
                  change((config) => {
                    config.pipeline.stages[index]!.name = event.target.value;
                  })
                }
              />
            </label>
            <label className={styles.field}>
              {t('settings.edit.description')}
              <textarea
                value={stage.description ?? ''}
                onChange={(event) =>
                  change((config) => {
                    config.pipeline.stages[index]!.description = event.target.value;
                  })
                }
              />
            </label>
            <div className={styles.actions}>
              {([-1, 1] as const).map((offset) => (
                <Button
                  key={offset}
                  variant="secondary"
                  disabled={index + offset < 0 || index + offset >= draft.pipeline.stages.length}
                  onClick={() =>
                    change((config) => {
                      const stages = config.pipeline.stages;
                      [stages[index], stages[index + offset]] = [stages[index + offset]!, stages[index]!];
                    })
                  }
                >
                  {t(offset === -1 ? 'settings.edit.moveUp' : 'settings.edit.moveDown')}
                </Button>
              ))}
            </div>
            <label className={styles.field}>
              {t('duties.duty')}
              <select
                value={stage.duty ?? ''}
                onChange={(event) =>
                  change((config) => {
                    config.pipeline.stages[index]!.duty = event.target.value
                      ? DutyId.parse(event.target.value)
                      : undefined;
                  })
                }
              >
                <option value="">{t('duties.noDuty')}</option>
                {DUTY_IDS.map((id) => (
                  <option key={id} value={id}>
                    {getLocale(draft.project.language).duties[id].name}
                  </option>
                ))}
              </select>
            </label>
            {stage.duty && (
              <Button
                variant="secondary"
                onClick={() =>
                  change((config) => {
                    delete config.pipeline.stages[index]!.owners;
                  })
                }
              >
                {t('duties.defaultOwners')}
              </Button>
            )}
            <MemberSelect
              label={t('settings.pipeline.owners')}
              members={draft.team.members}
              value={stage.owners ?? []}
              onChange={(owners) =>
                change((config) => {
                  config.pipeline.stages[index]!.owners = owners;
                })
              }
            />
            <fieldset className={styles.conditions}>
              <legend>{t('settings.pipeline.gate')}</legend>
              {conditions.map((condition, conditionIndex) => {
                const locked = condition.type === 'human_approval' && !isOwner;
                const replace = (next: GateCondition) =>
                  updateConditions(conditions.map((value, i) => (i === conditionIndex ? next : value)));
                return (
                  <div key={conditionIndex} className={styles.condition}>
                    <label className={styles.field}>
                      {t('settings.edit.condition')}
                      <select
                        value={condition.type}
                        disabled={locked}
                        onChange={(event) => {
                          const type = event.target.value as GateCondition['type'];
                          replace(
                            type === 'check_passed'
                              ? { type, check: 'code_review' }
                              : type === 'pr_merged'
                                ? { type }
                                : { type, approvers: [] },
                          );
                        }}
                      >
                        <option value="check_passed">{t('settings.edit.checkPassed')}</option>
                        <option value="pr_merged">{t('settings.pipeline.gatePrMerged')}</option>
                        <option value="human_approval" disabled={!isOwner}>
                          {t('settings.edit.humanApproval')}
                        </option>
                      </select>
                    </label>
                    {condition.type === 'check_passed' ? (
                      <label className={styles.field}>
                        {t('settings.edit.check')}
                        <select
                          value={condition.check}
                          onChange={(event) =>
                            replace({ ...condition, check: CheckName.parse(event.target.value) })
                          }
                        >
                          {CheckName.options.map((check) => (
                            <option key={check} value={check}>
                              {t(`checks.names.${check}`)}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    {condition.type === 'human_approval' ? (
                      <>
                        <label className={styles.field}>
                          {t('duties.duty')}
                          <select
                            disabled={!isOwner}
                            value={condition.duty ?? ''}
                            onChange={(event) =>
                              replace(
                                event.target.value
                                  ? { type: 'human_approval', duty: DutyId.parse(event.target.value) }
                                  : { type: 'human_approval', approvers: humans.map((m) => m.handle) },
                              )
                            }
                          >
                            <option value="">{t('duties.explicitOwners')}</option>
                            {DUTY_IDS.map((id) => (
                              <option key={id} value={id}>
                                {getLocale(draft.project.language).duties[id].name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <MemberSelect
                          label={t('settings.edit.approvers')}
                          members={humans}
                          value={condition.approvers ?? []}
                          disabled={!isOwner}
                          onChange={(approvers) => replace({ type: 'human_approval', approvers })}
                        />
                        {!isOwner ? (
                          <p className={styles.muted}>{t('settings.edit.approversOwnerOnly')}</p>
                        ) : null}
                      </>
                    ) : null}
                    <Button
                      variant="secondary"
                      disabled={locked}
                      onClick={() => updateConditions(conditions.filter((_, i) => i !== conditionIndex))}
                    >
                      {t('settings.edit.removeCondition')}
                    </Button>
                  </div>
                );
              })}
              <Button
                variant="secondary"
                onClick={() =>
                  updateConditions([...conditions, { type: 'check_passed', check: 'code_review' }])
                }
              >
                {t('settings.edit.addCondition')}
              </Button>
            </fieldset>
          </li>
        );
      })}
    </ol>
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
                setEdit({ section, draft: structuredClone(view.config), version: view.version });
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
        const body: PatchConfigRequest = {
          baseVersion: active.version,
          [section]:
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
        ) : (
          <PipelineEditor draft={draft} change={change} isOwner={isOwner} />
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
                  {issue.path}:{' '}
                  {codeMessage(issue.code) ??
                    tDynamic(`settings.issues.${issue.code}`, t('settings.issues.invalid_value'))}
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
                    setEdit({ section, draft: structuredClone(latest.config), version: latest.version });
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
