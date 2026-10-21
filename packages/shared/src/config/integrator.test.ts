import { describe, expect, it } from 'vitest';
import { integratorConfigRefusal, superAccessVerdict } from './integrator';
import type { IntegratorRefusal } from './integrator';
import { ProjectConfig } from './schema';
import { ownerReservedEffect } from './super-mutation';
import type { SuperMutationCommand } from './super-mutation';

function config(): ProjectConfig {
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
        { kind: 'human', handle: 'bob', displayName: 'Bob', access: 'viewer', email: 'bob@example.com' },
        { kind: 'ai', handle: 'dev-1', displayName: 'Developer', role: 'developer', sponsor: 'owner' },
        { kind: 'ai', handle: 'dev-2', displayName: 'Developer 2', role: 'developer', sponsor: 'owner' },
        { kind: 'ai', handle: 'rev-1', displayName: 'Reviewer', role: 'checker', sponsor: 'owner' },
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
          gate: {
            conditions: [
              { type: 'has_label', label: 'merge-ok' },
              { type: 'has_label', label: 'design-ok', when: 'ui' },
            ],
          },
        },
        { id: 'done', name: 'Done', kind: 'done', columnId: 'all' },
      ],
      labels: [
        { id: 'merge-ok', name: 'Merge ok', setBy: { members: ['owner'], humansOnly: true } },
        { id: 'design-ok', name: 'Design ok', setBy: { members: ['ann'] }, group: 'design' },
        { id: 'checked', name: 'Checked', setBy: { duties: ['code_review'] }, notByAuthor: true },
        { id: 'ui', name: 'UI' },
        { id: 'refine', name: 'Refine', setBy: 'anyone', color: 'blue' },
      ],
    },
  });
}

describe('credential operation access (PM-759)', () => {
  const operations = ['read', 'write', 'approval', 'key_management'] as const;
  for (const mode of ['legacy', 'super', 'read'] as const) {
    it.each(operations)(`${mode} checks %s independently of transport`, (operation) => {
      const project = config();
      project.team.members.push({
        ...project.team.members.find((m) => m.kind === 'ai')!,
        handle: 'operator',
        role: 'ai_operator',
      } as ProjectConfig['team']['members'][number]);
      const code =
        mode === 'read' && operation !== 'read'
          ? 'integrator_read_only'
          : operation === 'approval' && mode === 'legacy'
            ? 'owner_approval_required'
            : operation === 'key_management'
              ? 'integrator_not_allowed'
              : null;
      expect(superAccessVerdict(project, { mode, operation, ownerMembership: true })).toEqual(
        code ? { allowed: false, code } : { allowed: true },
      );
      if (
        operation === 'read' ||
        (operation === 'write' && mode !== 'read') ||
        (operation === 'approval' && mode === 'super')
      )
        expect(superAccessVerdict(project, { mode, operation, ownerMembership: false })).toEqual({
          allowed: false,
          code: 'insufficient_access',
        });
    });
  }
  it('requires the project Operator only for super execution', () => {
    expect(
      superAccessVerdict(config(), { mode: 'super', operation: 'write', ownerMembership: true }),
    ).toEqual({ allowed: false, code: 'integrator_not_allowed' });
    expect(
      superAccessVerdict(config(), { mode: 'super', operation: 'approval', ownerMembership: true }),
    ).toEqual({ allowed: false, code: 'integrator_not_allowed' });
    expect(superAccessVerdict(config(), { mode: 'read', operation: 'read', ownerMembership: true })).toEqual({
      allowed: true,
    });
  });
});

describe('reserved mutation effects (PM-759)', () => {
  it.each([
    ['member removal', (c: ProjectConfig): unknown => c.team.members.pop(), 'deletion'],
    ['repository removal', (c: ProjectConfig) => c.project.repos.pop(), 'deletion'],
    ['role removal', (c: ProjectConfig) => c.team.roles.pop(), null],
    ['label removal', (c: ProjectConfig) => c.pipeline.labels.pop(), null],
    ['stage removal', (c: ProjectConfig) => c.pipeline.stages.pop(), null],
    ['column removal', (c: ProjectConfig) => c.pipeline.columns.pop(), null],
    ['gate removal', (c: ProjectConfig) => c.pipeline.stages[2]!.gate!.conditions.pop(), null],
    ['workspace relocation', (c: ProjectConfig): unknown => (c.project.workspacePath = '/other'), null],
    ['repository relocation', (c: ProjectConfig): unknown => (c.project.repos[0]!.path = '/other'), null],
    ['default branch', (c: ProjectConfig): unknown => (c.project.repos[0]!.defaultBranch = 'other'), null],
    ['GitHub destination', (c: ProjectConfig): unknown => (c.project.repos[0]!.github = 'other/repo'), null],
    [
      'member access change',
      (c: ProjectConfig) => {
        const m = c.team.members.find((m) => m.handle === 'ann')!;
        if (m.kind === 'human') m.access = 'admin';
      },
      'security',
    ],
    [
      'login email rebinding',
      (c: ProjectConfig) => {
        const m = c.team.members.find((m) => m.handle === 'ann')!;
        if (m.kind === 'human') m.email = 'ann@elsewhere.example.com';
      },
      'security',
    ],
    [
      'human owner turned into an AI member under the same handle',
      (c: ProjectConfig) =>
        c.team.members.splice(0, 1, {
          kind: 'ai',
          handle: 'owner',
          displayName: 'Owner',
          role: 'developer',
          sponsor: 'ann',
        } as ProjectConfig['team']['members'][number]),
      'security',
    ],
    [
      'AI approver switched off',
      (c: ProjectConfig) => {
        const m = c.team.members.find((m) => m.handle === 'dev-1')!;
        if (m.kind === 'ai') m.approver = 'none';
      },
      'security',
    ],
    [
      'AI outbound network setting',
      (c: ProjectConfig) => {
        const m = c.team.members.find((m) => m.handle === 'dev-1')!;
        if (m.kind === 'ai') m.outboundNetwork = false;
      },
      'security',
    ],
    [
      'boundary delegation switched on',
      (c: ProjectConfig) => (c.team.boundary = { enabled: true, leadTimeoutSeconds: 120 }),
      'security',
    ],
    [
      'new owner member',
      (c: ProjectConfig) =>
        c.team.members.push({
          kind: 'human',
          handle: 'eve',
          displayName: 'Eve',
          access: 'owner',
          email: 'eve@example.com',
          roles: [],
        }),
      'security',
    ],
    [
      'new non-owner human member',
      (c: ProjectConfig) =>
        c.team.members.push({
          kind: 'human',
          handle: 'eve',
          displayName: 'Eve',
          access: 'developer',
          email: 'eve@example.com',
          roles: [],
        }),
      null,
    ],
    ['approval waiver', (c: ProjectConfig): unknown => (c.team.operatorApprovalWaiver = true), 'security'],
    [
      'new paid member',
      (c: ProjectConfig) => {
        const m = c.team.members.find((m) => m.kind === 'ai')!;
        if (m.kind === 'ai') m.provider = 'nanogpt';
      },
      'cost',
    ],
    [
      'new feedback origin',
      (c: ProjectConfig) =>
        (c.project.feedback = {
          surfaces: [{ id: 'web', name: 'Web', origin: 'https://example.test' }],
          blockedMarkers: [],
        }),
      null,
    ],
  ] as const)('classifies %s before committing', (_name, change, effect) => {
    const before = config();
    const next = structuredClone(before);
    change(next);
    expect(ownerReservedEffect(before, { kind: 'config_change', next })).toBe(effect);
  });
  it('allows changes of the complete approval circle and ordinary subscription settings', () => {
    const before = config();
    const next = structuredClone(before);
    next.pipeline.labels[0]!.setBy = { members: ['ann'], humansOnly: true };
    next.team.roles[0]!.duties = ['implementation'];
    const member = next.team.members.find((m) => m.kind === 'ai')!;
    if (member.kind === 'ai') {
      member.model = 'subscription-model';
      member.capacity = 2;
    }
    expect(ownerReservedEffect(before, { kind: 'config_change', next })).toBeNull();
    next.pipeline.stages[2]!.gate!.conditions.reverse();
    expect(ownerReservedEffect(before, { kind: 'config_change', next })).toBeNull();
  });
  it('protects paid capacity, scheduling, resume, AI enablement and cap increases', () => {
    const before = config();
    const paid = before.team.members.find((m) => m.kind === 'ai')!;
    if (paid.kind !== 'ai') throw new Error('fixture needs an AI member');
    paid.provider = 'nanogpt';
    paid.onLeave = true;
    before.team.limits.aiEnabled = false;
    const changes = [
      (c: ProjectConfig) => {
        const m = c.team.members.find((m) => m.handle === paid.handle)!;
        if (m.kind === 'ai') m.schedule = { cron: '0 * * * *', prompt: 'Run a paid job' };
      },
      (c: ProjectConfig) => {
        const m = c.team.members.find((m) => m.handle === paid.handle)!;
        if (m.kind === 'ai') m.onLeave = false;
      },
      (c: ProjectConfig) => {
        const m = c.team.members.find((m) => m.handle === paid.handle)!;
        if (m.kind === 'ai') m.capacity++;
      },
      (c: ProjectConfig) => {
        const m = c.team.members.find((m) => m.handle === paid.handle)!;
        if (m.kind === 'ai') m.model = 'other';
      },
      (c: ProjectConfig) => {
        c.team.limits.aiEnabled = true;
      },
      (c: ProjectConfig) => {
        delete c.team.limits.maxConcurrentAi;
      },
    ];
    for (const change of changes) {
      const next = structuredClone(before);
      change(next);
      expect(ownerReservedEffect(before, { kind: 'config_change', next })).toBe('cost');
    }
    expect(ownerReservedEffect(before, { kind: 'runtime_start', providers: ['nanogpt'] })).toBe('cost');
    expect(ownerReservedEffect(before, { kind: 'runtime_start', providers: ['codex'] })).toBeNull();
  });
  it('uses deterministic precedence and refuses unknown or incomplete projections', () => {
    const next = structuredClone(config());
    next.team.members.pop();
    next.team.operatorApprovalWaiver = true;
    expect(ownerReservedEffect(config(), { kind: 'config_change', next })).toBe('deletion');
    const securityAndCost = structuredClone(config());
    securityAndCost.team.operatorApprovalWaiver = true;
    securityAndCost.team.limits.aiEnabled = true;
    const paidDev = securityAndCost.team.members.find((m) => m.kind === 'ai')!;
    if (paidDev.kind === 'ai') paidDev.provider = 'nanogpt';
    expect(ownerReservedEffect(config(), { kind: 'config_change', next: securityAndCost })).toBe('security');
    expect(() => ownerReservedEffect(null, { kind: 'config_change', next })).toThrow();
    expect(() =>
      ownerReservedEffect(null, { kind: 'routine', operation: 'sudo' } as unknown as SuperMutationCommand),
    ).toThrow();
    expect(() => ownerReservedEffect(null, { kind: 'unknown' } as unknown as SuperMutationCommand)).toThrow();
  });
  it.each([
    ['member', 'deletion'],
    ['repo', 'deletion'],
    ['project', 'deletion'],
    ['credential', 'deletion'],
    ['label', null],
    ['stage', null],
    ['column', null],
    ['role', null],
    ['feedback_surface', null],
    ['invitation', null],
    ['guest', null],
    ['engine', null],
    ['attachment', null],
    ['message_attachment', null],
    ['task', null],
  ] as const)('classifies removing a %s as %s', (resource, effect) => {
    expect(ownerReservedEffect(null, { kind: 'remove', resource, id: 'x' })).toBe(effect);
  });
  it('reserves an access change for the owner and frees visibility, focus and deploy', () => {
    expect(
      ownerReservedEffect(null, {
        kind: 'access_change',
        handle: 'ann',
        before: 'developer',
        after: 'admin',
      }),
    ).toBe('security');
    expect(
      ownerReservedEffect(null, { kind: 'task_visibility', taskKey: null, before: null, after: 'shared' }),
    ).toBeNull();
    expect(
      ownerReservedEffect(null, { kind: 'focus_change', before: ['AC-1', 'AC-2'], after: ['AC-2', 'AC-1'] }),
    ).toBeNull();
    expect(ownerReservedEffect(null, { kind: 'administration', command: 'deploy' })).toBeNull();
    for (const operation of ['task_create', 'task_start', 'inbox_resolve'] as const)
      expect(ownerReservedEffect(null, { kind: 'routine', operation })).toBeNull();
  });
});

function refusal(edit: (next: ProjectConfig) => void, base: () => ProjectConfig = config) {
  const previous = base();
  const next = structuredClone(previous);
  edit(next);
  return integratorConfigRefusal(previous, next);
}

const label = (c: ProjectConfig, id: string) => {
  const found = c.pipeline.labels.find((l) => l.id === id);
  if (!found) throw new Error(`no label ${id}`);
  return found;
};
const stage = (c: ProjectConfig, id: string) => {
  const found = c.pipeline.stages.find((s) => s.id === id);
  if (!found) throw new Error(`no stage ${id}`);
  return found;
};
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

describe('integratorConfigRefusal', () => {
  it('lets an unchanged configuration through', () => {
    expect(refusal(() => {})).toBeNull();
  });

  describe('approval_rules', () => {
    it.each<[string, (next: ProjectConfig) => void]>([
      ['a human-only label setBy', (n) => (label(n, 'merge-ok').setBy = { members: ['owner', 'ann'] })],
      ['a human-only label opened to anyone', (n) => (label(n, 'merge-ok').setBy = 'anyone')],
      ['a label that is required by a gate: setBy', (n) => (label(n, 'design-ok').setBy = 'anyone')],
      ['notByAuthor of a protected label', (n) => delete label(n, 'checked').notByAuthor],
      ['the group of a protected label', (n) => (label(n, 'design-ok').group = 'other')],
      ['requiresComment of a protected label', (n) => (label(n, 'merge-ok').requiresComment = true)],
      ['clearedWhen of a protected label', (n) => (label(n, 'merge-ok').clearedWhen = ['moved_back'])],
      ['blocks of a protected label', (n) => (label(n, 'merge-ok').blocks = true)],
      [
        'the removal of a protected label',
        (n) => (n.pipeline.labels = n.pipeline.labels.filter((l) => l.id !== 'merge-ok')),
      ],
      [
        'a gate condition added',
        (n) => stage(n, 'review').gate?.conditions.push({ type: 'has_label', label: 'checked' }),
      ],
      ['a gate condition removed', (n) => stage(n, 'review').gate?.conditions.pop()],
      [
        'a gate condition added that only strengthens the gate',
        (n) => stage(n, 'review').gate?.conditions.push({ type: 'lacks_label', label: 'refine' }),
      ],
      [
        'the when of a gate condition',
        (n) => {
          const condition = stage(n, 'review').gate?.conditions[1];
          if (condition) condition.when = 'refine';
        },
      ],
      [
        'the when of a gate condition taken off',
        (n) => {
          const condition = stage(n, 'review').gate?.conditions[1];
          if (condition) delete condition.when;
        },
      ],
      [
        'a gated stage removed',
        (n) => (n.pipeline.stages = n.pipeline.stages.filter((s) => s.id !== 'review')),
      ],
      ['a gated stage moved', (n) => n.pipeline.stages.reverse()],
      ['the kind of a gated stage', (n) => (stage(n, 'review').kind = 'work')],
      [
        'an ungated done stage before a gated one',
        (n) =>
          n.pipeline.stages.splice(2, 0, { id: 'shortcut', name: 'Shortcut', kind: 'done', columnId: 'all' }),
      ],
      [
        'the work stage moved before the backlog',
        (n) => n.pipeline.stages.unshift(...n.pipeline.stages.splice(1, 1)),
      ],
      [
        'an ungated stage removed',
        (n) => (n.pipeline.stages = n.pipeline.stages.filter((s) => s.id !== 'dev')),
      ],
      ['the kind of an ungated stage', (n) => (stage(n, 'dev').kind = 'step')],
      [
        'the duties of a role that sets a protected label',
        (n) => {
          const role = n.team.roles.find((r) => r.id === 'checker');
          if (role) role.duties = [];
        },
      ],
      [
        'a role override that gives a protected label to a role',
        (n) =>
          (n.team.roleOverrides = {
            developer: { duties: ['implementation', 'code_review'], instructions: '' },
          }),
      ],
      [
        'a member given the role that holds a protected label',
        (n) => {
          const dev = ai(n, 'dev-2');
          dev.role = 'checker';
        },
      ],
    ])('refuses %s', (_name, edit) => {
      expect(refusal(edit)).toBe('approval_rules');
    });

    it('refuses a label that is protected only in the new configuration', () => {
      // A new human-only label, and a label a gate starts to require.
      expect(refusal((n) => n.pipeline.labels.push({ id: 'new-ok', name: 'New ok', setBy: 'humans' }))).toBe(
        'approval_rules',
      );
      expect(
        refusal((n) => {
          stage(n, 'review').gate?.conditions.push({ type: 'has_label', label: 'ui' });
        }),
      ).toBe('approval_rules');
    });

    it('refuses a label that is protected only in the old configuration', () => {
      // The key takes the label out of the circle first: the gate no longer asks for it...
      const base = () => {
        const c = config();
        label(c, 'ui').setBy = { members: ['ann'] };
        stage(c, 'review').gate?.conditions.push({ type: 'has_label', label: 'ui' });
        return c;
      };
      expect(refusal((n) => stage(n, 'review').gate?.conditions.pop(), base)).toBe('approval_rules');
    });

    it.each<[string, (next: ProjectConfig) => void]>([
      ['the name of a protected label', (n) => (label(n, 'merge-ok').name = 'Merge approved')],
      ['the meaning of a protected label', (n) => (label(n, 'merge-ok').meaning = 'The merge is fine')],
      ['the color of a protected label', (n) => (label(n, 'merge-ok').color = 'red')],
      [
        'a plain label: everything',
        (n) => Object.assign(label(n, 'refine'), { setBy: { members: ['dev-1'] }, group: 'x' }),
      ],
      [
        'a plain label removed',
        (n) => (n.pipeline.labels = n.pipeline.labels.filter((l) => l.id !== 'refine')),
      ],
      ['a plain label added', (n) => n.pipeline.labels.push({ id: 'extra', name: 'Extra', setBy: 'anyone' })],
      ['the name of an ungated stage', (n) => (stage(n, 'dev').name = 'Development')],
      ['the owners of a stage', (n) => (stage(n, 'review').owners = ['ann'])],
      [
        'the instructions of a role',
        (n) =>
          (n.team.roleOverrides = { developer: { duties: ['implementation'], instructions: 'Be kind' } }),
      ],
      ['the gate conditions reordered', (n) => stage(n, 'review').gate?.conditions.reverse()],
    ])('lets through %s', (_name, edit) => {
      const base = () => {
        const c = config();
        c.team.roleOverrides = { developer: { duties: ['implementation'], instructions: '' } };
        return c;
      };
      expect(refusal(edit, base)).toBeNull();
    });
  });

  describe('owner_settings', () => {
    it.each<[string, (next: ProjectConfig) => void]>([
      ['a repository path', (n) => (n.project.repos[0]!.path = 'other')],
      ['the workspace path', (n) => (n.project.workspacePath = '/work/other')],
      ['the permission mode of an AI member', (n) => (ai(n, 'dev-1').permissionMode = 'plan')],
      ['the maxFixRounds limit', (n) => (n.team.limits.maxFixRounds = 5)],
      ['release four eyes', (n) => (n.team.releaseFourEyes = true)],
      [
        'the full test command of a repository',
        (n) => (n.project.repos[0]!.reviewTest = { command: 'true', maxWorkers: 2, timeoutMinutes: 15 }),
      ],
      ['running the full test only at the merge', (n) => (n.project.repos[0]!.fullTestAtMerge = true)],
    ])('refuses %s', (_name, edit) => {
      expect(refusal(edit)).toBe('owner_settings');
    });

    it('treats an absent maxFixRounds as the default', () => {
      expect(refusal((n) => (n.team.limits.maxFixRounds = 3))).toBeNull();
      expect(refusal((n) => (n.team.limits.maxFixRounds = 4))).toBe('owner_settings');
    });

    it('lets through the project name and the other limits', () => {
      expect(refusal((n) => (n.project.name = 'Acme Ltd'))).toBeNull();
      expect(refusal((n) => (n.team.limits.maxConcurrentAi = 5))).toBeNull();
    });
  });

  describe('members', () => {
    it.each<[string, (next: ProjectConfig) => void]>([
      ['a human member added', (n) => n.team.members.push({ ...member(n, 'bob'), handle: 'carl' })],
      ['a human member removed', (n) => (n.team.members = n.team.members.filter((m) => m.handle !== 'bob'))],
      ['the access of a human member', (n) => ((member(n, 'bob') as { access: string }).access = 'client')],
      [
        'the roles of a human member',
        (n) => ((member(n, 'bob') as { roles?: string[] }).roles = ['designer']),
      ],
      ['the name of a member', (n) => (member(n, 'bob').displayName = 'Bobby')],
      [
        'an AI member added',
        (n) =>
          n.team.members.push({
            ...ai(n, 'dev-2'),
            handle: 'dev-3',
            permissionMode: 'auto',
            approver: 'none',
          }),
      ],
      ['an AI member removed', (n) => (n.team.members = n.team.members.filter((m) => m.handle !== 'dev-2'))],
      ['the model of an AI member', (n) => (ai(n, 'dev-1').model = 'other-model')],
      [
        'the temporary workers',
        (n) => (n.team.limits.tempWorkers.enabled = !n.team.limits.tempWorkers.enabled),
      ],
    ])('refuses %s', (_name, edit) => {
      expect(refusal(edit)).toBe('members');
    });

    it('lets members go on leave and come back', () => {
      expect(refusal((n) => (ai(n, 'dev-1').onLeave = true))).toBeNull();
      const base = () => {
        const c = config();
        ai(c, 'dev-1').onLeave = true;
        return c;
      };
      expect(refusal((n) => delete ai(n, 'dev-1').onLeave, base)).toBeNull();
    });

    it('refuses leave together with another change of the member', () => {
      expect(
        refusal((n) => {
          ai(n, 'dev-1').onLeave = true;
          ai(n, 'dev-1').model = 'other-model';
        }),
      ).toBe('members');
    });

    it('does not count the order of the members or a value sent again', () => {
      expect(refusal((n) => n.team.members.reverse())).toBeNull();
      expect(refusal((n) => (ai(n, 'dev-1').model = ai(n, 'dev-1').model))).toBeNull();
    });
  });

  it('names the first category in the documented order', () => {
    const dropBob = (n: ProjectConfig) => (n.team.members = n.team.members.filter((m) => m.handle !== 'bob'));
    const order: (IntegratorRefusal | null)[] = [
      refusal((n) => {
        label(n, 'merge-ok').setBy = 'anyone';
        n.project.workspacePath = '/work/other';
        dropBob(n);
      }),
      refusal((n) => {
        n.project.workspacePath = '/work/other';
        dropBob(n);
      }),
      refusal(dropBob),
    ];
    expect(order).toEqual(['approval_rules', 'owner_settings', 'members']);
  });
});
