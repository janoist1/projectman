import { describe, expect, it, vi } from 'vitest';
import {
  BUILT_IN_ROLE_DUTIES,
  isOperator,
  isToleratedOnLoad,
  ProjectConfig,
  projectManagersOf,
  validateProjectConfig,
} from '@projectman/shared';
import { DAILY_WORKER_SCHEDULE } from '@projectman/templates';
import { migrateProjectConfig } from '../src/config/migrations';
import { testConfig } from './helpers/test-template';

/** The test configuration as a plain object, as it comes out of the YAML files. */
function raw(): {
  team: { members: Array<Record<string, unknown>> };
  pipeline: { stages: Array<Record<string, unknown>>; labels: Array<{ id: string; setBy?: unknown }> };
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

  it('drops the removed message storm threshold without carrying its value over (PM-261)', () => {
    const legacy = raw();
    Object.assign((legacy.team as { limits?: object }).limits ?? {}, {
      messageBurst: { count: 3, minutes: 5 },
    });
    const { migrated, config, warn } = migrate(legacy);
    expect(JSON.stringify(migrated)).not.toContain('messageBurst');
    expect(config.team.limits.loopWatch).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      { projectKey: 'AR' },
      'Dropped the removed message storm threshold from the team limits',
    );
    expect(warn).toHaveBeenCalledTimes(1);
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

describe('release approval migration (decision 19)', () => {
  const errorsOf = (config: ProjectConfig) =>
    validateProjectConfig(config).filter((issue) => issue.severity !== 'warning');
  const label = (config: { pipeline: { labels: Array<{ id: string; setBy?: unknown }> } }, id: string) =>
    config.pipeline.labels.find((entry) => entry.id === id)!;
  const releaseApproval = { duties: ['release_approval'], humansOnly: true };

  it.each<[string, unknown]>([
    ['every human', 'humans'],
    ['a named member', { members: ['owner'], humansOnly: true }],
    ['the holders of another duty', { duties: ['final_decision'], humansOnly: true }],
    [
      'the release approval duty and another',
      { duties: ['release_approval', 'final_decision'], humansOnly: true },
    ],
    [
      'the release approval duty and a named member',
      { duties: ['release_approval'], members: ['owner'], humansOnly: true },
    ],
  ])('narrows a release approval that %s may set to the release approval duty', (_name, setBy) => {
    const legacy = raw();
    label(legacy, 'release-ok').setBy = setBy;
    const { config, warn } = migrate(legacy);
    expect(label(config, 'release-ok').setBy).toEqual(releaseApproval);
    expect(errorsOf(config)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { projectKey: 'AR', label: 'release-ok', releaseStages: ['release'], otherStages: [], setBy },
      'Narrowed release approval label to the release approval duty',
    );
  });

  it('leaves the other labels, and so the approvals of other stages, as they are', () => {
    const legacy = raw();
    label(legacy, 'release-ok').setBy = 'humans';
    const others = legacy.pipeline.labels.filter((entry) => entry.id !== 'release-ok');
    const before = structuredClone(others);
    const { migrated, warn } = migrate(legacy);
    // The merge approval names the owner and stays so; the release gate's other label is the system's.
    expect(label(legacy, 'merge-ok').setBy).toEqual({ members: ['owner'], humansOnly: true });
    expect((migrated as typeof legacy).pipeline.labels.filter((entry) => entry.id !== 'release-ok')).toEqual(
      before,
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('narrows a label that another stage requires too, and says which', () => {
    const legacy = raw();
    label(legacy, 'release-ok').setBy = { members: ['owner'], humansOnly: true };
    const merge = legacy.pipeline.stages.find((stage) => stage.id === 'merge')!;
    (merge.gate as { conditions: unknown[] }).conditions.push({ type: 'has_label', label: 'release-ok' });
    const { config, warn } = migrate(legacy);
    expect(label(config, 'release-ok').setBy).toEqual(releaseApproval);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'release-ok', releaseStages: ['release'], otherStages: ['merge'] }),
      'Narrowed release approval label to the release approval duty',
    );
  });

  it('narrows the approval a legacy release gate named members for, after converting the gate', () => {
    const legacy = raw();
    legacy.pipeline.labels = legacy.pipeline.labels.filter((entry) => entry.id !== 'release-ok');
    const release = legacy.pipeline.stages.find((stage) => stage.id === 'release')!;
    release.gate = { conditions: [{ type: 'human_approval', approvers: ['owner'] }] };
    const { config, warn } = migrate(legacy);
    expect(config.pipeline.stages.find((stage) => stage.id === 'release')!.gate).toEqual({
      conditions: [{ type: 'has_label', label: 'approval-release' }],
    });
    // The converted label named the owner; it now belongs to the release approval duty.
    expect(label(config, 'approval-release').setBy).toEqual(releaseApproval);
    expect(errorsOf(config)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('leaves a label as it is when nobody holds the duty, so the project still loads', () => {
    const legacy = raw();
    legacy.team.members[0] = { ...legacy.team.members[0], roles: [] };
    const setBy = { members: ['owner'], humansOnly: true };
    label(legacy, 'release-ok').setBy = setBy;
    const { config, warn } = migrate(legacy);
    expect(label(config, 'release-ok').setBy).toEqual(setBy);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ projectKey: 'AR', label: 'release-ok', setBy }),
      expect.stringContaining('nobody holds the duty'),
    );
    // What is left breaks only the rule a stored configuration may still break.
    const errors = errorsOf(config);
    expect(errors.map((issue) => issue.code)).toEqual(['release_approval_needs_duty']);
    expect(errors.every(isToleratedOnLoad)).toBe(true);
  });

  describe('the required project manager (PM-429)', () => {
    const withoutProjectManager = () => {
      const legacy = raw();
      legacy.team.members = legacy.team.members.filter((m) => m.role !== 'project_manager');
      return legacy;
    };

    it('adds a project manager on leave, sponsored by the first human owner, to a project without one', () => {
      const { migrated, config, warn } = migrate(withoutProjectManager());
      expect(projectManagersOf(config)).toHaveLength(1);
      expect(config.team.members.at(-1)).toMatchObject({
        kind: 'ai',
        handle: 'pm',
        role: 'project_manager',
        displayName: 'Project manager',
        sponsor: 'owner',
        onLeave: true,
        temp: false,
      });
      expect(validateProjectConfig(config).filter((i) => i.severity !== 'warning')).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        { projectKey: 'AR', member: 'pm' },
        'Added the required project manager, on leave',
      );
      expect(migrated).toBeDefined();
    });

    it('takes the next free handle and the project language', () => {
      const legacy = withoutProjectManager();
      legacy.team.members.push({
        kind: 'ai',
        handle: 'pm',
        displayName: 'Pm',
        role: 'developer',
        sponsor: 'owner',
      });
      (legacy as unknown as { project: Record<string, unknown> }).project.language = 'hu';
      const { config } = migrate(legacy);
      expect(config.team.members.at(-1)).toMatchObject({ handle: 'pm-2', displayName: 'Projektmenedzser' });
    });

    it('adds one when the only project manager is a temp worker', () => {
      const legacy = withoutProjectManager();
      legacy.team.members.push({
        kind: 'ai',
        handle: 'pm',
        displayName: 'Pm',
        role: 'project_manager',
        sponsor: 'owner',
        temp: true,
      });
      const { config } = migrate(legacy);
      expect(projectManagersOf(config)).toHaveLength(1);
      expect(projectManagersOf(config)[0]!.handle).toBe('pm-2');
    });

    it('changes nothing where an AI project manager exists, on leave or not', () => {
      for (const onLeave of [true, false]) {
        const current = raw();
        current.team.members.find((m) => m.role === 'project_manager')!.onLeave = onLeave;
        const before = JSON.parse(JSON.stringify(current));
        const { migrated, warn } = migrate(current);
        expect(migrated).toBe(current);
        expect(migrated).toEqual(before);
        expect(warn).not.toHaveBeenCalled();
      }
    });

    it('adds nothing without a human owner', () => {
      const legacy = withoutProjectManager();
      for (const member of legacy.team.members) if (member.kind === 'human') member.access = 'admin';
      const { migrated, warn } = migrate(legacy);
      expect(projectManagersOf(ProjectConfig.parse(migrated))).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('is done once', () => {
      const { migrated } = migrate(withoutProjectManager());
      const again = vi.fn();
      expect(migrateProjectConfig(migrated, { projectKey: 'AR', logger: { warn: again } })).toBe(migrated);
      expect(again).not.toHaveBeenCalled();
    });
  });

  describe('the Operator every project has (PM-447)', () => {
    const operators = (config: ProjectConfig) => config.team.members.filter((m) => isOperator(m));
    const withoutOperator = () => {
      const legacy = raw();
      legacy.team.members = legacy.team.members.filter((m) => m.role !== 'ai_operator');
      return legacy;
    };

    it('adds an Operator at work, sponsored by the first human owner, to a project without one', () => {
      const { config, warn } = migrate(withoutOperator());
      expect(operators(config)).toHaveLength(1);
      expect(config.team.members.at(-1)).toMatchObject({
        kind: 'ai',
        handle: 'operator',
        role: 'ai_operator',
        displayName: 'Operator',
        sponsor: 'owner',
        temp: false,
      });
      expect(config.team.members.at(-1)).not.toHaveProperty('onLeave', true);
      expect(validateProjectConfig(config).filter((i) => i.severity !== 'warning')).toEqual([]);
      expect(warn).toHaveBeenCalledWith({ projectKey: 'AR', member: 'operator' }, 'Added the Operator');
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('adds it to a configuration written before the Operator, with the project manager and all', () => {
      const legacy = withoutOperator();
      (legacy as unknown as { project: Record<string, unknown> }).project.language = 'hu';
      const { config } = migrate(legacy);
      expect(config.team.members.at(-1)).toMatchObject({ role: 'ai_operator', displayName: 'Operátor' });
      expect(projectManagersOf(config)).toHaveLength(1);
    });

    it('takes the next free handle when operator is taken', () => {
      const legacy = withoutOperator();
      legacy.team.members.push({
        kind: 'ai',
        handle: 'operator',
        displayName: 'Someone',
        role: 'developer',
        sponsor: 'owner',
      });
      const { config } = migrate(legacy);
      expect(config.team.members.at(-1)).toMatchObject({ handle: 'operator-2', role: 'ai_operator' });
      expect(operators(config)).toHaveLength(1);
    });

    it('adds one when the only Operator is a temp worker', () => {
      const legacy = withoutOperator();
      legacy.team.members.push({
        kind: 'ai',
        handle: 'operator',
        displayName: 'Op',
        role: 'ai_operator',
        sponsor: 'owner',
        temp: true,
      });
      const { config } = migrate(legacy);
      expect(operators(config)).toHaveLength(1);
      expect(operators(config)[0]!.handle).toBe('operator-2');
    });

    it('changes nothing where an Operator exists, on leave or not', () => {
      for (const onLeave of [true, false]) {
        const current = raw();
        current.team.members.find((m) => m.role === 'ai_operator')!.onLeave = onLeave;
        const before = JSON.parse(JSON.stringify(current));
        const { migrated, warn } = migrate(current);
        expect(migrated).toBe(current);
        expect(migrated).toEqual(before);
        expect(warn).not.toHaveBeenCalled();
      }
    });

    it('adds nothing without a human owner', () => {
      const legacy = withoutOperator();
      for (const member of legacy.team.members) if (member.kind === 'human') member.access = 'admin';
      const { migrated, warn } = migrate(legacy);
      expect(operators(ProjectConfig.parse(migrated))).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('is done once', () => {
      const { migrated } = migrate(withoutOperator());
      const again = vi.fn();
      expect(migrateProjectConfig(migrated, { projectKey: 'AR', logger: { warn: again } })).toBe(migrated);
      expect(again).not.toHaveBeenCalled();
    });
  });

  it('is done once', () => {
    const legacy = raw();
    label(legacy, 'release-ok').setBy = 'humans';
    const { migrated } = migrate(legacy);
    const again = vi.fn();
    expect(migrateProjectConfig(migrated, { projectKey: 'AR', logger: { warn: again } })).toBe(migrated);
    expect(again).not.toHaveBeenCalled();
  });

  it('leaves what it cannot read to the schema', () => {
    const gate = { conditions: [{ type: 'has_label', label: 'go' }] };
    const warn = vi.fn();
    for (const pipeline of [
      undefined,
      null,
      {},
      { stages: 'release', labels: [] },
      { stages: [], labels: null },
      {
        stages: [7, { kind: 'release', gate: null }, { kind: 'release', gate: {} }],
        labels: [],
      },
      { stages: [{ kind: 'release', gate }], labels: [null, 'go', [], { id: 7 }, { id: 'go', setBy: null }] },
      { stages: [{ kind: 'release', gate }], labels: [{ id: 'go', setBy: { members: 'owner' } }] },
    ]) {
      const config = { team: { members: [] }, pipeline };
      expect(migrateProjectConfig(config, { projectKey: 'AR', logger: { warn } })).toBe(config);
    }
    expect(migrateProjectConfig(null, { projectKey: 'AR', logger: { warn } })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});

/** A configuration from before `lead_developer` was built in: the team's own role of that id. */
describe('custom roles that became built-in roles', () => {
  const ownLead = {
    id: 'lead_developer',
    name: 'Lead developer',
    summary: 'Leads the fictional development.',
    notTheirJob: 'Does not deploy.',
    whenToAsk: 'Ask about design.',
    holders: 'ai',
    duties: ['technical_direction', 'code_review', 'boundary_authorization'],
    instructions: 'Review every change twice.',
  };

  function legacyConfig(roles: unknown[] = [ownLead], roleOverrides?: unknown) {
    const legacy = raw();
    legacy.team.members[1] = { ...legacy.team.members[1], role: 'lead_developer' };
    Object.assign(legacy.team, { roles });
    if (roleOverrides !== undefined) Object.assign(legacy.team, { roleOverrides });
    return legacy;
  }

  it('turns the custom role into the override of the built-in role, keeping duties and texts', () => {
    const { config, warn } = migrate(legacyConfig());
    expect(config.team.roles).toEqual([]);
    expect(config.team.roleOverrides).toEqual({
      lead_developer: {
        duties: ['technical_direction', 'code_review', 'boundary_authorization'],
        instructions: 'Review every change twice.',
        summary: 'Leads the fictional development.',
        notTheirJob: 'Does not deploy.',
        whenToAsk: 'Ask about design.',
      },
    });
    expect(config.team.members[1]).toMatchObject({ role: 'lead_developer' });
    expect(validateProjectConfig(config).filter((issue) => issue.severity !== 'warning')).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { projectKey: 'AR', role: 'lead_developer' },
      'Migrated custom role that shadows a built-in role to a role override',
    );
  });

  it('leaves the other custom roles and the other overrides in place', () => {
    const steward = { id: 'data_steward', name: 'Data steward', summary: 'Keeps the data tidy.' };
    const qaOverride = { duties: ['testing_acceptance'], instructions: 'Test it.' };
    const { config } = migrate(legacyConfig([steward, ownLead], { qa: qaOverride }));
    expect(config.team.roles.map((role) => role.id)).toEqual(['data_steward']);
    expect(config.team.roleOverrides).toMatchObject({
      qa: qaOverride,
      lead_developer: { duties: ownLead.duties },
    });
  });

  it('lets the custom role win over an override of the same built-in role, but keeps what it does not say', () => {
    const existing = {
      duties: ['implementation'],
      instructions: 'The override text.',
      summary: 'The override summary.',
      whenToAsk: 'The override question.',
    };
    const { config } = migrate(
      legacyConfig([{ ...ownLead, instructions: '', whenToAsk: undefined }], { lead_developer: existing }),
    );
    expect(config.team.roleOverrides?.lead_developer).toEqual({
      duties: ownLead.duties,
      instructions: 'The override text.',
      summary: ownLead.summary,
      notTheirJob: ownLead.notTheirJob,
      whenToAsk: 'The override question.',
    });
  });

  it('gives a role from before duties existed the built-in role defaults', () => {
    const { duties: _duties, ...old } = ownLead;
    const { config } = migrate(legacyConfig([old]));
    expect(config.team.roleOverrides?.lead_developer?.duties).toEqual(BUILT_IN_ROLE_DUTIES.lead_developer);
  });

  it('is the one repair: the same configuration migrates once and then passes through untouched', () => {
    const { migrated } = migrate(legacyConfig());
    const warn = vi.fn();
    expect(migrateProjectConfig(migrated, { projectKey: 'AR', logger: { warn } })).toBe(migrated);
    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves a malformed roles list to the schema', () => {
    const warn = vi.fn();
    for (const roles of [null, 'lead_developer', [null, 7, 'x', { id: 7 }, { name: 'no id' }]]) {
      const config = { team: { members: [], roles } };
      expect(migrateProjectConfig(config, { projectKey: 'AR', logger: { warn } })).toBe(config);
      expect(config.team.roles).toBe(roles);
    }
    expect(warn).not.toHaveBeenCalled();
  });
});
