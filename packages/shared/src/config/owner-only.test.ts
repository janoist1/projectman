import { describe, expect, it } from 'vitest';
import { ownerOnlyChanges } from './owner-only';
import type { OwnerOnlyChange } from './owner-only';
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
        { kind: 'human', handle: 'new', displayName: 'Not signed up yet', access: 'developer' },
        { kind: 'ai', handle: 'dev-1', displayName: 'Developer', role: 'developer', sponsor: 'owner' },
      ],
      limits: {},
    },
    pipeline: {
      columns: [{ id: 'all', name: 'All' }],
      stages: [
        { id: 'backlog', name: 'Backlog', kind: 'queue', columnId: 'all' },
        {
          id: 'merge',
          name: 'Merge',
          kind: 'step',
          columnId: 'all',
          gate: { conditions: [{ type: 'has_label', label: 'merge-ok' }] },
        },
        {
          id: 'release',
          name: 'Release',
          kind: 'release',
          columnId: 'all',
          gate: { conditions: [{ type: 'has_label', label: 'release-ok' }] },
        },
        { id: 'done', name: 'Done', kind: 'done', columnId: 'all' },
      ],
      labels: [
        { id: 'merge-ok', name: 'Merge ok', setBy: { members: ['owner'], humansOnly: true } },
        { id: 'release-ok', name: 'Release ok', setBy: { members: ['owner'], humansOnly: true } },
        { id: 'tag', name: 'Tag' },
      ],
    },
  });
}

function changed(edit: (next: ProjectConfig) => void, binding?: { handle: string; email: string }) {
  const previous = config();
  const next = structuredClone(previous);
  edit(next);
  return ownerOnlyChanges(previous, next, { invitationBinding: binding });
}

const human = (config: ProjectConfig, handle: string) => {
  const member = config.team.members.find((m) => m.handle === handle);
  if (member?.kind !== 'human') throw new Error(`no human ${handle}`);
  return member;
};

const ai = (config: ProjectConfig, handle: string) => {
  const member = config.team.members.find((m) => m.handle === handle);
  if (member?.kind !== 'ai') throw new Error(`no AI member ${handle}`);
  return member;
};

describe('ownerOnlyChanges', () => {
  it.each([
    [undefined, true, ['email_send_policy']],
    [true, false, ['email_send_policy']],
    [false, undefined, []],
    [false, false, []],
  ] as const)('checks effective email approval policy %#', (before, after, expected) => {
    const previous = config();
    ai(previous, 'dev-1').email = { enabled: true, sendWithoutApproval: before };
    const next = structuredClone(previous);
    ai(next, 'dev-1').email = { enabled: true, sendWithoutApproval: after };
    expect(ownerOnlyChanges(previous, next)).toEqual(expected);
  });
  it.each([
    ['switching sending off', true, false],
    ['switching sending on over a stale bypass', false, true],
  ])('lets an admin clear the bypass by %s', (_name, wasEnabled, enabled) => {
    const previous = config();
    ai(previous, 'dev-1').email = { enabled: wasEnabled, sendWithoutApproval: true };
    const next = structuredClone(previous);
    ai(next, 'dev-1').email = { enabled, sendWithoutApproval: false };
    expect(ownerOnlyChanges(previous, next)).toEqual([]);
  });
  it('requires an owner for a new sender starting without approval', () => {
    expect(
      changed((c) => {
        c.team.members.push({
          ...ai(c, 'dev-1'),
          handle: 'dev-2',
          permissionMode: 'auto',
          approver: 'none',
          email: { enabled: true, sendWithoutApproval: true },
        });
      }),
    ).toEqual(['email_send_policy']);
  });
  it('allows admins to change project and sender enablement', () => {
    expect(
      changed((c) => {
        c.project.email = { enabled: true };
        ai(c, 'dev-1').email = { enabled: true };
      }),
    ).toEqual([]);
  });
  it.each<[string, (next: ProjectConfig) => void, OwnerOnlyChange[]]>([
    ['no change', () => {}, []],
    ['a display name', (c) => void (human(c, 'ann').displayName = 'Anna'), []],
    ['an unrelated label', (c) => void (c.pipeline.labels[2]!.name = 'Other'), []],
    ['the workspace', (c) => void (c.project.workspacePath = '/elsewhere'), ['locations']],
    ['a repository path', (c) => void (c.project.repos[0]!.path = 'app'), ['locations']],
    ['granting admin', (c) => void (human(c, 'ann').access = 'admin'), ['admin_or_account']],
    ['an account binding', (c) => void (human(c, 'ann').email = 'other@example.com'), ['admin_or_account']],
    [
      'binding an unclaimed seat',
      (c) => void (human(c, 'new').email = 'new@example.com'),
      ['admin_or_account'],
    ],
    ['who may approve a merge', (c) => void (c.pipeline.labels[0]!.setBy = 'humans'), ['approval_policy']],
    [
      'narrowing an approval to the cards with a label',
      (c) =>
        void (c.pipeline.stages[1]!.gate!.conditions[0] = {
          type: 'has_label',
          label: 'merge-ok',
          when: 'tag',
        }),
      ['approval_policy'],
    ],
    [
      'binding a condition on a label nobody has to approve',
      (c) =>
        void c.pipeline.stages[1]!.gate!.conditions.push({ type: 'lacks_label', label: 'tag', when: 'tag' }),
      [],
    ],
    ['removing an approval gate', (c) => void delete c.pipeline.stages[1]!.gate, ['approval_policy']],
    ['release four eyes', (c) => void (c.team.releaseFourEyes = true), ['approval_policy']],
    [
      'who approves releases',
      (c) => void (c.pipeline.labels[1]!.setBy = { members: ['owner', 'ann'], humansOnly: true }),
      ['approval_policy', 'release_approvers'],
    ],
    ['who is an owner', (c) => void (human(c, 'ann').access = 'owner'), ['owners']],
    [
      "an owner's account",
      (c) => void (human(c, 'owner').email = 'boss@example.com'),
      ['admin_or_account', 'owners'],
    ],
    ['an AI member mode', (c) => void (ai(c, 'dev-1').permissionMode = 'plan'), ['permissions']],
    [
      'freeing the mode to bypassPermissions',
      (c) => void (ai(c, 'dev-1').permissionMode = 'bypassPermissions'),
      ['permissions'],
    ],
    ['an AI member approver', (c) => void (ai(c, 'dev-1').approver = 'none'), ['permissions']],
    ['the AI approver', (c) => void (ai(c, 'dev-1').approver = 'ai'), ['permissions']],
    [
      // An absent approver already means a person.
      'restating the default approver',
      (c) => void (ai(c, 'dev-1').approver = 'human'),
      [],
    ],
    [
      'a new AI member on the default mode and approver (Auto, nobody)',
      (c) =>
        void c.team.members.push({
          ...ai(c, 'dev-1'),
          handle: 'dev-2',
          permissionMode: 'auto',
          approver: 'none',
        }),
      [],
    ],
    [
      'a new AI member on another mode',
      (c) =>
        void c.team.members.push({
          ...ai(c, 'dev-1'),
          handle: 'dev-2',
          permissionMode: 'acceptEdits',
          approver: 'none',
        }),
      ['permissions'],
    ],
    [
      'a new AI member with another approver (the unset one reads as a person)',
      (c) => void c.team.members.push({ ...ai(c, 'dev-1'), handle: 'dev-2', permissionMode: 'auto' }),
      ['permissions'],
    ],
    [
      'an AI member outbound network setting',
      (c) => void (ai(c, 'dev-1').outboundNetwork = false),
      ['permissions'],
    ],
    [
      'a new AI member with outbound network off',
      (c) =>
        void c.team.members.push({
          ...ai(c, 'dev-1'),
          handle: 'dev-2',
          permissionMode: 'auto',
          approver: 'none',
          outboundNetwork: false,
        }),
      ['permissions'],
    ],
    [
      'a new AI member with outbound network on (default)',
      (c) =>
        void c.team.members.push({
          ...ai(c, 'dev-1'),
          handle: 'dev-2',
          permissionMode: 'auto',
          approver: 'none',
          outboundNetwork: true,
        }),
      [],
    ],
  ])('%s', (_name, edit, expected) => {
    expect(changed(edit)).toEqual(expected);
  });

  it('lets an invitation bind the unclaimed seat it was made for, and nothing else', () => {
    const binding = { handle: 'new', email: 'new@example.com' };
    expect(changed((c) => void (human(c, 'new').email = 'new@example.com'), binding)).toEqual([]);
    expect(changed((c) => void (human(c, 'new').email = 'someone@example.com'), binding)).toEqual([
      'admin_or_account',
    ]);
    expect(changed((c) => void (human(c, 'ann').email = 'new@example.com'), binding)).toEqual([
      'admin_or_account',
    ]);
  });

  it.each([
    (c: ProjectConfig) => {
      c.team.boundary = { enabled: true, leadTimeoutSeconds: 120 };
    },
    (c: ProjectConfig) => {
      c.team.roleOverrides = {
        developer: { duties: ['implementation', 'boundary_authorization'], instructions: '' },
      };
    },
    (c: ProjectConfig) => {
      ai(c, 'dev-1').role = 'lead_developer';
    },
    (c: ProjectConfig) => {
      c.team.roles.push({
        id: 'new_lead',
        name: 'Lead',
        summary: 'Decide',
        holders: 'both',
        duties: ['boundary_authorization'],
        instructions: '',
        notTheirJob: '',
      });
    },
  ])('requires owner access for delegation configuration and duty assignments', (edit) => {
    expect(changed(edit)).toContain('approval_policy');
  });

  it.each([
    ['switching it on', (c: ProjectConfig) => void (ai(c, 'dev-1').machineAccess = true)],
    [
      'making the member a project manager',
      (c: ProjectConfig) => void (ai(c, 'dev-1').role = 'project_manager'),
    ],
    [
      'adding a member who has it',
      (c: ProjectConfig) =>
        void c.team.members.push({ ...ai(c, 'dev-1'), handle: 'dev-2', machineAccess: true }),
    ],
  ])('requires an owner for machine access by %s', (_name, edit) => {
    expect(changed(edit)).toContain('machine_access');
  });
  it('leaves machine access to an admin when the effective value stays', () => {
    const previous = config();
    ai(previous, 'dev-1').role = 'project_manager';
    const next = structuredClone(previous);
    ai(next, 'dev-1').machineAccess = true;
    expect(ownerOnlyChanges(previous, next)).toEqual([]);
  });
  it('leaves a new member without machine access to an admin', () => {
    expect(changed((c) => void c.team.members.push({ ...ai(c, 'dev-1'), handle: 'dev-2' }))).not.toContain(
      'machine_access',
    );
  });

  it('requires an owner to change who may open a new card (PM-1100)', () => {
    expect(changed((c) => void (c.team.taskCreateAccess = 'client'))).toContain('task_create_access');
  });
  it('leaves restating the default new card access to an admin', () => {
    expect(changed((c) => void (c.team.taskCreateAccess = 'developer'))).toEqual([]);
  });
});
