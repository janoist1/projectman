import { describe, expect, it } from 'vitest';
import { AI_BUILT_IN_ROLE_IDS, BUILT_IN_ROLE_IDS, holdersAllow, roleHolders, RoleId } from '../domain/role';
import { introducedErrors, isToleratedOnLoad, validateProjectConfig } from './invariants';
import { AiMemberConfig, ProjectConfig, type ProjectConfigInput } from './schema';

function configInput(): ProjectConfigInput {
  return {
    schemaVersion: 1,
    project: {
      key: 'AC',
      name: 'Acme',
      workspacePath: '/work/acme',
      repos: [{ name: 'web', path: '.', github: 'acme/web' }],
    },
    team: {
      members: [
        { kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner', roles: ['operator'] },
        { kind: 'human', handle: 'ann', displayName: 'Ann', access: 'developer' },
        { kind: 'ai', handle: 'dev-1', displayName: 'Developer', role: 'developer', sponsor: 'owner' },
        { kind: 'ai', handle: 'pm', displayName: 'PM', role: 'project_manager', sponsor: 'owner' },
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

describe('introduced configuration errors', () => {
  it('preserves an unapproved release error when the stage moves', () => {
    const previous = build();
    previous.pipeline.stages.splice(
      1,
      0,
      {
        id: 'release',
        name: 'Release',
        kind: 'release',
        columnId: 'todo',
        owners: [],
      },
      {
        id: 'work',
        name: 'Work',
        kind: 'work',
        columnId: 'todo',
        owners: [],
      },
    );
    const next = structuredClone(previous);
    next.pipeline.stages.splice(2, 0, next.pipeline.stages.splice(1, 1)[0]!);
    expect(validateProjectConfig(previous)).toContainEqual({
      code: 'release_without_human_approval',
      path: 'pipeline.stages[1]',
    });
    expect(introducedErrors(previous, next)).toEqual([]);
  });

  it('allows a label edit alongside duplicate columns and counts an additional duplicate', () => {
    const previous = build();
    previous.pipeline.columns.push({ id: 'todo', name: 'Duplicate' });
    const next = structuredClone(previous);
    next.pipeline.labels.push({ id: 'example', name: 'Example', setBy: 'anyone' });
    expect(introducedErrors(previous, next)).toEqual([]);
    next.pipeline.columns.unshift({ id: 'todo', name: 'Third copy' });
    expect(introducedErrors(previous, next)).toEqual([
      { code: 'duplicate_column', path: 'pipeline.columns[2].id', detail: 'todo' },
    ]);
  });

  it('never counts warnings and returns all errors without a previous configuration', () => {
    const next = build();
    expect(validateProjectConfig(next).some((issue) => issue.severity === 'warning')).toBe(true);
    expect(introducedErrors(null, next)).toEqual([]);
    next.pipeline.columns.push({ id: 'todo', name: 'Duplicate' });
    expect(introducedErrors(null, next)).toEqual(
      validateProjectConfig(next).filter((issue) => issue.severity !== 'warning'),
    );
  });

  it('matches reordered element identities and nested anonymous lists', () => {
    const previous = build();
    previous.project.repos = [
      { name: 'web', path: 'web', defaultBranch: 'main' },
      { name: 'web', path: 'copy', defaultBranch: 'main' },
    ];
    previous.team.roles[0]!.id = 'developer';
    const owner = previous.team.members[0]!;
    if (owner.kind === 'human') owner.roles = ['operator', 'missing', 'operator'];
    previous.pipeline.labels = [{ id: 'broken', name: 'Broken', setBy: { members: ['missing'] } }];
    previous.pipeline.stages[1]!.gate = {
      conditions: [
        { type: 'has_label', label: 'missing' },
        { type: 'lacks_label', label: 'other' },
      ],
    };
    const next = structuredClone(previous);
    next.project.repos.reverse();
    next.team.roles.reverse();
    next.team.members.reverse();
    const nextOwner = next.team.members.find((member) => member.handle === 'owner')!;
    if (nextOwner.kind === 'human') nextOwner.roles.reverse();
    next.pipeline.labels.unshift({ id: 'valid', name: 'Valid', setBy: 'anyone' });
    next.pipeline.stages[1]!.gate!.conditions.reverse();
    expect(introducedErrors(previous, next)).toEqual([]);
    next.project.repos = [
      { name: 'renamed', path: 'web', defaultBranch: 'main' },
      { name: 'renamed', path: 'copy', defaultBranch: 'main' },
    ];
    expect(introducedErrors(previous, next)).toEqual([
      { code: 'duplicate_repo', path: 'project.repos[1].name', detail: 'renamed' },
    ]);
  });
});

describe('role catalogue', () => {
  it('lets AI members hold every built-in role except the human-only ones', () => {
    expect(BUILT_IN_ROLE_IDS).toHaveLength(22);
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
      { code: 'role_not_for_ai', path: 'team.members[4].role', detail: 'client_lead' },
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

describe('validateProjectConfig permission modes', () => {
  const problems = (change: (input: ProjectConfigInput) => void) =>
    validateProjectConfig(build(change)).filter((i) => i.severity !== 'warning');
  const aiMember = (handle: string, settings: Record<string, unknown>) => ({
    kind: 'ai',
    handle,
    displayName: handle,
    role: 'developer',
    sponsor: 'owner',
    ...settings,
  });

  it('refuses bypassPermissions for a Codex member, at the member`s permission mode', () => {
    expect(
      problems((input) => {
        members(input)[2]!.provider = 'codex';
        members(input)[2]!.permissionMode = 'bypassPermissions';
        members(input).push(aiMember('dev-2', { provider: 'codex', permissionMode: 'bypassPermissions' }));
      }),
    ).toEqual([
      { code: 'codex_bypass_not_allowed', path: 'team.members[2].permissionMode' },
      { code: 'codex_bypass_not_allowed', path: 'team.members[4].permissionMode' },
    ]);
  });

  it('leaves bypassPermissions to Claude members, whether or not they name their provider', () => {
    expect(
      problems((input) => {
        members(input)[2]!.permissionMode = 'bypassPermissions';
        members(input).push(aiMember('dev-2', { provider: 'claude', permissionMode: 'bypassPermissions' }));
      }),
    ).toEqual([]);
  });

  it.each(['default', 'acceptEdits', 'plan', 'auto'])('accepts %s for a Codex member', (permissionMode) => {
    expect(
      problems((input) => {
        members(input)[2]!.provider = 'codex';
        members(input)[2]!.permissionMode = permissionMode;
      }),
    ).toEqual([]);
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
  stages(input).splice(1, 0, { name: stage.id, owners: ['dev-1'], columnId: 'todo', ...stage });
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
      [{ code: 'duplicate_handle', path: 'team.members[4]', detail: 'ann' }],
    ],
    [
      'a team without a human owner',
      (input) => {
        members(input)[0]!.access = 'admin';
      },
      [{ code: 'no_owner', path: 'team.members' }],
    ],
    [
      'a team whose AI project manager lost the role',
      (input) => {
        members(input)[3]!.role = 'developer';
      },
      [{ code: 'no_ai_project_manager', path: 'team.members', severity: 'error' }],
    ],
    [
      'a team whose only project manager is a temp worker or a human',
      (input) => {
        members(input)[3]!.temp = true;
        members(input)[1]!.roles = ['project_manager'];
      },
      [{ code: 'no_ai_project_manager', path: 'team.members', severity: 'error' }],
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
        { code: 'sponsor_not_human', path: 'team.members[4].sponsor', detail: 'dev-1' },
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
      'a condition bound to a label that is not defined',
      (input) => {
        labels(input, { id: 'ok', name: 'Ok' });
        stages(input)[1]!.gate = {
          conditions: [{ type: 'has_label', label: 'ok', when: 'ui' }],
        };
      },
      [{ code: 'unknown_label', path: 'pipeline.stages[1].gate.conditions[0].when', detail: 'ui' }],
    ],
    [
      'a condition bound to a defined label on an ordinary gate',
      (input) => {
        labels(input, { id: 'ok', name: 'Ok' }, { id: 'ui', name: 'UI' });
        stages(input)[1]!.gate = {
          conditions: [{ type: 'has_label', label: 'ok', when: 'ui' }],
        };
      },
      [],
    ],
    [
      'a condition bound to a label on a release gate, however it weakens the approval',
      (input) => {
        labels(
          input,
          { id: 'go', name: 'Go', setBy: { duties: ['release_approval'], humansOnly: true } },
          { id: 'ui', name: 'UI' },
        );
        insertStage(input, {
          id: 'release',
          kind: 'release',
          gate: {
            conditions: [
              { type: 'has_label', label: 'go' },
              { type: 'lacks_label', label: 'ui', when: 'ui' },
            ],
          },
        });
      },
      [{ code: 'conditional_release_gate', path: 'pipeline.stages[1].gate.conditions[1]', detail: 'ui' }],
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
      'a release approval no human may give, because nobody holds the duty',
      (input) => {
        members(input)[0]!.roles = [];
        labels(input, { id: 'go', name: 'Go', setBy: { duties: ['release_approval'], humansOnly: true } });
        insertStage(input, { id: 'release', kind: 'release', gate: gate(['has_label', 'go']) });
      },
      [
        {
          code: 'missing_duty_holder',
          path: 'pipeline.stages[1].gate.conditions[0]',
          detail: 'release_approval',
        },
        { code: 'missing_label_setter', path: 'pipeline.stages[1].gate.conditions[0]', detail: 'go' },
        { code: 'release_without_human_approval', path: 'pipeline.stages[1]' },
      ],
    ],
    [
      'a release approval of listed AI members, which no human may give',
      (input) => {
        labels(input, { id: 'go', name: 'Go', setBy: { members: ['dev-1'], humansOnly: true } });
        insertStage(input, { id: 'release', kind: 'release', gate: gate(['has_label', 'go']) });
      },
      [
        { code: 'missing_label_setter', path: 'pipeline.stages[1].gate.conditions[0]', detail: 'go' },
        { code: 'release_approval_needs_duty', path: 'pipeline.stages[1].gate.conditions[0]', detail: 'go' },
        { code: 'release_without_human_approval', path: 'pipeline.stages[1]' },
      ],
    ],
    [
      'a repository name used twice',
      (input) => {
        input.project.repos = [
          { name: 'web', path: '.' },
          { name: 'api', path: 'api' },
          { name: 'web', path: 'web-copy' },
          { name: 'web', path: 'web-old' },
        ];
      },
      [
        { code: 'duplicate_repo', path: 'project.repos[2].name', detail: 'web' },
        { code: 'duplicate_repo', path: 'project.repos[3].name', detail: 'web' },
      ],
    ],
    [
      'a column id used twice',
      (input) => {
        input.pipeline.columns.push({ id: 'todo', name: 'To do again' }, { id: 'later', name: 'Later' });
      },
      [{ code: 'duplicate_column', path: 'pipeline.columns[1].id', detail: 'todo' }],
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
        stages(input)[1]!.owners = ['dev-1'];
      },
      [
        { code: 'first_stage_not_queue', path: 'pipeline.stages[0]' },
        { code: 'last_stage_not_done', path: 'pipeline.stages[1]' },
      ],
    ],
  ])('reports %s', (_name, change, expected) => {
    expect(errors(change)).toEqual(expected);
  });

  it('accepts a release approved by the holders of the release approval duty, humans only', () => {
    expect(
      errors((input) => {
        labels(input, { id: 'go', name: 'Go', setBy: { duties: ['release_approval'], humansOnly: true } });
        insertStage(input, { id: 'release', kind: 'release', gate: gate(['has_label', 'go']) });
      }),
    ).toEqual([]);
  });

  // Decision 19: the approval of a release is the release approval duty's alone.
  it.each<[string, unknown]>([
    // A label every human (clients and viewers too) may set.
    ['every human', 'humans'],
    ['listed humans, whatever their duties', { members: ['owner'], humansOnly: true }],
    ['the holders of another duty', { duties: ['final_decision'], humansOnly: true }],
    [
      'the release approval duty and another duty',
      { duties: ['release_approval', 'final_decision'], humansOnly: true },
    ],
    [
      'the release approval duty and a listed human',
      { duties: ['release_approval'], members: ['owner'], humansOnly: true },
    ],
  ])('refuses a release gate label that %s may set', (_name, setBy) => {
    expect(
      errors((input) => {
        labels(input, { id: 'go', name: 'Go', setBy });
        insertStage(input, { id: 'release', kind: 'release', gate: gate(['has_label', 'go']) });
      }),
    ).toEqual([
      { code: 'release_approval_needs_duty', path: 'pipeline.stages[1].gate.conditions[0]', detail: 'go' },
    ]);
  });

  it('refuses the approvals on a release gate that are no release approvals, and only those', () => {
    expect(
      errors((input) => {
        labels(
          input,
          { id: 'qa-ok', name: 'QA ok' },
          { id: 'merged', name: 'Merged', setBy: 'system' },
          { id: 'go', name: 'Go', setBy: { duties: ['release_approval'], humansOnly: true } },
          { id: 'sign-off', name: 'Sign-off', setBy: { duties: ['final_decision'], humansOnly: true } },
          { id: 'hold', name: 'Hold', setBy: 'humans' },
        );
        insertStage(input, {
          id: 'release',
          kind: 'release',
          gate: gate(
            ['has_label', 'qa-ok'],
            ['has_label', 'merged'],
            ['has_label', 'go'],
            ['has_label', 'sign-off'],
            // Only a required label can be refused: forbidding one is no approval.
            ['lacks_label', 'hold'],
          ),
        });
      }),
    ).toEqual([
      {
        code: 'release_approval_needs_duty',
        path: 'pipeline.stages[1].gate.conditions[3]',
        detail: 'sign-off',
      },
    ]);
  });

  it('leaves the approvals of other stages to their own labels', () => {
    expect(
      errors((input) => {
        labels(
          input,
          { id: 'merge-ok', name: 'Merge ok', setBy: { members: ['owner'], humansOnly: true } },
          { id: 'any-human', name: 'Any human', setBy: 'humans' },
          { id: 'go', name: 'Go', setBy: { duties: ['release_approval'], humansOnly: true } },
        );
        insertStage(input, {
          id: 'merge',
          kind: 'step',
          gate: gate(['has_label', 'merge-ok'], ['has_label', 'any-human']),
        });
        insertStage(input, { id: 'release', kind: 'release', gate: gate(['has_label', 'go']) });
      }),
    ).toEqual([]);
  });

  it('accepts distinct repository names and column ids', () => {
    expect(
      errors((input) => {
        input.project.repos = [
          { name: 'web', path: '.' },
          { name: 'api', path: 'api' },
        ];
        input.pipeline.columns.push({ id: 'later', name: 'Later' });
      }),
    ).toEqual([]);
  });
});

/** The issues with this code in the configuration the change makes. */
function issuesOf(code: string, change: (input: ProjectConfigInput) => void) {
  return validateProjectConfig(build(change)).filter((issue) => issue.code === code);
}

describe('validateProjectConfig working system (PM-459)', () => {
  it.each(['step', 'release'])('reports a %s stage nobody owns', (kind) => {
    const stage = (input: ProjectConfigInput, extra: Record<string, unknown>) =>
      insertStage(input, { id: 'gated', kind, ...extra });
    expect(issuesOf('stage_without_owner', (input) => stage(input, { owners: [] }))).toEqual([
      { code: 'stage_without_owner', path: 'pipeline.stages[1]', detail: 'gated' },
    ]);
    expect(issuesOf('stage_without_owner', (input) => stage(input, { owners: ['dev-1'] }))).toEqual([]);
    // A duty with no holder is `missing_duty_holder`, not this.
    expect(
      issuesOf('stage_without_owner', (input) => stage(input, { owners: undefined, duty: 'code_review' })),
    ).toEqual([]);
  });

  it('reports a work stage nobody can work', () => {
    const work = (input: ProjectConfigInput, extra: Record<string, unknown>) =>
      insertStage(input, { id: 'dev', kind: 'work', ...extra });
    const noDeveloper = (extra: Record<string, unknown>) => (input: ProjectConfigInput) => {
      members(input)[2]!.role = 'code_review';
      work(input, extra);
    };
    expect(issuesOf('work_stage_without_worker', noDeveloper({ owners: undefined }))).toEqual([
      { code: 'work_stage_without_worker', path: 'pipeline.stages[1]', detail: 'dev' },
    ]);
    expect(issuesOf('work_stage_without_worker', noDeveloper({ owners: [] }))).toHaveLength(1);
    expect(issuesOf('work_stage_without_worker', noDeveloper({ owners: ['dev-1'] }))).toEqual([]);
    // Without owners the stage stands for the implementation duty: dev-1 holds it.
    expect(issuesOf('work_stage_without_worker', (input) => work(input, { owners: undefined }))).toEqual([]);
  });

  describe('gate_unreachable', () => {
    /** dev (work, one worker) -> review (step) whose gate wants `rv`, set by `setters`. */
    const pipeline = (
      input: ProjectConfigInput,
      setters: string[],
      options: { notByAuthor?: boolean; workers?: string[] } = {},
    ) => {
      labels(input, {
        id: 'rv',
        name: 'Rv',
        setBy: { members: setters },
        notByAuthor: options.notByAuthor ?? true,
      });
      insertStage(input, { id: 'review', kind: 'step', owners: ['ann'], gate: gate(['has_label', 'rv']) });
      insertStage(input, { id: 'dev', kind: 'work', owners: options.workers ?? ['dev-1'] });
    };
    const path = 'pipeline.stages[2].gate.conditions[0]';

    it('reports a label only the one worker may set and the author cannot', () => {
      expect(issuesOf('gate_unreachable', (input) => pipeline(input, ['dev-1']))).toEqual([
        { code: 'gate_unreachable', path, detail: 'rv' },
      ]);
    });

    it('accepts a label another member may set, or one the author may set', () => {
      expect(issuesOf('gate_unreachable', (input) => pipeline(input, ['dev-1', 'ann']))).toEqual([]);
      expect(
        issuesOf('gate_unreachable', (input) => pipeline(input, ['dev-1'], { notByAuthor: false })),
      ).toEqual([]);
      expect(
        issuesOf('gate_unreachable', (input) => pipeline(input, ['dev-1'], { workers: ['dev-1', 'owner'] })),
      ).toEqual([]);
    });

    it('leaves a label nobody may set to missing_label_setter', () => {
      // `code_review` is held by nobody in the base team, so the label has no holder.
      expect(
        issuesOf('gate_unreachable', (input) => {
          pipeline(input, ['dev-1']);
          labels(input, { id: 'rv', name: 'Rv', setBy: { duties: ['code_review'] }, notByAuthor: true });
        }),
      ).toEqual([]);
    });

    it('reports a system label when no repository has a GitHub repository', () => {
      const system = (repos: ProjectConfigInput['project']['repos']) => (input: ProjectConfigInput) => {
        labels(input, { id: 'merged', name: 'Merged', setBy: 'system' });
        insertStage(input, { id: 'merge', kind: 'step', gate: gate(['has_label', 'merged']) });
        input.project.repos = repos;
      };
      expect(issuesOf('gate_unreachable', system([{ name: 'web', path: '.' }]))).toEqual([
        { code: 'gate_unreachable', path: 'pipeline.stages[1].gate.conditions[0]', detail: 'merged' },
      ]);
      expect(issuesOf('gate_unreachable', system([]))).toHaveLength(1);
      expect(issuesOf('gate_unreachable', system([{ name: 'web', path: '.', github: 'acme/web' }]))).toEqual(
        [],
      );
    });
  });

  describe('card mover', () => {
    const mover = (cardMover: unknown) => (input: ProjectConfigInput) => {
      (input.team as { cardMover?: unknown }).cardMover = cardMover;
    };

    it('accepts the worker, a project manager and a developer human', () => {
      for (const cardMover of [
        undefined,
        { kind: 'worker' },
        { kind: 'project_manager' },
        { kind: 'human', handle: 'ann' },
        { kind: 'human', handle: 'owner' },
      ])
        expect(
          validateProjectConfig(build(mover(cardMover))).filter((i) => i.code.startsWith('mover_')),
        ).toEqual([]);
    });

    it('reports a human mover who is not a human member', () => {
      const expected = (handle: string) => [
        { code: 'mover_not_member', path: 'team.cardMover.handle', detail: handle },
      ];
      expect(issuesOf('mover_not_member', mover({ kind: 'human', handle: 'ghost' }))).toEqual(
        expected('ghost'),
      );
      expect(issuesOf('mover_not_member', mover({ kind: 'human', handle: 'dev-1' }))).toEqual(
        expected('dev-1'),
      );
    });

    it('reports a human mover without the access to move cards', () => {
      const viewer = (input: ProjectConfigInput) => {
        (members(input)[1] as { access: string }).access = 'viewer';
        mover({ kind: 'human', handle: 'ann' })(input);
      };
      expect(issuesOf('mover_cannot_move', viewer)).toEqual([
        { code: 'mover_cannot_move', path: 'team.cardMover', detail: 'human' },
      ]);
    });

    it('reports a project manager mover when the team has no project manager', () => {
      const none = (input: ProjectConfigInput) => {
        members(input).splice(3, 1);
        mover({ kind: 'project_manager' })(input);
      };
      expect(issuesOf('mover_cannot_move', none)).toEqual([
        { code: 'mover_cannot_move', path: 'team.cardMover', detail: 'project_manager' },
      ]);
    });

    it('warns when the project manager mover is on leave, and only then', () => {
      const leave = (onLeave: boolean) => (input: ProjectConfigInput) => {
        members(input)[3]!.onLeave = onLeave;
        mover({ kind: 'project_manager' })(input);
      };
      expect(issuesOf('mover_on_leave', leave(true))).toEqual([
        { code: 'mover_on_leave', severity: 'warning', path: 'team.cardMover', detail: 'pm' },
      ]);
      expect(issuesOf('mover_on_leave', leave(false))).toEqual([]);
      expect(
        issuesOf('mover_on_leave', (input) => {
          members(input)[3]!.onLeave = true;
          mover({ kind: 'worker' })(input);
        }),
      ).toEqual([]);
    });
  });

  it('keeps a stored configuration that breaks the new rules loadable and editable', () => {
    const broken = build((input) => {
      insertStage(input, { id: 'review', kind: 'step', owners: [] });
      (input.team as { cardMover?: unknown }).cardMover = { kind: 'human', handle: 'ghost' };
    });
    const codes = introducedErrors(null, broken).map((issue) => issue.code);
    expect(codes).toEqual(expect.arrayContaining(['stage_without_owner', 'mover_not_member']));
    for (const code of codes) expect(isToleratedOnLoad({ code })).toBe(true);
    // An unrelated change keeps them; only a new one is introduced.
    const renamed = ProjectConfig.parse({ ...broken, project: { ...broken.project, name: 'Renamed' } });
    expect(introducedErrors(broken, renamed)).toEqual([]);
    const worse = build((input) => {
      insertStage(input, { id: 'review', kind: 'step', owners: [] });
      insertStage(input, { id: 'qa', kind: 'step', owners: [] });
      (input.team as { cardMover?: unknown }).cardMover = { kind: 'human', handle: 'ghost' };
    });
    expect(introducedErrors(broken, worse)).toEqual([
      { code: 'stage_without_owner', path: 'pipeline.stages[1]', detail: 'qa' },
    ]);
  });
});

describe('errors a stored configuration may keep', () => {
  it('tolerates the rules added after configurations were written, and nothing else', () => {
    const tolerated = [
      'duplicate_repo',
      'duplicate_column',
      'release_approval_needs_duty',
      'custom_role_shadows_builtin',
      'stage_without_owner',
      'work_stage_without_worker',
      'gate_unreachable',
      'mover_not_member',
      'mover_cannot_move',
      'mover_on_leave',
    ] as const;
    for (const code of tolerated) expect(isToleratedOnLoad({ code })).toBe(true);
    for (const code of [
      'no_owner',
      'no_ai_project_manager',
      'duplicate_handle',
      'duplicate_stage',
      'duplicate_label',
      'unknown_column',
      'unknown_label',
      'release_without_human_approval',
      'missing_label_setter',
      'missing_duty_holder',
    ] as const)
      expect(isToleratedOnLoad({ code })).toBe(false);
  });
});
