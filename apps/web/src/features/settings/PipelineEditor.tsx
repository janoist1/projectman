import { getLocale } from '@projectman/templates';
import { useState } from 'react';
import { CheckName, DUTY_IDS, DutyId, StageKind } from '@projectman/shared';
import type { ProjectConfig, GateCondition, MemberConfig, Stage, Pipeline } from '@projectman/shared';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { t, tDynamic } from '../../i18n/t';
import { codeMessage } from '../../lib/errors';
import styles from './SettingsPage.module.css';

export type PipelineIssue = { code: string; path: string };

export function issueMessage(issue: PipelineIssue): string {
  return (
    codeMessage(issue.code) ?? tDynamic(`settings.issues.${issue.code}`, t('settings.issues.invalid_value'))
  );
}

/** IDs follow the config's 32-character, lowercase underscore format. */
function uniqueId(name: string, ids: string[]): string {
  const slug = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const base = (/^[a-z]/.test(slug) ? slug : `stage_${slug}`).slice(0, 32);
  let id = base;
  for (let suffix = 2; ids.includes(id); suffix++) {
    const tail = `_${suffix}`;
    id = `${base.slice(0, 32 - tail.length)}${tail}`;
  }
  return id;
}

function StageFields({
  stage,
  pipeline,
  update,
}: {
  stage: Stage;
  pipeline: Pipeline;
  update: (update: (stage: Stage) => void) => void;
}) {
  return (
    <>
      <label className={styles.field}>
        {t('settings.project.name')}
        <input
          value={stage.name}
          onChange={(event) =>
            update((draft) => {
              draft.name = event.target.value;
            })
          }
        />
      </label>
      <label className={styles.field}>
        {t('settings.pipeline.kindLabel')}
        <select
          value={stage.kind}
          onChange={(event) =>
            update((draft) => {
              draft.kind = StageKind.parse(event.target.value);
            })
          }
        >
          {StageKind.options.map((kind) => (
            <option key={kind} value={kind}>
              {t(`stageKinds.${kind}`)} — {t(`settings.pipeline.kindHelp.${kind}`)}
            </option>
          ))}
        </select>
      </label>
      <p className={styles.muted}>{t(`settings.pipeline.kindHelp.${stage.kind}`)}</p>
      <label className={styles.field}>
        {t('settings.pipeline.column')}
        <select
          value={stage.columnId}
          onChange={(event) =>
            update((draft) => {
              draft.columnId = event.target.value;
            })
          }
        >
          {pipeline.columns.map((column) => (
            <option key={column.id} value={column.id}>
              {column.name}
            </option>
          ))}
        </select>
      </label>
      <label className={styles.field}>
        {t('settings.edit.description')}
        <textarea
          value={stage.description ?? ''}
          onChange={(event) =>
            update((draft) => {
              draft.description = event.target.value;
            })
          }
        />
      </label>
    </>
  );
}

function StageOwners({
  stage,
  config,
  update,
}: {
  stage: Stage;
  config: ProjectConfig;
  update: (update: (stage: Stage) => void) => void;
}) {
  return (
    <>
      <label className={styles.field}>
        {t('duties.duty')}
        <select
          value={stage.duty ?? ''}
          onChange={(event) =>
            update((draft) => {
              draft.duty = event.target.value ? DutyId.parse(event.target.value) : undefined;
              delete draft.owners;
            })
          }
        >
          <option value="">{t('duties.explicitOwners')}</option>
          {DUTY_IDS.map((id) => (
            <option key={id} value={id}>
              {getLocale(config.project.language).duties[id].name}
            </option>
          ))}
        </select>
      </label>
      <p className={styles.muted}>
        {t(
          stage.duty && stage.owners === undefined
            ? 'settings.pipeline.dutyOwners'
            : 'settings.pipeline.explicitOwners',
        )}
      </p>
      {stage.duty && (
        <Button
          variant="secondary"
          onClick={() =>
            update((draft) => {
              delete draft.owners;
            })
          }
        >
          {t('duties.defaultOwners')}
        </Button>
      )}
      <MemberSelect
        label={t('settings.pipeline.owners')}
        members={config.team.members}
        value={stage.owners ?? []}
        onChange={(owners) =>
          update((draft) => {
            draft.owners = owners;
          })
        }
      />
    </>
  );
}

function AddStage({
  config,
  change,
  close,
}: {
  config: ProjectConfig;
  change: (update: (draft: ProjectConfig) => void) => void;
  close: () => void;
}) {
  const [stage, setStage] = useState<Stage>({
    id: '',
    name: '',
    kind: 'work',
    duty: 'implementation',
    columnId: config.pipeline.columns[0]!.id,
  });
  const [after, setAfter] = useState(config.pipeline.stages[0]?.id ?? '');
  const update = (update: (stage: Stage) => void) => {
    const next = structuredClone(stage);
    update(next);
    setStage(next);
  };
  const canAdd =
    !!stage.name.trim() &&
    (after === '' || config.pipeline.stages.some((entry) => entry.id === after)) &&
    config.pipeline.columns.some((entry) => entry.id === stage.columnId);
  const add = () => {
    if (!canAdd) return;
    change((draft) => {
      const id = uniqueId(
        stage.name,
        draft.pipeline.stages.map((stage) => stage.id),
      );
      const index = draft.pipeline.stages.findIndex((stage) => stage.id === after);
      draft.pipeline.stages.splice(index + 1, 0, { ...stage, id, name: stage.name.trim() });
    });
    close();
  };
  return (
    <fieldset
      className={styles.newStage}
      aria-label={t('settings.pipeline.addStage')}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
          event.preventDefault();
          add();
        }
      }}
    >
      <legend>{t('settings.pipeline.addStage')}</legend>
      <StageFields stage={stage} pipeline={config.pipeline} update={update} />
      <label className={styles.field}>
        {t('settings.pipeline.afterStage')}
        <select value={after} onChange={(event) => setAfter(event.target.value)}>
          <option value="">{t('settings.pipeline.atStart')}</option>
          {config.pipeline.stages.map((existing) => (
            <option key={existing.id} value={existing.id}>
              {existing.name}
            </option>
          ))}
        </select>
      </label>
      <StageOwners stage={stage} config={config} update={update} />
      <div className={styles.actions}>
        <Button disabled={!canAdd} onClick={add}>
          {t('settings.pipeline.createStage')}
        </Button>
        <Button onClick={close}>{t('common.cancel')}</Button>
      </div>
    </fieldset>
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

export function PipelineEditor({
  draft,
  change,
  isOwner,
  original,
  submitted,
  issues,
}: {
  draft: ProjectConfig;
  change: (update: (draft: ProjectConfig) => void) => void;
  isOwner: boolean;
  original: Pipeline;
  submitted?: Pipeline;
  issues: PipelineIssue[];
}) {
  const humans = draft.team.members.filter((member) => member.kind === 'human');
  const [adding, setAdding] = useState(false);
  const [columnName, setColumnName] = useState('');
  const [columnError, setColumnError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Stage | null>(null);
  const addColumn = () => {
    if (!columnName.trim()) return;
    change((config) => {
      config.pipeline.columns.push({
        id: uniqueId(
          columnName,
          config.pipeline.columns.map((column) => column.id),
        ),
        name: columnName.trim(),
      });
    });
    setColumnName('');
    setColumnError(null);
  };
  const removed = original.stages.filter(
    (stage) => !draft.pipeline.stages.some((entry) => entry.id === stage.id),
  );
  return (
    <>
      <fieldset className={styles.conditions}>
        <legend>{t('settings.pipeline.columns')}</legend>
        {draft.pipeline.columns.map((column, index) => (
          <div key={column.id} className={styles.column}>
            <label className={styles.field}>
              {t('settings.pipeline.columnName')}
              <input
                value={column.name}
                onChange={(event) =>
                  change((config) => {
                    config.pipeline.columns[index]!.name = event.target.value;
                  })
                }
              />
            </label>
            <Button
              variant="secondary"
              onClick={() => {
                const count = draft.pipeline.stages.filter((stage) => stage.columnId === column.id).length;
                if (count) {
                  setColumnError(t('settings.pipeline.columnInUse', { count }));
                  return;
                }
                if (draft.pipeline.columns.length === 1) {
                  setColumnError(t('settings.pipeline.lastColumn'));
                  return;
                }
                setColumnError(null);
                change((config) => {
                  config.pipeline.columns.splice(index, 1);
                });
              }}
            >
              {t('settings.pipeline.removeColumn')}
            </Button>
          </div>
        ))}
        {columnError && <p role="alert">{columnError}</p>}
        <label className={styles.field}>
          {t('settings.pipeline.columnName')}
          <input
            value={columnName}
            onChange={(event) => setColumnName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                addColumn();
              }
            }}
          />
        </label>
        <Button disabled={!columnName.trim()} onClick={addColumn}>
          {t('settings.pipeline.addColumn')}
        </Button>
      </fieldset>
      <Button onClick={() => setAdding(true)} disabled={adding}>
        {t('settings.pipeline.addStage')}
      </Button>
      {adding && <AddStage config={draft} change={change} close={() => setAdding(false)} />}
      <ol className={styles.stages}>
        {draft.pipeline.stages.map((stage, index) => {
          const conditions = stage.gate?.conditions ?? [];
          const updateConditions = (next: GateCondition[]) =>
            change((config) => {
              config.pipeline.stages[index]!.gate = next.length ? { conditions: next } : undefined;
            });
          return (
            <li key={stage.id} className={styles.stage} aria-label={stage.name}>
              <StageFields
                stage={stage}
                pipeline={draft.pipeline}
                update={(update) => change((config) => update(config.pipeline.stages[index]!))}
              />
              {issues
                .filter((issue) => {
                  const match = /^pipeline\.stages(?:\[(\d+)\]|\.(\d+))(?:\.|$)/.exec(issue.path);
                  return (
                    match &&
                    (submitted ?? draft.pipeline).stages[Number(match[1] ?? match[2])]?.id === stage.id
                  );
                })
                .map((issue, i) => (
                  <p key={i} className={styles.validation} role="alert">
                    {issueMessage(issue)}
                  </p>
                ))}
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
              <Button
                variant="danger"
                disabled={
                  !isOwner &&
                  !!stage.gate?.conditions.some((condition) => condition.type === 'human_approval')
                }
                onClick={() => setRemoving(stage)}
              >
                {t('settings.pipeline.removeStage')}
              </Button>
              <StageOwners
                stage={stage}
                config={draft}
                update={(update) => change((config) => update(config.pipeline.stages[index]!))}
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
      {removed.map((stage) => (
        <div key={stage.id} className={styles.stage}>
          <p>{t('settings.pipeline.removedStage', { stage: stage.name })}</p>
          <Button
            onClick={() =>
              change((config) => {
                if (!config.pipeline.columns.some((column) => column.id === stage.columnId)) {
                  config.pipeline.columns.push(
                    structuredClone(original.columns.find((column) => column.id === stage.columnId)!),
                  );
                }
                const position = original.stages.findIndex((entry) => entry.id === stage.id);
                const next = original.stages
                  .slice(position + 1)
                  .find((entry) => config.pipeline.stages.some((value) => value.id === entry.id));
                const index = next
                  ? config.pipeline.stages.findIndex((entry) => entry.id === next.id)
                  : config.pipeline.stages.length;
                config.pipeline.stages.splice(index, 0, structuredClone(stage));
              })
            }
          >
            {t('settings.pipeline.undoRemove')}
          </Button>
        </div>
      ))}
      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        size="sm"
        title={removing ? t('settings.pipeline.removeTitle', { stage: removing.name }) : ''}
        description={t('settings.pipeline.removeBody')}
        footer={
          <>
            <Button
              variant="dangerSolid"
              onClick={() => {
                change((config) => {
                  config.pipeline.stages = config.pipeline.stages.filter(
                    (stage) => stage.id !== removing?.id,
                  );
                });
                setRemoving(null);
              }}
            >
              {t('settings.pipeline.removeStage')}
            </Button>
            <Button onClick={() => setRemoving(null)}>{t('common.cancel')}</Button>
          </>
        }
      />
    </>
  );
}
