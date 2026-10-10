import { describe, expect, it } from 'vitest';
import { priorityRefusal } from '../domain/task';
import { integratorConfigRefusal } from './integrator';
import {
  ConfigChangeRow,
  OPERATOR_ROLE,
  OPERATOR_SETTABLE_FIELDS,
  OperatorFixedChange,
  OperatorLevel,
  isOperator,
  isOperatorActor,
  isRequiredOperator,
  operatorConfigVerdict,
  operatorFixedChange,
  operatorOf,
} from './operator';
import type { OperatorConfigVerdict } from './operator';
import { actorMoveRefusal } from './project-manager';
import { ProjectConfig } from './schema';

function config() {
  return ProjectConfig.parse({
    schemaVersion: 1,
    project: {
      key: 'AC',
      name: 'Acme',
      workspacePath: '/work/acme',
      repos: [{ name: 'web', path: 'web' }],
    },
    team: {
      members: [
        {
          kind: 'human',
          handle: 'owner',
          displayName: 'Owner',
          access: 'owner',
          email: 'owner@example.com',
          roles: ['operator'],
        },
        { kind: 'human', handle: 'ann', displayName: 'Ann', access: 'developer', email: 'ann@example.com' },
        { kind: 'ai', handle: 'operator', displayName: 'Operator', role: 'ai_operator', sponsor: 'owner' },
        { kind: 'ai', handle: 'pm', displayName: 'PM', role: 'project_manager', sponsor: 'owner' },
        {
          kind: 'ai',
          handle: 'writer',
          displayName: 'Writer',
          role: 'content',
          model: 'opus',
          sponsor: 'owner',
        },
        { kind: 'ai', handle: 'devops', displayName: 'Devops', role: 'devops', sponsor: 'owner' },
        { kind: 'ai', handle: 'dev-1', displayName: 'Developer', role: 'developer', sponsor: 'owner' },
      ],
      roles: [
        {
          id: 'checker',
          name: 'Checker',
          summary: 'Checks the work.',
          holders: 'ai',
          duties: ['code_review'],
        },
      ],
      roleOverrides: {
        qa: { duties: ['testing_acceptance'], instructions: 'Test it.' },
        ai_operator: { duties: ['project_operation'], instructions: 'Be careful.' },
      },
      limits: { maxConcurrentAi: 3 },
    },
    pipeline: {
      columns: [{ id: 'all', name: 'All' }],
      stages: [
        { id: 'backlog', name: 'Backlog', kind: 'queue', columnId: 'all' },
        { id: 'dev', name: 'Dev', kind: 'work', columnId: 'all' },
        {
          id: 'review',
          name: 'Review',
          kind: 'step',
          columnId: 'all',
          gate: { conditions: [{ type: 'has_label', label: 'merge-ok' }] },
        },
        { id: 'done', name: 'Done', kind: 'done', columnId: 'all' },
      ],
      labels: [
        { id: 'merge-ok', name: 'Merge ok', setBy: { members: ['owner'], humansOnly: true } },
        { id: 'ui', name: 'UI' },
      ],
    },
  });
}

const member = (c: ProjectConfig, handle: string) => {
  const found = c.team.members.find((m) => m.handle === handle);
  if (!found) throw new Error(`no member ${handle}`);
  return found;
};
const ai = (c: ProjectConfig, handle: string) => {
  const found = member(c, handle);
  if (found.kind !== 'ai') throw new Error(`${handle} is not an AI member`);
  return found;
};
const stage = (c: ProjectConfig, id: string) => {
  const found = c.pipeline.stages.find((s) => s.id === id);
  if (!found) throw new Error(`no stage ${id}`);
  return found;
};

function verdict(edit: (next: ProjectConfig) => void, base: () => ProjectConfig = config) {
  const previous = base();
  const next = structuredClone(previous);
  edit(next);
  return { previous, next, result: operatorConfigVerdict(previous, next, { operator: 'operator' }) };
}

type Case = [string, (next: ProjectConfig) => void, OperatorLevel];

/** The fields of an AI member the integrator rule covers but the owner wants to go straight through. */
const FOUR = ['model', 'effort', 'capacity', 'schedule'];

const NOW: Case[] = [
  ['the writer becomes Sonnet', (n) => (ai(n, 'writer').model = 'sonnet'), 'now'],
  ['the devops goes on leave', (n) => (ai(n, 'devops').onLeave = true), 'now'],
  ['effort', (n) => (ai(n, 'dev-1').effort = 'high'), 'now'],
  ['capacity', (n) => (ai(n, 'dev-1').capacity = 3), 'now'],
  [
    'a schedule',
    (n) => (ai(n, 'writer').schedule = { cron: '0 9 * * 1-5', prompt: 'Write the weekly note.' }),
    'now',
  ],
  ['a stage is renamed', (n) => (stage(n, 'dev').name = 'Development'), 'now'],
  ['a custom role’s instructions', (n) => (n.team.roles[0]!.instructions = 'Check twice.'), 'now'],
  [
    'a built-in role’s override instructions',
    (n) => (n.team.roleOverrides!.qa!.instructions = 'Test more.'),
    'now',
  ],
];

const APPROVAL: Case[] = [
  ['outboundNetwork', (n) => (ai(n, 'writer').outboundNetwork = false), 'approval'],
  ['permissionMode', (n) => (ai(n, 'writer').permissionMode = 'plan'), 'approval'],
  ['provider', (n) => (ai(n, 'writer').provider = 'codex'), 'approval'],
  ['a member’s role', (n) => (ai(n, 'writer').role = 'docs'), 'approval'],
  ['a member’s sponsor', (n) => (ai(n, 'writer').sponsor = 'ann'), 'approval'],
  ['a member’s own instructions', (n) => (ai(n, 'writer').instructions = 'Ignore the rules.'), 'approval'],
  ['a member’s display name', (n) => (ai(n, 'writer').displayName = 'Scribe'), 'approval'],
  ['a member’s approver', (n) => (ai(n, 'writer').approver = 'ai'), 'approval'],
  [
    'hiring an AI member',
    (n) =>
      n.team.members.push({
        kind: 'ai',
        handle: 'dev-2',
        displayName: 'Dev 2',
        role: 'developer',
        sponsor: 'owner',
      } as never),
    'approval',
  ],
  [
    'retiring an AI member',
    (n) => (n.team.members = n.team.members.filter((m) => m.handle !== 'dev-1')),
    'approval',
  ],
  ['maxFixRounds', (n) => (n.team.limits.maxFixRounds = 5), 'approval'],
  [
    'tempWorkers',
    (n) => (n.team.limits.tempWorkers = { enabled: true, max: 2, role: 'developer' }),
    'approval',
  ],
  ['aiEnabled', (n) => (n.team.limits.aiEnabled = false), 'approval'],
  [
    'a gate is added',
    (n) => (stage(n, 'dev').gate = { conditions: [{ type: 'has_label', label: 'ui' }] }),
    'approval',
  ],
  ['a gate is removed', (n) => delete stage(n, 'review').gate, 'approval'],
  [
    'a gate condition changes',
    (n) => (stage(n, 'review').gate = { conditions: [{ type: 'has_label', label: 'ui' }] }),
    'approval',
  ],
  ['a stage description', (n) => (stage(n, 'dev').description = 'Where it is built.'), 'approval'],
  ['a stage kind', (n) => (stage(n, 'dev').kind = 'step'), 'approval'],
  [
    'a stage is added',
    (n) => n.pipeline.stages.splice(2, 0, { id: 'qa', name: 'QA', kind: 'step', columnId: 'all' }),
    'approval',
  ],
  [
    'stages are reordered',
    (n) => n.pipeline.stages.splice(1, 0, n.pipeline.stages.splice(2, 1)[0]!),
    'approval',
  ],
  ['a board column is renamed', (n) => (n.pipeline.columns[0]!.name = 'Everything'), 'approval'],
  ['a label rule', (n) => (n.pipeline.labels[1]!.setBy = 'system'), 'approval'],
  ['a label is added', (n) => n.pipeline.labels.push({ id: 'x', name: 'X' } as never), 'approval'],
  ['a human-only label opens up', (n) => (n.pipeline.labels[0]!.setBy = 'anyone'), 'approval'],
  [
    'a repository is added',
    (n) => n.project.repos.push({ name: 'api', path: 'api', defaultBranch: 'main' }),
    'approval',
  ],
  ['the workspace', (n) => (n.project.workspacePath = '/work/other'), 'approval'],
  ['the project name', (n) => (n.project.name = 'Acme 2'), 'approval'],
  ['the time zone', (n) => (n.project.timezone = 'Europe/Budapest'), 'approval'],
  ['boundary delegation', (n) => (n.team.boundary = { enabled: true, leadTimeoutSeconds: 60 }), 'approval'],
  ['release four eyes', (n) => (n.team.releaseFourEyes = true), 'approval'],
  [
    'a duty of a role override',
    (n) => (n.team.roleOverrides!.qa!.duties = ['testing_acceptance', 'code_review']),
    'approval',
  ],
  [
    'a role is added',
    (n) => n.team.roles.push({ id: 'x', name: 'X', summary: 'X', holders: 'ai', instructions: '' } as never),
    'approval',
  ],
  ['the Operator’s own model', (n) => (ai(n, 'operator').model = 'sonnet'), 'approval'],
  ['the Operator’s own provider', (n) => (ai(n, 'operator').provider = 'codex'), 'approval'],
  ['the Operator’s own effort', (n) => (ai(n, 'operator').effort = 'high'), 'approval'],
];

const NEVER: Case[] = [
  ['a person’s access', (n) => ((member(n, 'ann') as { access: string }).access = 'admin'), 'never'],
  ['a person’s name', (n) => (member(n, 'ann').displayName = 'Anna'), 'never'],
  ['a person’s roles', (n) => ((member(n, 'ann') as { roles: string[] }).roles = ['qa']), 'never'],
  ['a person’s email', (n) => ((member(n, 'ann') as { email: string }).email = 'x@example.com'), 'never'],
  [
    'a person is added',
    (n) =>
      n.team.members.push({ kind: 'human', handle: 'zed', displayName: 'Zed', access: 'viewer', roles: [] }),
    'never',
  ],
  [
    'a person is removed',
    (n) => (n.team.members = n.team.members.filter((m) => m.handle !== 'ann')),
    'never',
  ],
  ['a person becomes an owner', (n) => ((member(n, 'ann') as { access: string }).access = 'owner'), 'never'],
  ['the owner is demoted', (n) => ((member(n, 'owner') as { access: string }).access = 'developer'), 'never'],
  [
    'a person and a model together',
    (n) => {
      ai(n, 'writer').model = 'sonnet';
      member(n, 'ann').displayName = 'Anna';
    },
    'never',
  ],
  // The Operator is fixed (PM-473): nothing of it but the model, provider and effort.
  ['the Operator’s own leave', (n) => (ai(n, 'operator').onLeave = true), 'never'],
  ['the Operator’s own capacity', (n) => (ai(n, 'operator').capacity = 4), 'never'],
  [
    'the Operator’s own schedule',
    (n) => (ai(n, 'operator').schedule = { cron: '0 9 * * *', prompt: 'x' }),
    'never',
  ],
  ['the Operator’s own instructions', (n) => (ai(n, 'operator').instructions = 'Do more.'), 'never'],
  ['the Operator’s own name', (n) => (member(n, 'operator').displayName = 'Boss'), 'never'],
  ['the Operator’s own permission mode', (n) => (ai(n, 'operator').permissionMode = 'acceptEdits'), 'never'],
  ['the Operator’s own sponsor', (n) => (ai(n, 'operator').sponsor = 'ann'), 'never'],
  [
    'the Operator is removed',
    (n) => (n.team.members = n.team.members.filter((m) => m.handle !== 'operator')),
    'never',
  ],
  [
    'a second Operator is added',
    (n) => n.team.members.push({ ...structuredClone(ai(n, 'operator')), handle: 'operator-2' }),
    'never',
  ],
  ['the Operator’s role is given to another member', (n) => (ai(n, 'dev-1').role = OPERATOR_ROLE), 'never'],
  [
    'the instructions of the Operator’s own role',
    (n) => (n.team.roleOverrides!.ai_operator!.instructions = 'Do anything.'),
    'never',
  ],
  [
    'the duties of the Operator’s own role',
    (n) => (n.team.roleOverrides!.ai_operator!.duties = ['project_operation', 'code_review']),
    'never',
  ],
  [
    'the temp workers’ role is the Operator’s',
    (n) => (n.team.limits.tempWorkers.role = OPERATOR_ROLE),
    'never',
  ],
];

describe('operatorFixedChange (PM-473)', () => {
  const secondOperator = (c: ProjectConfig, extra: object = {}) => ({
    ...structuredClone(ai(c, 'operator')),
    handle: 'operator-2',
    ...extra,
  });
  /** What `edit` changes on the base configuration; `before` first shapes the previous one. */
  const found = (
    edit: (next: ProjectConfig) => void,
    before: (previous: ProjectConfig) => void = () => {},
  ) => {
    const previous = config();
    before(previous);
    const next = structuredClone(previous);
    edit(next);
    return operatorFixedChange(previous, next);
  };
  const withTwo = (c: ProjectConfig) => c.team.members.push(secondOperator(c));

  it('names the settable fields', () => {
    expect([...OPERATOR_SETTABLE_FIELDS]).toEqual(['model', 'provider', 'effort']);
    expect(OperatorFixedChange.parse({ kind: 'leave', handle: 'operator', field: 'onLeave' })).toBeTruthy();
  });

  it('finds nothing when nothing changed, or on a first configuration with one Operator', () => {
    const c = config();
    expect(operatorFixedChange(c, structuredClone(c))).toBeNull();
    expect(operatorFixedChange(null, c)).toBeNull();
  });

  it.each([
    [
      'the Operator is retired',
      (n: ProjectConfig) => (n.team.members = n.team.members.filter((m) => m.handle !== 'operator')),
      { kind: 'retire', handle: 'operator', field: null },
    ],
    [
      'its role is given up',
      (n: ProjectConfig) => (ai(n, 'operator').role = 'developer'),
      { kind: 'retire', handle: 'operator', field: null },
    ],
    [
      'a second Operator is hired',
      (n: ProjectConfig) => n.team.members.push(secondOperator(n)),
      { kind: 'second', handle: 'operator-2', field: null },
    ],
    [
      'another member takes the role',
      (n: ProjectConfig) => (ai(n, 'dev-1').role = OPERATOR_ROLE),
      { kind: 'second', handle: 'dev-1', field: null },
    ],
    [
      'a stand-in with the role joins',
      (n: ProjectConfig) => n.team.members.push(secondOperator(n, { temp: true })),
      { kind: 'second', handle: 'operator-2', field: null },
    ],
    [
      'the temp workers are hired for the role',
      (n: ProjectConfig) => (n.team.limits.tempWorkers.role = OPERATOR_ROLE),
      { kind: 'second', handle: null, field: 'limits.tempWorkers.role' },
    ],
    [
      'it goes on leave',
      (n: ProjectConfig) => (ai(n, 'operator').onLeave = true),
      { kind: 'leave', handle: 'operator', field: 'onLeave' },
    ],
    [
      'its name changes',
      (n: ProjectConfig) => (ai(n, 'operator').displayName = 'Boss'),
      { kind: 'field', handle: 'operator', field: 'displayName' },
    ],
    [
      'its instructions change',
      (n: ProjectConfig) => (ai(n, 'operator').instructions = 'Do more.'),
      { kind: 'field', handle: 'operator', field: 'instructions' },
    ],
    [
      'its capacity changes',
      (n: ProjectConfig) => (ai(n, 'operator').capacity = 2),
      { kind: 'field', handle: 'operator', field: 'capacity' },
    ],
    [
      'it gets a schedule',
      (n: ProjectConfig) => (ai(n, 'operator').schedule = { cron: '0 9 * * *', prompt: 'x' }),
      { kind: 'field', handle: 'operator', field: 'schedule' },
    ],
    [
      'its permission mode changes',
      (n: ProjectConfig) => (ai(n, 'operator').permissionMode = 'acceptEdits'),
      { kind: 'field', handle: 'operator', field: 'permissionMode' },
    ],
    [
      'its sponsor changes while the old one stays',
      (n: ProjectConfig) => (ai(n, 'operator').sponsor = 'ann'),
      { kind: 'field', handle: 'operator', field: 'sponsor' },
    ],
    [
      'several fields change: the first in the alphabet',
      (n: ProjectConfig) => {
        ai(n, 'operator').instructions = 'Do more.';
        ai(n, 'operator').capacity = 3;
        ai(n, 'operator').model = 'sonnet';
      },
      { kind: 'field', handle: 'operator', field: 'capacity' },
    ],
    [
      'the role override changes',
      (n: ProjectConfig) => (n.team.roleOverrides!.ai_operator!.instructions = 'Do anything.'),
      { kind: 'field', handle: null, field: 'roleOverrides.ai_operator' },
    ],
    [
      'the role override goes',
      (n: ProjectConfig) => delete n.team.roleOverrides!.ai_operator,
      { kind: 'field', handle: null, field: 'roleOverrides.ai_operator' },
    ],
  ])('finds it when %s', (_what, edit, expected) => {
    expect(found(edit)).toEqual(expected);
  });

  it('finds the first kind in the order: retire, second, leave, field', () => {
    expect(
      found((n) => {
        n.team.members = n.team.members.filter((m) => m.handle !== 'operator');
        ai(n, 'dev-1').role = OPERATOR_ROLE;
      }),
    ).toMatchObject({ kind: 'retire' });
    expect(
      found((n) => {
        n.team.members.push(secondOperator(n));
        ai(n, 'operator').onLeave = true;
      }),
    ).toMatchObject({ kind: 'second' });
    expect(
      found((n) => {
        ai(n, 'operator').onLeave = true;
        ai(n, 'operator').capacity = 2;
      }),
    ).toMatchObject({ kind: 'leave' });
  });

  it('counts every Operator as new when there is no previous configuration', () => {
    const c = config();
    withTwo(c);
    expect(operatorFixedChange(null, c)).toMatchObject({ kind: 'second' });
    c.team.members = c.team.members.filter((m) => m.handle !== 'operator-2');
    ai(c, 'operator').onLeave = true;
    expect(operatorFixedChange(null, c)).toMatchObject({ kind: 'leave' });
  });

  it.each([
    ['its model', (n: ProjectConfig) => (ai(n, 'operator').model = 'sonnet')],
    ['its provider', (n: ProjectConfig) => (ai(n, 'operator').provider = 'codex')],
    ['its effort', (n: ProjectConfig) => (ai(n, 'operator').effort = 'max')],
    [
      'all three together',
      (n: ProjectConfig) => Object.assign(ai(n, 'operator'), { model: 'x', effort: 'low' }),
    ],
    [
      'a restated default',
      (n: ProjectConfig) =>
        Object.assign(ai(n, 'operator'), { onLeave: false, outboundNetwork: true, approver: 'human' }),
    ],
    [
      'another member’s fields',
      (n: ProjectConfig) => Object.assign(ai(n, 'dev-1'), { onLeave: true, capacity: 3 }),
    ],
    ['a person', (n: ProjectConfig) => (member(n, 'ann').displayName = 'Anna')],
    [
      'another role’s override',
      (n: ProjectConfig) => (n.team.roleOverrides!.qa!.instructions = 'Test more.'),
    ],
    ['the temp workers’ other role', (n: ProjectConfig) => (n.team.limits.tempWorkers.role = 'qa')],
  ])('lets through %s', (_what, edit) => {
    expect(found(edit)).toBeNull();
  });

  it('lets one of two Operators go', () => {
    expect(
      found((n) => (n.team.members = n.team.members.filter((m) => m.handle !== 'operator')), withTwo),
    ).toBeNull();
    expect(
      found((n) => (n.team.members = n.team.members.filter((m) => m.handle !== 'operator-2')), withTwo),
    ).toBeNull();
  });

  it('lets the sponsor change when the old one is no longer a human member and the new one is', () => {
    const sponsoredByAnn = (c: ProjectConfig) => (ai(c, 'operator').sponsor = 'ann');
    expect(
      found((n) => {
        n.team.members = n.team.members.filter((m) => m.handle !== 'ann');
        ai(n, 'operator').sponsor = 'owner';
      }, sponsoredByAnn),
    ).toBeNull();
    // The old sponsor stays: this is a change of sponsor, not a removal.
    expect(found((n) => (ai(n, 'operator').sponsor = 'owner'), sponsoredByAnn)).toMatchObject({
      kind: 'field',
      field: 'sponsor',
    });
    // The new sponsor is not a person.
    expect(
      found((n) => {
        n.team.members = n.team.members.filter((m) => m.handle !== 'ann');
        ai(n, 'operator').sponsor = 'pm';
      }, sponsoredByAnn),
    ).toMatchObject({ kind: 'field', field: 'sponsor' });
  });
});

describe('operatorConfigVerdict', () => {
  it('no change is now, with no rows', () => {
    expect(verdict(() => {}).result).toEqual({ level: 'now', changes: [] });
  });

  it('restating a default is no change', () => {
    expect(verdict((n) => (ai(n, 'writer').outboundNetwork = true)).result).toEqual({
      level: 'now',
      changes: [],
    });
    expect(verdict((n) => (ai(n, 'writer').onLeave = false)).result).toEqual({ level: 'now', changes: [] });
    expect(verdict((n) => (ai(n, 'writer').approver = 'human')).result).toEqual({
      level: 'now',
      changes: [],
    });
  });

  it('names what makes the Operator other than fixed in a safety-net row when no field shows it', () => {
    const { result } = verdict((n) => (n.team.limits.tempWorkers.role = OPERATOR_ROLE));
    expect(result.level).toBe('never');
    expect(result.changes).toContainEqual({
      area: 'member',
      target: null,
      field: 'operator_fixed',
      before: null,
      after: null,
      level: 'never',
    });
  });

  it('shows the Operator’s row by row: the settable fields ask for approval, the rest never', () => {
    const { result } = verdict((n) => {
      ai(n, 'operator').model = 'sonnet';
      ai(n, 'operator').onLeave = true;
    });
    expect(result.changes.map((row) => `${row.field}:${row.level}`)).toEqual([
      'model:approval',
      'onLeave:never',
    ]);
  });

  it.each([...NOW, ...APPROVAL, ...NEVER])('%s: %s', (_name, edit, level) => {
    const { result } = verdict(edit);
    expect(result.level).toBe(level);
    expect(result.changes.length).toBeGreaterThan(0);
    expect(result.changes.some((row) => row.level === level)).toBe(true);
    expect(result.changes.every((row) => ConfigChangeRow.safeParse(row).success)).toBe(true);
  });

  it('names the change in one row with the old and the new value', () => {
    expect(verdict((n) => (ai(n, 'writer').model = 'sonnet')).result).toEqual({
      level: 'now',
      changes: [
        { area: 'member', target: 'writer', field: 'model', before: 'opus', after: 'sonnet', level: 'now' },
      ],
    });
    expect(verdict((n) => (ai(n, 'devops').onLeave = true)).result.changes).toEqual([
      { area: 'member', target: 'devops', field: 'onLeave', before: 'false', after: 'true', level: 'now' },
    ]);
    expect(verdict((n) => (ai(n, 'writer').outboundNetwork = false)).result.changes).toEqual([
      {
        area: 'member',
        target: 'writer',
        field: 'outboundNetwork',
        before: 'true',
        after: 'false',
        level: 'approval',
      },
    ]);
    expect(verdict((n) => (stage(n, 'dev').name = 'Development')).result.changes).toEqual([
      { area: 'stage', target: 'dev', field: 'name', before: 'Dev', after: 'Development', level: 'now' },
    ]);
  });

  it('shows what is not text as JSON with sorted keys, and an absent value as null', () => {
    const { result } = verdict((n) => (ai(n, 'writer').schedule = { prompt: 'Hi', cron: '0 9 * * *' }));
    expect(result.changes).toEqual([
      {
        area: 'member',
        target: 'writer',
        field: 'schedule',
        before: null,
        after: '{"cron":"0 9 * * *","prompt":"Hi"}',
        level: 'now',
      },
    ]);
    const gate = verdict(
      (n) => (stage(n, 'dev').gate = { conditions: [{ type: 'has_label', label: 'ui' }] }),
    );
    expect(gate.result.changes).toEqual([
      {
        area: 'gate',
        target: 'dev',
        field: 'gate',
        before: null,
        after: '{"conditions":[{"label":"ui","type":"has_label"}]}',
        level: 'approval',
      },
    ]);
  });

  it('shows an added or removed entity as one `*` row with a short descriptor', () => {
    const hired = verdict((n) =>
      n.team.members.push({
        kind: 'ai',
        handle: 'dev-2',
        displayName: 'Dev 2',
        role: 'developer',
        sponsor: 'owner',
      } as never),
    );
    expect(hired.result.changes).toEqual([
      { area: 'member', target: 'dev-2', field: '*', before: null, after: 'developer', level: 'approval' },
    ]);
    const retired = verdict((n) => (n.pipeline.labels = n.pipeline.labels.filter((l) => l.id !== 'ui')));
    expect(retired.result.changes).toEqual([
      { area: 'label', target: 'ui', field: '*', before: 'UI', after: null, level: 'approval' },
    ]);
  });

  it('the level is the highest of the rows: never over approval over now', () => {
    const mixed = verdict((n) => {
      ai(n, 'writer').model = 'sonnet';
      ai(n, 'writer').outboundNetwork = false;
    });
    expect(mixed.result.level).toBe('approval');
    expect(mixed.result.changes.map((row) => row.level).sort()).toEqual(['approval', 'now']);
  });

  it('an AI member’s model together with a gate needs approval', () => {
    const { result } = verdict((n) => {
      ai(n, 'writer').model = 'sonnet';
      delete stage(n, 'review').gate;
    });
    expect(result.level).toBe('approval');
  });

  describe('a revert is judged by its result', () => {
    const changed = () => {
      const c = config();
      ai(c, 'writer').model = 'sonnet';
      ai(c, 'writer').outboundNetwork = false;
      ai(c, 'devops').onLeave = true;
      return c;
    };

    it('putting back a model and a leave is now', () => {
      const result = operatorConfigVerdict(
        changed(),
        (() => {
          const c = config();
          ai(c, 'writer').outboundNetwork = false;
          return c;
        })(),
        { operator: 'operator' },
      );
      expect(result.level).toBe('now');
      expect(result.changes.map((row) => row.field).sort()).toEqual(['model', 'onLeave']);
    });

    it('putting back the network is approval, like turning it off', () => {
      const result = operatorConfigVerdict(changed(), config(), { operator: 'operator' });
      expect(result.level).toBe('approval');
      expect(result.changes.map((row) => `${row.field}:${row.level}`).sort()).toEqual([
        'model:now',
        'onLeave:now',
        'outboundNetwork:approval',
      ]);
      expect(result.changes.find((row) => row.field === 'outboundNetwork')).toMatchObject({
        before: 'false',
        after: 'true',
      });
    });

    it('a state that equals the current one is no change, whatever the way there was', () => {
      expect(operatorConfigVerdict(changed(), changed(), { operator: 'operator' })).toEqual({
        level: 'now',
        changes: [],
      });
    });
  });

  it('judges the Operator’s own member by the handle given, not by its role', () => {
    const previous = config();
    const next = structuredClone(previous);
    ai(next, 'writer').model = 'sonnet';
    expect(operatorConfigVerdict(previous, next, { operator: 'operator' }).level).toBe('now');
    expect(operatorConfigVerdict(previous, next, { operator: 'writer' }).level).toBe('approval');
  });

  it('an invitation binding is still a change to a person', () => {
    const previous = config();
    (member(previous, 'ann') as { email?: string }).email = undefined;
    const next = structuredClone(previous);
    (member(next, 'ann') as { email?: string }).email = 'ann@example.com';
    const result = operatorConfigVerdict(previous, next, {
      operator: 'operator',
      invitationBinding: { handle: 'ann', email: 'ann@example.com' },
    });
    expect(result.level).toBe('never');
  });

  it('rows are the same on a repeat', () => {
    const a = verdict((n) => {
      ai(n, 'writer').model = 'sonnet';
      stage(n, 'dev').name = 'X';
    });
    const b = operatorConfigVerdict(a.previous, a.next, { operator: 'operator' });
    expect(b).toEqual(a.result);
  });

  describe('property: what the integrator may not do is at least approval', () => {
    const cases = [...NOW, ...APPROVAL, ...NEVER];

    it.each(cases)('%s', (_name, edit) => {
      const { previous, next, result } = verdict(edit);
      if (integratorConfigRefusal(previous, next) === null) return;
      if (result.level !== 'now') return;
      // The one exception: AI members’ model, effort, capacity and schedule (and leave, which the integrator may change too).
      expect(result.changes.length).toBeGreaterThan(0);
      for (const row of result.changes) {
        expect(row.area).toBe('member');
        expect([...FOUR, 'onLeave']).toContain(row.field);
      }
    });

    it('holds when only the four fields change, and fails when anything else rides along', () => {
      const four = verdict((n) => {
        ai(n, 'writer').model = 'sonnet';
        ai(n, 'writer').effort = 'low';
        ai(n, 'writer').capacity = 2;
        ai(n, 'writer').schedule = { cron: '0 9 * * *', prompt: 'x' };
      });
      expect(integratorConfigRefusal(four.previous, four.next)).toBe('members');
      expect(four.result.level).toBe('now');
      const more = verdict((n) => {
        ai(n, 'writer').model = 'sonnet';
        ai(n, 'writer').provider = 'codex';
      });
      expect(more.result.level).toBe('approval');
    });
  });
});

describe('the Operator member', () => {
  const operator = ai(config(), 'operator');

  it('isOperator: an AI member of the role, not a temp worker, nobody else', () => {
    expect(OPERATOR_ROLE).toBe('ai_operator');
    expect(isOperator(operator)).toBe(true);
    expect(isOperator({ ...operator, temp: true })).toBe(false);
    expect(isOperator(ai(config(), 'pm'))).toBe(false);
    expect(isOperator(member(config(), 'owner'))).toBe(false);
    expect(isOperator(undefined)).toBe(false);
  });

  it('the role is for AI only', () => {
    const human = { kind: 'human', handle: 'x', displayName: 'X', access: 'viewer', roles: ['ai_operator'] };
    const c = config();
    c.team.members.push(human as never);
    // checked by the invariants in invariants.test.ts; here the duty's holders
    expect(ProjectConfig.safeParse(c).success).toBe(true);
  });

  it('operatorOf: the first not on leave, else the first, else null', () => {
    const c = config();
    expect(operatorOf(c)?.handle).toBe('operator');
    ai(c, 'operator').onLeave = true;
    expect(operatorOf(c)?.handle).toBe('operator');
    c.team.members.push({ ...operator, handle: 'operator-2' });
    expect(operatorOf(c)?.handle).toBe('operator-2');
    expect(operatorOf({ team: { ...c.team, members: [member(c, 'owner')] } })).toBeNull();
  });

  it('isRequiredOperator: only when it is the one', () => {
    const c = config();
    expect(isRequiredOperator(c, 'operator')).toBe(true);
    expect(isRequiredOperator(c, 'pm')).toBe(false);
    expect(isRequiredOperator(c, 'nobody')).toBe(false);
    ai(c, 'operator').onLeave = true;
    expect(isRequiredOperator(c, 'operator')).toBe(true);
    c.team.members.push({ ...operator, handle: 'operator-2' });
    expect(isRequiredOperator(c, 'operator')).toBe(false);
  });

  it('isOperatorActor: an AI actor of the Operator, not through the integrator, nobody else', () => {
    const c = config();
    expect(isOperatorActor(c, { kind: 'ai', handle: 'operator' })).toBe(true);
    expect(isOperatorActor(c, { kind: 'ai', handle: 'operator', via: 'integrator' })).toBe(false);
    expect(isOperatorActor(c, { kind: 'human', handle: 'operator' })).toBe(false);
    expect(isOperatorActor(c, { kind: 'ai', handle: 'pm' })).toBe(false);
    expect(isOperatorActor(c, { kind: 'human', handle: 'owner' })).toBe(false);
    expect(isOperatorActor(c, { kind: 'system', handle: null })).toBe(false);
  });

  it('the Operator may move a card out of the first stage; the project manager may not', () => {
    const c = config();
    const operatorActor = { kind: 'ai', handle: 'operator' } as const;
    expect(actorMoveRefusal(c, operatorActor, 'backlog', 'dev')).toBeNull();
    expect(actorMoveRefusal(c, operatorActor, 'review', 'backlog')).toBeNull();
    expect(actorMoveRefusal(c, { kind: 'ai', handle: 'pm' }, 'backlog', 'dev')).toBe(
      'project_manager_move_refused',
    );
  });

  it('the Operator may set a priority, like the project manager and people; other AI members may not', () => {
    const c = config();
    expect(priorityRefusal({ kind: 'ai', handle: 'operator' }, c)).toBeNull();
    expect(priorityRefusal({ kind: 'ai', handle: 'pm' }, c)).toBeNull();
    expect(priorityRefusal({ kind: 'human', handle: 'owner' }, c)).toBeNull();
    expect(priorityRefusal({ kind: 'ai', handle: 'dev-1' }, c)).toBe('priority_humans_only');
  });

  it('level names parse', () => {
    expect(OperatorLevel.options).toEqual(['now', 'approval', 'never']);
    const verdictShape: OperatorConfigVerdict = { level: 'now', changes: [] };
    expect(verdictShape.changes).toEqual([]);
  });
});
