import { describe, expect, it } from 'vitest';
import { integratorConfigRefusal } from './integrator';
import type { IntegratorRefusal } from './integrator';
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
