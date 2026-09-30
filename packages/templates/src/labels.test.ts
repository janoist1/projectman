import {
  DEFAULT_PROJECT_LANGUAGE,
  isReleaseApprovalLabel,
  labelDefinition,
  ProjectConfig,
  releaseGateAccepts,
  validateProjectConfig,
} from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import { legacyCheckLabels, migrateLegacyConfig, standardLabelsFor } from './labels';
import { getLocale } from './locales';
import { templates } from './index';

function legacyConfig() {
  const config = JSON.parse(
    JSON.stringify(
      templates[0]!.build({
        key: 'AC',
        name: 'Acme',
        workspacePath: '/tmp/acme',
        language: 'hu',
        owner: { handle: 'owner', displayName: 'Owner', email: 'owner@example.test' },
      }),
    ),
  );
  // Rewrite the gates as they were stored before labels.
  config.pipeline.labels = [];
  for (const stage of config.pipeline.stages) {
    if (!stage.gate) continue;
    stage.gate.conditions = stage.gate.conditions.map((c: { label: string }) =>
      c.label === 'code-review-ok'
        ? { type: 'check_passed', check: 'code_review' }
        : c.label === 'qa-ok'
          ? { type: 'check_passed', check: 'qa' }
          : c.label === 'client-accepted'
            ? { type: 'check_passed', check: 'client_test' }
            : c.label === 'merge-approved'
              ? { type: 'human_approval', approvers: ['owner'] }
              : { type: 'human_approval', duty: 'release_approval' },
    );
  }
  return config;
}

describe('labels', () => {
  it('ships whole groups and "waiting for an answer" in the locale of the project', () => {
    const labels = standardLabelsFor(['qa-ok'], getLocale('hu'));
    expect(labels.map((l) => l.id)).toEqual(['qa-ok', 'qa-failed', 'qa-retest', 'waiting-answer']);
    expect(labels[1]).toMatchObject({ name: 'QA: hibás', requiresComment: true, notifyAssignee: true });
  });

  it('turns legacy gates into label gates with the labels they need', () => {
    const migrated = migrateLegacyConfig(legacyConfig());
    const config = ProjectConfig.parse(migrated);
    const gate = (id: string) => config.pipeline.stages.find((s) => s.id === id)!.gate!.conditions;
    expect(gate('integration')).toEqual([{ type: 'has_label', label: 'code-review-ok' }]);
    expect(gate('merge')).toEqual([
      { type: 'has_label', label: 'client-accepted' },
      { type: 'has_label', label: 'approval-merge' },
    ]);
    expect(gate('release')).toEqual([{ type: 'has_label', label: 'release-approved' }]);
    const approval = config.pipeline.labels.find((l) => l.id === 'approval-merge');
    expect(approval).toMatchObject({
      name: 'Merge: jóváhagyva',
      setBy: { members: ['owner'], humansOnly: true },
    });
    expect(config.pipeline.labels.map((l) => l.id)).toEqual(
      expect.arrayContaining(['code-review-changes', 'qa-failed', 'client-changes', 'release-approved']),
    );
    expect(validateProjectConfig(config).filter((i) => i.severity !== 'warning')).toEqual([]);
    // Idempotent, and a current configuration passes through untouched.
    expect(migrateLegacyConfig(migrated)).toBe(migrated);
  });

  it('turns a legacy release approval on the release approval duty into a label that passes a release gate', () => {
    const config = ProjectConfig.parse(migrateLegacyConfig(legacyConfig()));
    const release = config.pipeline.stages.find((stage) => stage.kind === 'release')!;
    expect(release.gate).toEqual({ conditions: [{ type: 'has_label', label: 'release-approved' }] });
    const approval = labelDefinition(config, 'release-approved')!;
    expect(approval.setBy).toEqual({ duties: ['release_approval'], humansOnly: true });
    expect(isReleaseApprovalLabel(approval)).toBe(true);
    expect(releaseGateAccepts(approval)).toBe(true);
    // The merge step's approval names members: it would not pass a release gate, and sits on a step, which the rule leaves alone.
    expect(releaseGateAccepts(labelDefinition(config, 'approval-merge')!)).toBe(false);
    expect(validateProjectConfig(config).filter((issue) => issue.severity !== 'warning')).toEqual([]);
  });

  it('names the labels in the default project language when the configuration has none', () => {
    const legacy = legacyConfig();
    delete legacy.project.language;
    const config = ProjectConfig.parse(migrateLegacyConfig(legacy));
    expect(config.project.language).toBe(DEFAULT_PROJECT_LANGUAGE);
    const locale = getLocale(DEFAULT_PROJECT_LANGUAGE);
    const label = (id: string) => config.pipeline.labels.find((l) => l.id === id)?.name;
    const merge = config.pipeline.stages.find((s) => s.id === 'merge')!;
    expect(label('approval-merge')).toBe(locale.stageApproval(merge.name));
    expect(label('qa-failed')).toBe(locale.labels['qa-failed'].name);
    expect(label('release-approved')).toBe(locale.labels['release-approved'].name);
    expect(label('qa-failed')).not.toBe(getLocale('en').labels['qa-failed'].name);
  });

  it('maps recorded checks to labels, pending ones to none', () => {
    expect(
      legacyCheckLabels({
        code_review: 'passed',
        qa: 'retest_needed',
        client_test: 'pending',
        unknown: 'passed',
      }),
    ).toEqual(['code-review-ok', 'qa-retest']);
    expect(legacyCheckLabels(undefined)).toEqual([]);
  });
});
