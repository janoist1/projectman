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
 * Unmet conditions from a `gate_blocked` error (`details.unmet: [{ stageId, condition }]`),
 * as readable texts. Unknown shapes are skipped.
 */
export function unmetGateTexts(details: unknown, labels: readonly LabelView[]): string[] {
  if (!details || typeof details !== 'object') return [];
  const unmet = (details as { unmet?: unknown }).unmet;
  if (!Array.isArray(unmet)) return [];
  return unmet.flatMap((entry) => {
    const parsed = GateCondition.safeParse((entry as { condition?: unknown } | null)?.condition);
    return parsed.success ? [gateConditionText(parsed.data, labels)] : [];
  });
}
