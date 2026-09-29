import { GateCondition } from '@projectman/shared';
import { joinNames, t } from '../i18n/t';
import { namesOf } from './members';
import type { MemberIndex } from './members';

/** "Code review rendben", "PR merge-elve", "Jóváhagyja: Te". */
export function gateConditionText(
  condition: GateCondition,
  members: MemberIndex,
  myHandle: string | null,
): string {
  switch (condition.type) {
    case 'check_passed':
      return t('settings.pipeline.gateCheck', { check: t(`checks.names.${condition.check}`) });
    case 'pr_merged':
      return t('settings.pipeline.gatePrMerged');
    case 'human_approval':
      return t('settings.pipeline.gateApproval', {
        approvers: joinNames(namesOf(condition.approvers ?? [], members, myHandle)),
      });
  }
}

/**
 * Unmet conditions from a `gate_blocked` error (`details.unmet: [{ stageId, condition }]`),
 * as readable texts. Unknown shapes are skipped.
 */
export function unmetGateTexts(details: unknown, members: MemberIndex, myHandle: string | null): string[] {
  if (!details || typeof details !== 'object') return [];
  const unmet = (details as { unmet?: unknown }).unmet;
  if (!Array.isArray(unmet)) return [];
  return unmet.flatMap((entry) => {
    const parsed = GateCondition.safeParse((entry as { condition?: unknown } | null)?.condition);
    return parsed.success ? [gateConditionText(parsed.data, members, myHandle)] : [];
  });
}
