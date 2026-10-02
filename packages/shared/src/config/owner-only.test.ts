import { describe, expect, it } from 'vitest';
import { humanApprovalChanged, approvalPolicyChanged, ownerOnlyChanges } from './owner-only';
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

  it('keeps the old name of the approval policy check', () => {
    expect(humanApprovalChanged).toBe(approvalPolicyChanged);
  });
});
