import type { Stage } from '../domain/pipeline';
import { isHandleOnLeave } from './leave';
import { labelDefinition, labelSetters } from './labels';
import type { ProjectConfig } from './schema';

/**
 * A thing worth knowing about a stage's small-card owners that does not make the rule invalid (PM-1378 C):
 * the owner cannot set a label the next gate asks for, so could not pass the card on; or the owner is on leave.
 */
export type SmallCardsWarning =
  { code: 'cannot_set_label'; member: string; label: string } | { code: 'on_leave'; member: string };

/**
 * The warnings of the stage's small-card rule, in the order of its owners: leave first, then each label of the
 * next stage's gate (the ones every card needs) the owner may not set. Empty without a rule or a next stage.
 */
export function smallCardsWarnings(
  config: Pick<ProjectConfig, 'team' | 'pipeline'>,
  stage: Stage,
): SmallCardsWarning[] {
  const rule = stage.smallCards;
  if (!rule) return [];
  const stages = config.pipeline.stages;
  const next = stages[stages.findIndex((candidate) => candidate.id === stage.id) + 1];
  const labels = [
    ...new Set(
      (next?.gate?.conditions ?? []).flatMap((condition) =>
        condition.type === 'has_label' && condition.when === undefined ? [condition.label] : [],
      ),
    ),
  ];
  return rule.owners.flatMap((member): SmallCardsWarning[] => {
    const warnings: SmallCardsWarning[] = [];
    if (isHandleOnLeave(config, member)) warnings.push({ code: 'on_leave', member });
    for (const label of labels) {
      const definition = labelDefinition(config, label);
      if (definition && !labelSetters(config, definition, { assignee: null, links: [] }).includes(member))
        warnings.push({ code: 'cannot_set_label', member, label });
    }
    return warnings;
  });
}
