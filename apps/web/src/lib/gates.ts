import { GateCondition } from '@projectman/shared';
import type { LabelView } from '@projectman/shared';
import { t } from '../i18n/t';
import { labelName } from './labels';

/**
 * "Kell: Code review rendben", "Nem lehet rajta: Válaszra vár"; a condition that binds only some
 * cards says which: "Kell: Tervezői terv kész, ha Felületi".
 */
export function gateConditionText(condition: GateCondition, labels: readonly LabelView[]): string {
  const label = labelName(condition.label, labels);
  if (condition.when !== undefined) {
    const when = labelName(condition.when, labels);
    return condition.type === 'has_label'
      ? t('settings.pipeline.gateHasLabelWhen', { label, when })
      : t('settings.pipeline.gateLacksLabelWhen', { label, when });
  }
  return condition.type === 'has_label'
    ? t('settings.pipeline.gateHasLabel', { label })
    : t('settings.pipeline.gateLacksLabel', { label });
}

/**
 * Unmet conditions from a `gate_blocked` error (`details.unmet: [{ stageId, condition }]`) and the
 * approvals it still needs (`details.approvals: [{ stageId, label }]`: a label only a person may
 * set), as readable texts. Unknown shapes are skipped.
 */
export function unmetGateTexts(details: unknown, labels: readonly LabelView[]): string[] {
  if (!details || typeof details !== 'object') return [];
  const { unmet, approvals } = details as { unmet?: unknown; approvals?: unknown };
  const conditions = (Array.isArray(unmet) ? unmet : []).map(
    (entry) => (entry as { condition?: unknown } | null)?.condition,
  );
  const approved = (Array.isArray(approvals) ? approvals : []).map((entry) => ({
    type: 'has_label',
    label: (entry as { label?: unknown } | null)?.label,
  }));
  return [...conditions, ...approved].flatMap((condition) => {
    const parsed = GateCondition.safeParse(condition);
    return parsed.success ? [gateConditionText(parsed.data, labels)] : [];
  });
}
