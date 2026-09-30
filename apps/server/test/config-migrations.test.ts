import { describe, expect, it, vi } from 'vitest';
import { ProjectConfig, validateProjectConfig } from '@projectman/shared';
import { DAILY_WORKER_SCHEDULE } from '@projectman/templates';
import { migrateProjectConfig } from '../src/config/migrations';
import { testConfig } from './helpers/test-template';

/** The test configuration as a plain object, as it comes out of the YAML files. */
function raw(): {
  team: { members: Array<Record<string, unknown>> };
  pipeline: { stages: Array<Record<string, unknown>>; labels: Array<{ id: string }> };
} {
  return JSON.parse(JSON.stringify(testConfig()));
}

function migrate(config: unknown) {
  const warn = vi.fn();
  const migrated = migrateProjectConfig(config, { projectKey: 'AR', logger: { warn } });
  return { migrated, config: ProjectConfig.parse(migrated), warn };
}

describe('project configuration migrations', () => {
  it('passes a current configuration through untouched', () => {
    const current = raw();
    const { migrated, warn } = migrate(current);
    expect(migrated).toBe(current);
    expect(migrated).toEqual(raw());
    expect(warn).not.toHaveBeenCalled();
  });

  it('turns members of the removed scheduled role into maintainers with the daily schedule', () => {
    const legacy = raw();
    legacy.team.members[1] = { ...legacy.team.members[1], role: 'scheduled' };
    const evening = { cron: '0 18 * * *', prompt: 'Review the fictional backlog.' };
    legacy.team.members[2] = { ...legacy.team.members[2], role: 'scheduled', schedule: evening };
    const { config, warn } = migrate(legacy);
    expect(config.team.members[1]).toMatchObject({ role: 'maintainer', schedule: DAILY_WORKER_SCHEDULE });
    expect(config.team.members[2]).toMatchObject({ role: 'maintainer', schedule: evening });
    expect(warn).toHaveBeenCalledWith(
      { projectKey: 'AR', member: 'dev-1' },
      'Migrated legacy scheduled role to maintainer',
    );
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('reads a Codex member in bypassPermissions as acceptEdits and leaves Claude members alone', () => {
    const legacy = raw();
    legacy.team.members[1] = {
      ...legacy.team.members[1],
      provider: 'codex',
      permissionMode: 'bypassPermissions',
    };
    legacy.team.members[2] = {
      ...legacy.team.members[2],
      provider: 'claude',
      permissionMode: 'bypassPermissions',
    };
    legacy.team.members[3] = { ...legacy.team.members[3], permissionMode: 'bypassPermissions' };
    const { config, warn } = migrate(legacy);
    expect(config.team.members[1]).toMatchObject({ provider: 'codex', permissionMode: 'acceptEdits' });
    expect(config.team.members[2]).toMatchObject({ provider: 'claude', permissionMode: 'bypassPermissions' });
    expect(config.team.members[3]).toMatchObject({ permissionMode: 'bypassPermissions' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { projectKey: 'AR', member: 'dev-1' },
      'Migrated codex member from bypassPermissions to acceptEdits',
    );
    expect(validateProjectConfig(config).filter((issue) => issue.severity !== 'warning')).toEqual([]);
  });

  it.each(['default', 'acceptEdits', 'plan', 'auto'])('keeps %s for a Codex member', (permissionMode) => {
    const current = raw();
    current.team.members[1] = { ...current.team.members[1], provider: 'codex', permissionMode };
    const { config, warn } = migrate(current);
    expect(config.team.members[1]).toMatchObject({ permissionMode });
    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves a mode that is no permission mode to the schema', () => {
    const typo = raw();
    typo.team.members[1] = { ...typo.team.members[1], provider: 'codex', permissionMode: 'bypass' };
    const warn = vi.fn();
    const migrated = migrateProjectConfig(typo, { projectKey: 'AR', logger: { warn } });
    expect(ProjectConfig.safeParse(migrated).success).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('turns gate conditions from before labels into label conditions with defined labels', () => {
    const legacy = raw();
    legacy.pipeline.labels = legacy.pipeline.labels.filter((label) =>
      ['merge-ok', 'release-ok', 'waiting'].includes(label.id),
    );
    const stage = (id: string) => legacy.pipeline.stages.find((s) => s.id === id)!;
    stage('merge').gate = {
      conditions: [
        { type: 'check_passed', check: 'code_review' },
        { type: 'human_approval', approvers: ['owner'] },
      ],
    };
    stage('release').gate = {
      conditions: [{ type: 'pr_merged' }, { type: 'human_approval', duty: 'release_approval' }],
    };
    const { config } = migrate(legacy);
    const gate = (id: string) => config.pipeline.stages.find((s) => s.id === id)!.gate!.conditions;
    expect(gate('merge')).toEqual([
      { type: 'has_label', label: 'code-review-ok' },
      { type: 'has_label', label: 'approval-merge' },
    ]);
    expect(gate('release')).toEqual([
      { type: 'has_label', label: 'pr-merged' },
      { type: 'has_label', label: 'release-approved' },
    ]);
    expect(config.pipeline.labels.find((label) => label.id === 'approval-merge')).toMatchObject({
      setBy: { members: ['owner'], humansOnly: true },
    });
    expect(config.pipeline.labels.map((label) => label.id)).toEqual(
      expect.arrayContaining(['code-review-ok', 'code-review-changes', 'pr-merged', 'release-approved']),
    );
  });

  it('leaves stage kinds from before decision 18 to the pipeline schema', () => {
    const legacy = raw();
    legacy.pipeline.stages.find((s) => s.id === 'code_review')!.kind = 'review';
    const { migrated, config } = migrate(legacy);
    expect(migrated).toBe(legacy);
    expect(config.pipeline.stages.find((s) => s.id === 'code_review')!.kind).toBe('step');
    expect(validateProjectConfig(config).filter((issue) => issue.severity !== 'warning')).toEqual([]);
  });
});
