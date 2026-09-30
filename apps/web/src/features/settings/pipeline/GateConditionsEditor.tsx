import { isHumanOnlyLabel } from '@projectman/shared';
import type { GateCondition, LabelDefinition } from '@projectman/shared';
import { Button } from '../../../components/Button';
import { t } from '../../../i18n/t';
import shared from '../settings.module.css';

/** An approval: a label only humans may set. */
export function isApprovalLabel(labels: readonly LabelDefinition[], id: string): boolean {
  const label = labels.find((entry) => entry.id === id);
  return label !== undefined && isHumanOnlyLabel(label);
}

/** A stage's gate: label conditions that must hold before a task may enter the stage. */
export function GateConditionsEditor({
  conditions,
  labels,
  isOwner,
  onChange,
}: {
  conditions: readonly GateCondition[];
  labels: readonly LabelDefinition[];
  isOwner: boolean;
  onChange: (next: GateCondition[]) => void;
}) {
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
                    disabled={!isOwner && isHumanOnlyLabel(label) && label.id !== condition.label}
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
      {labels.length > 0 ? (
        <Button
          variant="secondary"
          onClick={() => onChange([...conditions, { type: 'has_label', label: labels[0]!.id }])}
        >
          {t('settings.edit.addCondition')}
        </Button>
      ) : (
        <p className={shared.muted}>{t('settings.edit.noLabels')}</p>
      )}
    </fieldset>
  );
}
