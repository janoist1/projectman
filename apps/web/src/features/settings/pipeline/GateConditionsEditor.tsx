import { gateAcceptsCondition, gateAcceptsWhen, isHumanOnlyLabel } from '@projectman/shared';
import type { GateCondition, LabelDefinition, Stage } from '@projectman/shared';
import { Button } from '../../../components/Button';
import { t } from '../../../i18n/t';
import shared from '../settings.module.css';

/** An approval: a label only humans may set. */
export function isApprovalLabel(labels: readonly LabelDefinition[], id: string): boolean {
  const label = labels.find((entry) => entry.id === id);
  return label !== undefined && isHumanOnlyLabel(label);
}

/**
 * A stage's gate: label conditions that must hold before a task may enter the stage. A release
 * stage's gate takes the release approval only as approval (the shared rule the server enforces).
 */
export function GateConditionsEditor({
  stage,
  conditions,
  labels,
  isOwner,
  onChange,
}: {
  stage: Pick<Stage, 'kind'>;
  conditions: readonly GateCondition[];
  labels: readonly LabelDefinition[];
  isOwner: boolean;
  onChange: (next: GateCondition[]) => void;
}) {
  const accepts = (condition: Pick<GateCondition, 'type' | 'when'>, label: LabelDefinition) =>
    gateAcceptsCondition(stage, condition, label);
  // An unknown label (e.g. from an older file) stays selectable so it can be replaced.
  const labelOptions = (current: string) =>
    labels.some((label) => label.id === current)
      ? labels
      : [...labels, { id: current, name: current, setBy: 'anyone' as const }];
  return (
    <fieldset className={shared.conditions}>
      <legend>{t('settings.pipeline.gate')}</legend>
      {conditions.map((condition, conditionIndex) => {
        // Approvals (labels only humans may set) are the owner's to change.
        const locked = isApprovalLabel(labels, condition.label) && !isOwner;
        const replace = (next: GateCondition) =>
          onChange(conditions.map((value, i) => (i === conditionIndex ? next : value)));
        return (
          <div key={conditionIndex} className={shared.condition}>
            <label className={shared.field}>
              {t('settings.edit.condition')}
              <select
                value={condition.type}
                disabled={locked}
                onChange={(event) =>
                  replace({ ...condition, type: event.target.value as GateCondition['type'] })
                }
              >
                <option value="has_label">{t('settings.edit.hasLabel')}</option>
                <option value="lacks_label">{t('settings.edit.lacksLabel')}</option>
              </select>
            </label>
            <label className={shared.field}>
              {t('settings.edit.label')}
              <select
                value={condition.label}
                disabled={locked}
                onChange={(event) => replace({ ...condition, label: event.target.value })}
              >
                {labelOptions(condition.label).map((label) => (
                  <option
                    key={label.id}
                    value={label.id}
                    disabled={
                      label.id !== condition.label &&
                      ((!isOwner && isHumanOnlyLabel(label)) || !accepts(condition, label))
                    }
                  >
                    {label.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={shared.field}>
              {t('settings.edit.when')}
              <select
                value={condition.when ?? ''}
                disabled={locked}
                onChange={(event) => {
                  const { when: _previous, ...rest } = condition;
                  replace(event.target.value ? { ...rest, when: event.target.value } : rest);
                }}
              >
                <option value="">{t('settings.edit.whenAny')}</option>
                {labelOptions(condition.when ?? '')
                  .filter((label) => label.id !== '')
                  .map((label) => (
                    <option
                      key={label.id}
                      value={label.id}
                      disabled={label.id !== condition.when && !gateAcceptsWhen(stage, { when: label.id })}
                    >
                      {label.name}
                    </option>
                  ))}
              </select>
            </label>
            {locked ? <p className={shared.muted}>{t('settings.edit.approvalOwnerOnly')}</p> : null}
            <Button
              variant="secondary"
              disabled={locked}
              onClick={() => onChange(conditions.filter((_, i) => i !== conditionIndex))}
            >
              {t('settings.edit.removeCondition')}
            </Button>
          </div>
        );
      })}
      {stage.kind === 'release' ? (
        <p className={shared.muted}>{t('settings.edit.releaseApprovalOnly')}</p>
      ) : null}
      {labels.length > 0 ? (
        <Button
          variant="secondary"
          onClick={() => {
            const added = { type: 'has_label' } as const;
            const label = labels.find((entry) => accepts(added, entry)) ?? labels[0]!;
            onChange([...conditions, { ...added, label: label.id }]);
          }}
        >
          {t('settings.edit.addCondition')}
        </Button>
      ) : (
        <p className={shared.muted}>{t('settings.edit.noLabels')}</p>
      )}
    </fieldset>
  );
}
