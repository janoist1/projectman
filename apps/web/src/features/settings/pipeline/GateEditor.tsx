import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { gateAcceptsCondition, gateAcceptsWhen, isHumanOnlyLabel } from '@projectman/shared';
import type { GateCondition, LabelDefinition, StageKind } from '@projectman/shared';
import { Icon } from '../../../components/Icon';
import { t } from '../../../i18n/t';
import { FieldErrors } from '../edit/FieldErrors';
import type { FieldIssue } from '../edit/FieldErrors';
import styles from './GateEditor.module.css';

interface GateEditorProps {
  stageKind: StageKind;
  /** `when` is '' while "ha a kártyán van:" is chosen and no label is picked yet. */
  conditions: readonly GateCondition[];
  labels: readonly LabelDefinition[];
  isOwner: boolean;
  disabled?: boolean;
  /** The refusals at one condition's row. */
  rowIssues(index: number): readonly FieldIssue[];
  /** The refusals at the gate as a whole. */
  gateIssues: readonly FieldIssue[];
  onChange(next: GateCondition[]): void;
}

/**
 * A stage's entry condition as sentences, one per row: [Kell|Nem lehet rajta] [label] [on every card|
 * if the card has:] [label]. A release gate takes only the release approval, on every card; someone who
 * is not an owner sees the approval rows locked and cannot pick another approval label.
 */
export function GateEditor({
  stageKind,
  conditions,
  labels,
  isOwner,
  disabled = false,
  rowIssues,
  gateIssues,
  onChange,
}: GateEditorProps) {
  const root = useRef<HTMLFieldSetElement>(null);
  const [added, setAdded] = useState<number | null>(null);
  const release = stageKind === 'release';
  useEffect(() => {
    if (added === null) return;
    root.current?.querySelector<HTMLElement>(`[data-label-select="${added}"]`)?.focus();
    setAdded(null);
  }, [added]);

  const byId = new Map(labels.map((label) => [label.id, label]));
  const humanOnly = (id: string) => {
    const label = byId.get(id);
    return label !== undefined && isHumanOnlyLabel(label);
  };
  // An unknown label (e.g. from an older file) stays selectable so it can be replaced.
  const choices = (current: string, accepts: (label: LabelDefinition) => boolean) => {
    const list = labels.filter(
      (label) => label.id === current || ((isOwner || !isHumanOnlyLabel(label)) && accepts(label)),
    );
    return current && !byId.has(current)
      ? [...list, { id: current, name: current, setBy: 'anyone' as const }]
      : list;
  };
  const replace = (index: number, next: GateCondition) =>
    onChange(conditions.map((value, i) => (i === index ? next : value)));

  return (
    <fieldset ref={root} className={styles.gate} disabled={disabled}>
      <legend className={styles.legend}>{t('settings.pipeline.fields.gate')}</legend>
      {release ? <p className={styles.rule}>{t('settings.pipeline.edit.releaseRule')}</p> : null}
      {conditions.length === 0 ? <p className={styles.none}>{t('settings.pipeline.noGate')}</p> : null}
      {conditions.map((condition, index) => {
        const locked = !isOwner && humanOnly(condition.label);
        const withWhen = condition.when !== undefined;
        const accepts = (label: LabelDefinition) =>
          gateAcceptsCondition({ kind: stageKind }, condition, label);
        return (
          <div key={index} className={styles.rowBox}>
            <div className={clsx(styles.row, locked && styles.locked)}>
              {locked ? (
                <span className={styles.padlock} title={t('settings.edit.approvalOwnerOnly')}>
                  <Icon name="lock" size={14} />
                </span>
              ) : null}
              <div className={styles.fields}>
                <select
                  aria-label={t('settings.edit.condition')}
                  value={condition.type}
                  disabled={locked}
                  onChange={(event) =>
                    replace(index, { ...condition, type: event.target.value as GateCondition['type'] })
                  }
                >
                  <option value="has_label">{t('settings.pipeline.edit.gateHas')}</option>
                  <option value="lacks_label">{t('settings.pipeline.edit.gateLacks')}</option>
                </select>
                <select
                  aria-label={t('settings.edit.label')}
                  className={styles.labelSelect}
                  data-label-select={index}
                  value={condition.label}
                  disabled={locked}
                  onChange={(event) => replace(index, { ...condition, label: event.target.value })}
                >
                  {condition.label === '' ? (
                    <option value="">{t('settings.pipeline.edit.pickLabel')}</option>
                  ) : null}
                  {choices(condition.label, accepts).map((label) => (
                    <option key={label.id} value={label.id}>
                      {label.name}
                    </option>
                  ))}
                </select>
                {/* A release gate takes no "when"; a leftover one can still be switched off. */}
                {release && !withWhen ? null : (
                  <>
                    <select
                      aria-label={t('settings.edit.when')}
                      value={withWhen ? 'when' : 'every'}
                      disabled={locked}
                      onChange={(event) => {
                        const { when: _previous, ...rest } = condition;
                        replace(index, event.target.value === 'when' ? { ...rest, when: '' } : rest);
                      }}
                    >
                      <option value="every">{t('settings.pipeline.edit.gateEvery')}</option>
                      <option value="when" disabled={!gateAcceptsWhen({ kind: stageKind }, { when: 'x' })}>
                        {t('settings.pipeline.edit.gateWhen')}
                      </option>
                    </select>
                    {withWhen ? (
                      <select
                        className={styles.labelSelect}
                        aria-label={t('settings.pipeline.edit.gateWhen')}
                        value={condition.when}
                        disabled={locked}
                        onChange={(event) => replace(index, { ...condition, when: event.target.value })}
                      >
                        {condition.when === '' ? (
                          <option value="">{t('settings.pipeline.edit.pickLabel')}</option>
                        ) : null}
                        {choices(condition.when ?? '', () => true).map((label) => (
                          <option key={label.id} value={label.id}>
                            {label.name}
                          </option>
                        ))}
                      </select>
                    ) : null}
                  </>
                )}
              </div>
              <button
                type="button"
                className={styles.remove}
                aria-label={t('settings.pipeline.edit.removeCondition')}
                title={t('settings.pipeline.edit.removeCondition')}
                disabled={locked}
                onClick={() => onChange(conditions.filter((_, i) => i !== index))}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
            {locked ? <p className={styles.lockNote}>{t('settings.edit.approvalOwnerOnly')}</p> : null}
            <FieldErrors issues={rowIssues(index)} />
          </div>
        );
      })}
      <FieldErrors issues={gateIssues} />
      {labels.length > 0 ? (
        <button
          type="button"
          className={styles.add}
          onClick={() => {
            onChange([...conditions, { type: 'has_label', label: '' }]);
            setAdded(conditions.length);
          }}
        >
          {t('settings.pipeline.edit.addCondition')}
        </button>
      ) : (
        <p className={styles.none}>{t('settings.edit.noLabels')}</p>
      )}
    </fieldset>
  );
}
