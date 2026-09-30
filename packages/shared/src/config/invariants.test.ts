import { describe, expect, it } from 'vitest';
import { AI_BUILT_IN_ROLE_IDS, BUILT_IN_ROLE_IDS, holdersAllow, roleHolders, RoleId } from '../domain/role';
import { validateProjectConfig } from './invariants';
import { AiMemberConfig, ProjectConfig, type ProjectConfigInput } from './schema';

function configInput(): ProjectConfigInput {
  return {
    schemaVersion: 1,
    project: { key: 'AC', name: 'Acme', workspacePath: '/work/acme', repos: [] },
    team: {
      members: [
        { kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner', roles: ['operator'] },
        { kind: 'human', handle: 'ann', displayName: 'Ann', access: 'developer' },
        { kind: 'ai', handle: 'dev-1', displayName: 'Developer', role: 'developer', sponsor: 'owner' },
      ],
      roles: [
        {
          id: 'data_steward',
          name: 'Data steward',
          summary: 'Keeps the reference data clean.',
          holders: 'both',
        },
        { id: 'client_lead', name: 'Client lead', summary: 'Speaks for the client.', holders: 'human' },
        { id: 'log_reader', name: 'Log reader', summary: 'Reads the logs every hour.', holders: 'ai' },
      ],
      limits: {},
    },
    pipeline: {
      columns: [{ id: 'todo', name: 'To do' }],
      stages: [
        { id: 'ready', name: 'Ready', kind: 'queue', owners: [], columnId: 'todo' },
        { id: 'done', name: 'Done', kind: 'done', owners: [], columnId: 'todo' },
      ],
    },
  };
}

function build(change: (input: ProjectConfigInput) => void = () => {}): ProjectConfig {
  const input = configInput();
  change(input);
  return ProjectConfig.parse(input);
}

function members(input: ProjectConfigInput) {
  return input.team.members as Array<Record<string, unknown>>;
}

describe('role catalogue', () => {
  it('lets AI members hold every built-in role except the human-only ones', () => {
    expect(BUILT_IN_ROLE_IDS).toHaveLength(20);
    const aiRoles: readonly string[] = AI_BUILT_IN_ROLE_IDS;
    expect(BUILT_IN_ROLE_IDS.filter((id) => !aiRoles.includes(id))).toEqual(['operator', 'product_owner']);
    expect(roleHolders('watchdog')).toBe('both');
    expect(roleHolders('scheduled')).toBeNull();
    expect(roleHolders('log_reader', [{ id: 'log_reader', holders: 'ai' }])).toBe('ai');
    expect(roleHolders('developer', [{ id: 'developer', holders: 'human' }])).toBe('both');
    expect(holdersAllow('both', 'human') && holdersAllow('ai', 'ai')).toBe(true);
    expect(holdersAllow('human', 'ai') || holdersAllow('ai', 'human')).toBe(false);
  });

  it('validates custom role identifiers', () => {
    expect(RoleId.safeParse('data_steward').success).toBe(true);
    expect(RoleId.safeParse('Data-Steward').success).toBe(false);
  });
});

describe('configuration schema', () => {
  it('defaults human roles, custom roles and the time zone', () => {
    const input = configInput();
    delete input.team.roles;
    const config = ProjectConfig.parse(input);
    expect(config.project.timezone).toBe('UTC');
    expect(config.team.roles).toEqual([]);
    expect(config.team.members[1]).toMatchObject({ kind: 'human', roles: [] });
    expect(config.team.limits.tempWorkers.role).toBe('developer');
  });

  it('accepts a schedule on any AI member', () => {
    const member = AiMemberConfig.parse({
      kind: 'ai',
      handle: 'daily',
      displayName: 'Daily worker',
      role: 'maintainer',
      sponsor: 'owner',
      schedule: { cron: '0 8 * * 1-5', prompt: 'Run the daily round.' },
    });
    expect(member.schedule).toEqual({ cron: '0 8 * * 1-5', prompt: 'Run the daily round.' });
    expect(
      AiMemberConfig.safeParse({ ...member, schedule: { cron: ' ', prompt: 'Run the daily round.' } })
        .success,
    ).toBe(false);
  });
});

describe('validateProjectConfig roles', () => {
  it('accepts built-in and custom roles held by the right kind of member', () => {
    const config = build((input) => {
      members(input)[1]!.roles = ['product_owner', 'data_steward', 'client_lead', 'qa'];
      members(input).push({
        kind: 'ai',
        handle: 'logs',
        displayName: 'Logs',
        role: 'log_reader',
        sponsor: 'owner',
      });
      input.team.limits = { tempWorkers: { enabled: true, max: 1, role: 'data_steward' } };
    });
    expect(validateProjectConfig(config).filter((i) => i.severity !== 'warning')).toEqual([]);
  });

  it('reports unknown roles of members and temp workers', () => {
    const config = build((input) => {
      members(input)[1]!.roles = ['qa', 'scheduled'];
      members(input)[2]!.role = 'scheduled';
      input.team.limits = { tempWorkers: { role: 'nobody_knows' } };
    });
    expect(validateProjectConfig(config).filter((i) => i.severity !== 'warning')).toEqual([
      { code: 'unknown_role', path: 'team.members[1].roles[1]', detail: 'scheduled' },
      { code: 'unknown_role', path: 'team.members[2].role', detail: 'scheduled' },
      { code: 'unknown_role', path: 'team.limits.tempWorkers.role', detail: 'nobody_knows' },
    ]);
  });

  it('derives duty restrictions and retains legacy custom role holder restrictions', () => {
    const config = build((input) => {
      members(input)[0]!.roles = ['operator', 'watchdog', 'log_reader'];
      members(input)[2]!.role = 'operator';
      members(input).push({
        kind: 'ai',
        handle: 'lead',
        displayName: 'Lead',
        role: 'client_lead',
        sponsor: 'owner',
      });
      input.team.limits = { tempWorkers: { role: 'product_owner' } };
    });
    expect(validateProjectConfig(config).filter((i) => i.severity !== 'warning')).toEqual([
      { code: 'role_not_for_human', path: 'team.members[0].roles[2]', detail: 'log_reader' },
      { code: 'role_not_for_ai', path: 'team.members[2].role', detail: 'operator' },
      { code: 'role_not_for_ai', path: 'team.members[3].role', detail: 'client_lead' },
      { code: 'role_not_for_ai', path: 'team.limits.tempWorkers.role', detail: 'product_owner' },
    ]);
  });

  it('reports custom roles that reuse a built-in id or another custom id', () => {
    const config = build((input) => {
      input.team.roles!.push(
        { id: 'qa', name: 'Our QA', summary: 'Tests differently.', holders: 'both' },
        { id: 'data_steward', name: 'Second steward', summary: 'Same id again.', holders: 'ai' },
      );
      members(input)[1]!.roles = ['qa', 'data_steward'];
    });
    expect(validateProjectConfig(config).filter((i) => i.severity !== 'warning')).toEqual([
      { code: 'custom_role_shadows_builtin', path: 'team.roles[3].id', detail: 'qa' },
      { code: 'duplicate_role', path: 'team.roles[4].id', detail: 'data_steward' },
    ]);
  });

  it('reports a role a human holds twice', () => {
    const config = build((input) => {
      members(input)[1]!.roles = ['qa', 'devops', 'qa'];
    });
    expect(validateProjectConfig(config).filter((i) => i.severity !== 'warning')).toEqual([
      { code: 'duplicate_role', path: 'team.members[1].roles[2]', detail: 'qa' },
    ]);
  });
});

function stages(input: ProjectConfigInput) {
  return input.pipeline.stages as Array<Record<string, unknown>>;
}

function labels(input: ProjectConfigInput, ...defined: Array<Record<string, unknown>>) {
  input.pipeline.labels = defined as ProjectConfigInput['pipeline']['labels'];
}

/** Inserts a stage before the done stage (index 1 of the base pipeline). */
function insertStage(input: ProjectConfigInput, stage: Record<string, unknown>) {
  stages(input).splice(1, 0, { name: stage.id, owners: [], columnId: 'todo', ...stage });
}

function gate(...conditions: Array<[type: 'has_label' | 'lacks_label', label: string]>) {
  return { conditions: conditions.map(([type, label]) => ({ type, label })) };
}

function errors(change: (input: ProjectConfigInput) => void) {
  return validateProjectConfig(build(change)).filter((i) => i.severity !== 'warning');
}

describe('validateProjectConfig team and pipeline', () => {
  it('accepts the base configuration', () => {
    expect(errors(() => {})).toEqual([]);
  });

  it.each<[string, (input: ProjectConfigInput) => void, unknown[]]>([
    [
      'a handle used twice',
      (input) =>
        members(input).push({ kind: 'human', handle: 'ann', displayName: 'Ann 2', access: 'viewer' }),
      [{ code: 'duplicate_handle', path: 'team.members[3]', detail: 'ann' }],
    ],
    [
      'a team without a human owner',
      (input) => {
        members(input)[0]!.access = 'admin';
      },
      [{ code: 'no_owner', path: 'team.members' }],
    ],
    [
      'an AI sponsored by an unknown member or by another AI',
      (input) => {
        members(input)[2]!.sponsor = 'nobody';
        members(input).push({
          kind: 'ai',
          handle: 'dev-2',
          displayName: 'Dev 2',
          role: 'developer',
          sponsor: 'dev-1',
        });
      },
      [
        { code: 'sponsor_not_human', path: 'team.members[2].sponsor', detail: 'nobody' },
        { code: 'sponsor_not_human', path: 'team.members[3].sponsor', detail: 'dev-1' },
      ],
    ],
    [
      'an unknown stage owner',
      (input) => {
        stages(input)[0]!.owners = ['owner', 'ghost'];
      },
      [{ code: 'unknown_member', path: 'pipeline.stages[0].owners', detail: 'ghost' }],
    ],
    [
      'an unknown member allowed to set a label',
      (input) => labels(input, { id: 'ok', name: 'Ok', setBy: { members: ['ann', 'ghost'] } }),
      [{ code: 'unknown_member', path: 'pipeline.labels[0].setBy', detail: 'ghost' }],
    ],
    [
      'gate labels that are not defined, required or forbidden',
      (input) => {
        stages(input)[1]!.gate = gate(['has_label', 'missing'], ['lacks_label', 'absent']);
      },
      [
        { code: 'unknown_label', path: 'pipeline.stages[1].gate.conditions[0]', detail: 'missing' },
        { code: 'unknown_label', path: 'pipeline.stages[1].gate.conditions[1]', detail: 'absent' },
      ],
    ],
    [
      'a label defined twice',
      (input) => labels(input, { id: 'ok', name: 'Ok' }, { id: 'ok', name: 'Ok again' }),
      [{ code: 'duplicate_label', path: 'pipeline.labels[1]', detail: 'ok' }],
    ],
    [
      'required labels nobody may set, naming unfilled duties',
      (input) => {
        labels(
          input,
          { id: 'secure', name: 'Secure', setBy: { duties: ['security_review'] } },
          { id: 'human-dev', name: 'Human dev', setBy: { members: ['dev-1'], humansOnly: true } },
          { id: 'merged', name: 'Merged', setBy: 'system' },
        );
        stages(input)[1]!.gate = gate(
          ['has_label', 'secure'],
          ['has_label', 'human-dev'],
          ['has_label', 'merged'],
          ['lacks_label', 'human-dev'],
        );
      },
      [
        {
          code: 'missing_duty_holder',
          path: 'pipeline.stages[1].gate.conditions[0]',
          detail: 'security_review',
        },
        { code: 'missing_label_setter', path: 'pipeline.stages[1].gate.conditions[0]', detail: 'secure' },
        { code: 'missing_label_setter', path: 'pipeline.stages[1].gate.conditions[1]', detail: 'human-dev' },
      ],
    ],
    [
      'a stage duty nobody holds',
      (input) => insertStage(input, { id: 'security', kind: 'step', duty: 'security_review' }),
      [{ code: 'missing_duty_holder', path: 'pipeline.stages[1].duty', detail: 'security_review' }],
    ],
    [
      'a release without a gate',
      (input) => insertStage(input, { id: 'release', kind: 'release' }),
      [{ code: 'release_without_human_approval', path: 'pipeline.stages[1]' }],
    ],
    [
      'a release gated only on labels AI members may set',
      (input) => {
        labels(input, { id: 'ok', name: 'Ok' }, { id: 'merged', name: 'Merged', setBy: 'system' });
        insertStage(input, {
          id: 'release',
          kind: 'release',
          gate: gate(['has_label', 'ok'], ['has_label', 'merged']),
        });
      },
      [{ code: 'release_without_human_approval', path: 'pipeline.stages[1]' }],
    ],
    [
      'a release approval no human may give',
      (input) => {
        labels(input, { id: 'go', name: 'Go', setBy: { members: ['dev-1'], humansOnly: true } });
        insertStage(input, { id: 'release', kind: 'release', gate: gate(['has_label', 'go']) });
      },
      [
        { code: 'missing_label_setter', path: 'pipeline.stages[1].gate.conditions[0]', detail: 'go' },
        { code: 'release_without_human_approval', path: 'pipeline.stages[1]' },
      ],
    ],
    [
      'a stage in an unknown column',
      (input) => {
        stages(input)[0]!.columnId = 'nowhere';
      },
      [{ code: 'unknown_column', path: 'pipeline.stages[0]', detail: 'nowhere' }],
    ],
    [
      'a stage id used twice',
      (input) => insertStage(input, { id: 'ready', kind: 'queue' }),
      [{ code: 'duplicate_stage', path: 'pipeline.stages[1]', detail: 'ready' }],
    ],
    [
      'a pipeline that neither starts with a queue nor ends done',
      (input) => {
        stages(input)[0]!.kind = 'work';
        stages(input)[1]!.kind = 'step';
      },
      [
        { code: 'first_stage_not_queue', path: 'pipeline.stages[0]' },
        { code: 'last_stage_not_done', path: 'pipeline.stages[1]' },
      ],
    ],
  ])('reports %s', (_name, change, expected) => {
    expect(errors(change)).toEqual(expected);
  });

  it.each<[string, unknown]>([
    ['duty holders, humans only', { duties: ['release_approval'], humansOnly: true }],
    ['listed humans', { members: ['owner'], humansOnly: true }],
    // Any human-only label counts, including one every human member (clients too) may set.
    ['every human', 'humans'],
  ])('accepts a release approved by %s', (_name, setBy) => {
    expect(
      errors((input) => {
        labels(input, { id: 'go', name: 'Go', setBy });
        insertStage(input, { id: 'release', kind: 'release', gate: gate(['has_label', 'go']) });
      }),
    ).toEqual([]);
  });
});
