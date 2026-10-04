import { describe, expect, it } from 'vitest';
import { templates } from '@projectman/templates';
import { LabelDefinition } from '../domain/label';
import { teamRules, TEAM_RULE_IDS } from './team-rules';

function sampleConfig() {
  return templates[0]!.build({
    key: 'AC',
    name: 'Acme',
    workspacePath: '/work/acme',
    language: 'en',
    owner: { handle: 'owner', displayName: 'Owner', email: 'owner@example.com' },
  });
}

describe('teamRules', () => {
  it.each(templates)('derives applicable rules for $id in catalogue order', (template) => {
    const config = template.build({
      key: 'AC',
      name: 'Acme',
      workspacePath: '/work/acme',
      language: 'en',
      owner: { handle: 'owner', displayName: 'Owner', email: 'owner@example.com' },
    });
    const rules = teamRules(config);
    expect(rules.map((rule) => rule.id)).toEqual(
      TEAM_RULE_IDS.filter((id) => rules.some((rule) => rule.id === id)),
    );
    expect(rules[0]).toEqual({
      id: 'new_card',
      firstStageId: config.pipeline.stages[0]!.id,
      minimumAccess: 'developer',
    });
    expect(rules.find((rule) => rule.id === 'gates_in_order')).toEqual({
      id: 'gates_in_order',
      clearedOnMoveBack: config.pipeline.labels
        .filter((label) => label.clearedWhen?.includes('moved_back'))
        .map((label) => label.id),
    });
  });

  it('keeps only universal rules without labels or refinement stages and falls back to owners', () => {
    const config = sampleConfig();
    config.pipeline.labels = [];
    config.team.members = config.team.members.filter((member) => member.kind === 'human');
    config.team.members.forEach((member) => {
      if (member.kind === 'human') member.roles = [];
    });
    config.team.limits.maxFixRounds = 5;
    expect(teamRules(config)).toEqual([
      { id: 'new_card', firstStageId: config.pipeline.stages[0]!.id, minimumAccess: 'developer' },
      { id: 'gates_in_order', clearedOnMoveBack: [] },
      { id: 'fix_limit', limit: 5, labels: [], lead: null, deciders: ['owner'] },
    ]);
  });

  it('collects refinement requirements in gate order, once, excluding system labels', () => {
    const config = sampleConfig();
    config.pipeline.labels.push(
      ...['refine', 'scope-ok', 'analysis-ok', 'design-ok', 'plan-ok']
        .filter((id) => !config.pipeline.labels.some((label) => label.id === id))
        .map((id) => LabelDefinition.parse({ id, name: id })),
    );
    config.pipeline.labels.push(
      LabelDefinition.parse({ id: 'system-fact', name: 'System fact', setBy: 'system' }),
    );
    config.pipeline.stages[0]!.gate = { conditions: [{ type: 'has_label', label: 'scope-ok' }] };
    const work = config.pipeline.stages.find((stage) => stage.kind === 'work')!;
    work.gate = {
      conditions: ['scope-ok', 'analysis-ok', 'design-ok', 'plan-ok', 'system-fact'].map((label) => ({
        type: 'has_label',
        label,
      })),
    };
    expect(teamRules(config).find((rule) => rule.id === 'refinement')).toMatchObject({
      steps: ['scope-ok', 'analysis-ok', 'design-ok', 'plan-ok'],
      workStageId: work.id,
    });
    config.pipeline.stages = config.pipeline.stages.filter((stage) => stage.kind !== 'work');
    expect(teamRules(config).some((rule) => rule.id === 'refinement')).toBe(false);
  });
});
