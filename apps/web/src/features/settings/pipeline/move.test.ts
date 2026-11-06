import { describe, expect, it } from 'vitest';
import { t } from '../../../i18n/t';
import { buildConfig } from '../../../mocks/fixtures';
import { moveStage } from './flow';
import { columnMovePlan, moveRefusal, stageMovePlan } from './move';

const config = buildConfig();

describe('moveRefusal', () => {
  it('forbids an order that brings a new error', () => {
    const moved = moveStage(config.pipeline, 'dev', { index: 0, columnId: 'ready' });
    expect(moveRefusal(config, moved, true)).toBeTruthy();
  });

  it('allows an order that brings none', () => {
    const moved = moveStage(config.pipeline, 'qa', { index: 2, columnId: 'review' });
    expect(moveRefusal(config, moved, true)).toBeNull();
  });

  it('refuses an owner-only change to a member who is not the owner', () => {
    // An approval label on another stage's gate changes the approval policy, which only the owner may.
    const changed = {
      ...config.pipeline,
      stages: config.pipeline.stages.map((stage) =>
        stage.id === 'dev'
          ? { ...stage, gate: { conditions: [{ type: 'has_label' as const, label: 'release-approved' }] } }
          : stage,
      ),
    };
    expect(moveRefusal(config, changed, false)).toBe(t('settings.edit.approvalOwnerOnly'));
    expect(moveRefusal(config, changed, true)).toBeNull();
  });
});

describe('stageMovePlan', () => {
  it('names the column the stage joins at the edge of a run', () => {
    expect(stageMovePlan(config, 'qa', 'down', true).columnName).toBe('Ügyfélteszt');
    expect(stageMovePlan(config, 'qa', 'up', true).columnName).toBeNull();
  });

  it('gives a reason, and no move, at the ends of the pipeline', () => {
    const plan = stageMovePlan(config, 'ready', 'up', true);
    expect(plan.pipeline).toBeNull();
    expect(plan.reason).toBe(t('settings.pipeline.move.firstStage'));
  });
});

describe('columnMovePlan', () => {
  it('gives a reason, and no move, for a column at the end', () => {
    expect(columnMovePlan(config, 'done', 'down', true).reason).toBe(t('settings.pipeline.move.columnLast'));
  });
});
