import { describe, expect, it } from 'vitest';
import { DUTIES, DUTY_GROUPS, DUTY_IDS } from '../domain/duty';
import { dutyHolders, roleHolders, RoleOverrides } from '../domain/role';
import { ProjectConfig } from './schema';
import { dutyMembers, memberDuties, roleBundle, stageOwners } from './duties';
import { labelHolders } from './labels';
import { applyConfigPatch, humanApprovalChanged, PatchConfigRequest } from './edit';
import { validateProjectConfig } from './invariants';

function config() {
  return ProjectConfig.parse({
    schemaVersion: 1,
    project: { key: 'EX', name: 'Example', workspacePath: '/tmp/example', repos: [] },
    team: {
      members: [
        {
          kind: 'human',
          handle: 'owner',
          displayName: 'Owner',
          access: 'owner',
          roles: ['operator', 'product_owner'],
        },
        { kind: 'ai', handle: 'builder', displayName: 'Builder', role: 'developer', sponsor: 'owner' },
      ],
      limits: {},
    },
    pipeline: {
      columns: [{ id: 'all', name: 'All' }],
      stages: [
        { id: 'queue', name: 'Queue', kind: 'queue', columnId: 'all' },
        { id: 'work', name: 'Work', kind: 'work', duty: 'implementation', columnId: 'all' },
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
        {
          id: 'release-ok',
          name: 'Release ok',
          setBy: { duties: ['release_approval'], humansOnly: true },
        },
      ],
    },
  });
}

describe('duty bundles', () => {
  it('has a fixed catalogue, English fragments, integration metadata and derived eligibility', () => {
    expect(DUTY_IDS).toHaveLength(26);
    for (const id of DUTY_IDS) {
      expect(DUTIES[id].id).toBe(id);
      if (DUTIES[id].holders !== 'human') expect(DUTIES[id].prompt).not.toBe('');
      expect(DUTIES[id].events).toBeInstanceOf(Array);
    }
    for (const group of DUTY_GROUPS) expect(DUTY_IDS.some((id) => DUTIES[id].group === group)).toBe(true);
    expect(dutyHolders(['implementation', 'code_review'])).toBe('both');
    expect(dutyHolders(['implementation', 'release_approval'])).toBe('human');
    expect(dutyHolders([])).toBe('both');
    expect(RoleOverrides.safeParse({ unknown: { duties: [] } }).success).toBe(false);
  });
  it('unions a human’s roles and resolves stage owners and the humans who may set approval labels', () => {
    const c = config();
    expect(memberDuties(c, c.team.members[0]!)).toEqual(
      expect.arrayContaining(['final_decision', 'prioritization', 'release_approval']),
    );
    expect(stageOwners(c, c.pipeline.stages[1]!)).toEqual(['builder']);
    const approval = {
      id: 'x',
      name: 'X',
      setBy: { duties: ['release_approval' as const], humansOnly: true },
    };
    expect(labelHolders(c, approval)).toEqual(['owner']);
    expect(
      labelHolders(c, { ...approval, setBy: { members: ['builder', 'owner'], humansOnly: true } }),
    ).toEqual(['owner']);
    c.pipeline.stages[1]!.owners = [];
    expect(stageOwners(c, c.pipeline.stages[1]!)).toEqual([]);
  });
  it('replaces built-in bundles and resets by removing the override', () => {
    const c = config();
    const next = applyConfigPatch(
      c,
      PatchConfigRequest.parse({
        baseVersion: 'v1',
        roleOverrides: { developer: { duties: ['docs'], instructions: 'Explain changes.' } },
      }),
    );
    expect(dutyMembers(next, 'implementation')).toEqual([]);
    expect(roleBundle(next, 'developer').duties).toEqual(['docs']);
    expect(
      roleBundle(applyConfigPatch(next, { baseVersion: 'v2', roleOverrides: {} }), 'developer').duties,
    ).toEqual(['implementation']);
  });
  it('reports dependency errors and recommendation warnings separately', () => {
    const c = config();
    c.team.roleOverrides = {
      developer: { duties: [], instructions: '' },
      operator: { duties: ['final_decision'], instructions: '' },
    };
    const issues = validateProjectConfig(c);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'missing_duty_holder', detail: 'implementation' }),
        expect.objectContaining({ code: 'missing_duty_holder', detail: 'release_approval' }),
        expect.objectContaining({
          code: 'recommended_duty_unfilled',
          severity: 'warning',
          detail: 'retro_facilitation',
        }),
      ]),
    );
    expect(validateProjectConfig(config()).every((i) => i.severity === 'warning')).toBe(true);
  });
  it('rejects AI holders and temporary workers with human-only duties', () => {
    const c = config();
    c.team.roleOverrides = { developer: { duties: ['release_approval'], instructions: '' } };
    expect(roleHolders('developer', [], c.team.roleOverrides)).toBe('human');
    expect(validateProjectConfig(c).filter((i) => i.code === 'role_not_for_ai')).toHaveLength(2);
  });
  it('protects release membership, bundle grants and four eyes independently of gate spelling', () => {
    const c = config();
    for (const change of [
      (next: ProjectConfig) => {
        next.team.releaseFourEyes = true;
      },
      (next: ProjectConfig) => {
        next.team.roleOverrides = { docs: { duties: ['release_approval'], instructions: '' } };
      },
      (next: ProjectConfig) => {
        next.team.members[0]!.handle = 'other';
      },
      (next: ProjectConfig) => {
        next.team.roles.push({
          id: 'release_lead',
          name: 'Release lead',
          summary: 'Decides releases.',
          notTheirJob: '',
          holders: 'both',
          duties: ['release_approval'],
          instructions: '',
        });
      },
    ]) {
      const next = structuredClone(c);
      change(next);
      expect(humanApprovalChanged(c, next)).toBe(true);
    }
  });
  it.each(['human', 'ai', 'both'] as const)(
    'keeps legacy %s roles free of all duties and preserves declared holders',
    (holders) => {
      const c = config();
      c.team.roles.push({
        id: 'legacy_notes',
        name: 'Notes',
        summary: 'Keeps notes.',
        notTheirJob: '',
        holders,
        instructions: 'Write notes.',
      });
      const owner = c.team.members[0]!;
      if (owner.kind === 'human') owner.roles = ['legacy_notes'];
      expect(roleHolders('legacy_notes', c.team.roles)).toBe(holders);
      expect(roleBundle(c, 'legacy_notes')).toEqual({ duties: [], instructions: 'Write notes.' });
      expect(memberDuties(c, c.team.members[0]!)).toEqual([]);
      const decision = {
        id: 'x',
        name: 'X',
        setBy: { duties: ['final_decision' as const], humansOnly: true },
      };
      expect(labelHolders(c, decision)).toEqual([]);
      expect(labelHolders(c, { ...decision, setBy: { duties: ['release_approval' as const] } })).toEqual([]);
      c.team.roles[0]!.duties = [];
      expect(roleHolders('legacy_notes', c.team.roles)).toBe('both');
    },
  );
  it('loads old custom definitions and preserves explicit stage owners and label setters', () => {
    const c = config();
    c.team.roles = [
      {
        id: 'legacy_writer',
        name: 'Writer',
        summary: 'Writes notes.',
        notTheirJob: '',
        holders: 'both',
        instructions: 'Keep notes.',
      },
    ];
    c.pipeline.stages[1] = { ...c.pipeline.stages[1]!, duty: undefined, owners: ['owner'] };
    c.pipeline.labels = [{ id: 'ok', name: 'Ok', setBy: { members: ['owner'], humansOnly: true } }];
    c.pipeline.stages[2]!.gate = { conditions: [{ type: 'has_label', label: 'ok' }] };
    const old = ProjectConfig.parse(JSON.parse(JSON.stringify(c)));
    expect(roleBundle(old, 'legacy_writer')).toEqual({ duties: [], instructions: 'Keep notes.' });
    expect(stageOwners(old, old.pipeline.stages[1]!)).toEqual(['owner']);
    expect(labelHolders(old, old.pipeline.labels[0]!)).toEqual(['owner']);
    expect(validateProjectConfig(old).filter((i) => i.severity !== 'warning')).toEqual([]);
  });
});
