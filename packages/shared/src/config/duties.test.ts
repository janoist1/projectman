import { describe, expect, it } from 'vitest';
import { DUTIES, DUTY_GROUPS, DUTY_IDS } from '../domain/duty';
import { dutyHolders, roleHolders, RoleOverrides } from '../domain/role';
import { ProjectConfig } from './schema';
import type { Session, SessionState } from '../domain/session';
import {
  cardWorkerSessions,
  dutyMembers,
  isWorkingOnTask,
  memberDuties,
  roleBundle,
  stageOwners,
  stagesToJoin,
} from './duties';
import { labelHolders } from './labels';
import { applyConfigPatch, PatchConfigRequest } from './edit';
import { approvalPolicyChanged } from './owner-only';
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
    expect(DUTY_IDS).toHaveLength(27);
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
  it('finds the fixed-owner stages a new member joins by duty (PM-133)', () => {
    const c = config();
    const newDev = (handle: string, role = 'developer') =>
      ({ kind: 'ai', handle, displayName: handle, role, sponsor: 'owner' }) as never;
    const join = (m: ReturnType<typeof newDev>) => stagesToJoin(c, m).map((s) => s.id);
    // Stages without an owner list resolve by duty already: nothing to join.
    expect(join(newDev('d2'))).toEqual([]);
    // A work stage with a fixed list and no duty of its own stands for implementation.
    c.pipeline.stages[1] = { id: 'work', name: 'Work', kind: 'work', owners: ['builder'], columnId: 'all' };
    expect(join(newDev('d2'))).toEqual(['work']);
    expect(join(newDev('builder'))).toEqual([]);
    expect(join(newDev('q', 'qa'))).toEqual([]);
    // An explicit duty decides for any other stage kind; queue and done are never joined.
    c.pipeline.stages[2] = { ...c.pipeline.stages[2]!, owners: ['owner'], duty: 'testing_acceptance' };
    expect(join(newDev('q', 'qa'))).toEqual(['release']);
    c.pipeline.stages[0] = { ...c.pipeline.stages[0]!, owners: ['owner'], duty: 'implementation' };
    expect(join(newDev('d2'))).toEqual(['work']);
  });
  it('counts a live session as work now while a turn runs or the task is in the member’s stage', () => {
    const c = config();
    const onTask = (stageId: string, assignee: string | null) => ({ stageId, assignee });
    // A turn in progress or a question waiting for an answer counts wherever the task is.
    for (const state of ['starting', 'working', 'waiting_permission', 'waiting_input'] as const)
      expect(isWorkingOnTask(c, onTask('release', 'owner'), 'builder', state)).toBe(true);
    // Idle in the work stage: the assignee works on it; another member's idle session does not count.
    expect(isWorkingOnTask(c, onTask('work', 'builder'), 'builder', 'idle')).toBe(true);
    expect(isWorkingOnTask(c, onTask('work', 'other'), 'builder', 'idle')).toBe(false);
    expect(isWorkingOnTask(c, onTask('work', null), 'builder', 'idle')).toBe(true);
    // Handed on to a stage the member does not own: an idle session no longer counts, even for the assignee.
    expect(isWorkingOnTask(c, onTask('release', 'builder'), 'builder', 'idle')).toBe(false);
    c.pipeline.stages.find((s) => s.id === 'release')!.owners = ['owner'];
    expect(isWorkingOnTask(c, onTask('release', 'builder'), 'owner', 'idle')).toBe(true);
    expect(isWorkingOnTask(c, onTask('queue', 'builder'), 'builder', 'idle')).toBe(false);
    expect(isWorkingOnTask(c, onTask('done', 'builder'), 'builder', 'idle')).toBe(false);
    expect(isWorkingOnTask(c, onTask('missing', 'builder'), 'builder', 'idle')).toBe(false);
  });
  it('lists the sessions that work on a card now, one per member, step owners first (PM-249)', () => {
    const session = (id: string, member: string, state: SessionState, at: string, taskKey = 'EX-1') =>
      ({
        id,
        member,
        state,
        workItem: { type: 'task', taskKey },
        lastActivityAt: at,
        stateSince: at,
      }) as unknown as Session;
    const task: { key: string; assignee: string | null } = { key: 'EX-1', assignee: 'builder' };
    const ids = (stage: Parameters<typeof cardWorkerSessions>[0], sessions: Session[], t = task) =>
      cardWorkerSessions(stage, t, sessions).map((s) => s.id);
    // Work stage: the assignee's idle session counts, another member's idle one does not.
    const work = { kind: 'work' as const, owners: ['builder', 'dev2'] };
    const all = [
      session('a', 'dev2', 'working', '2026-10-03T10:00:00Z'),
      session('b', 'builder', 'idle', '2026-10-03T12:00:00Z'),
      session('c', 'qa', 'idle', '2026-10-03T09:00:00Z'),
      session('d', 'other', 'waiting_input', '2026-10-03T08:00:00Z'),
      session('e', 'qa2', 'exited', '2026-10-03T07:00:00Z'),
      session('f', 'qa3', 'failed', '2026-10-03T07:00:00Z'),
      session('g', 'builder2', 'working', '2026-10-03T07:00:00Z', 'EX-2'),
    ];
    // The assignee first, then the others by how long they have been in their state.
    expect(ids(work, all)).toEqual(['b', 'd', 'a']);
    // Without an assignee the stage's owners work on it.
    expect(ids(work, all, { key: 'EX-1', assignee: null })).toEqual(['d', 'a', 'b']);
    // A step stage: its owners come first, even before the assignee.
    const step = { kind: 'step' as const, owners: ['qa', 'builder'] };
    expect(ids(step, all)).toEqual(['c', 'b', 'd', 'a']);
    // A queue stage: only sessions in a turn or waiting for an answer.
    expect(ids({ kind: 'queue', owners: ['builder'] }, all)).toEqual(['d', 'a']);
    expect(ids(undefined, all)).toEqual(['d', 'a']);
    // One session per member: the one longest in its state.
    expect(
      ids(work, [
        session('x2', 'a', 'working', '2026-10-03T11:00:00Z'),
        session('x1', 'a', 'working', '2026-10-03T10:00:00Z'),
      ]),
    ).toEqual(['x1']);
    // Meeting and general sessions are not on the card.
    expect(
      cardWorkerSessions(work, task, [
        { ...session('m', 'builder', 'working', '2026-10-03T10:00:00Z'), workItem: { type: 'general' } },
      ]),
    ).toEqual([]);
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
      expect(approvalPolicyChanged(c, next)).toBe(true);
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
    // An explicit list still approves any stage but a release, whose approval is the duty's alone.
    c.pipeline.stages[2] = { ...c.pipeline.stages[2]!, kind: 'step' };
    c.pipeline.stages[2]!.gate = { conditions: [{ type: 'has_label', label: 'ok' }] };
    const old = ProjectConfig.parse(JSON.parse(JSON.stringify(c)));
    expect(roleBundle(old, 'legacy_writer')).toEqual({ duties: [], instructions: 'Keep notes.' });
    expect(stageOwners(old, old.pipeline.stages[1]!)).toEqual(['owner']);
    expect(labelHolders(old, old.pipeline.labels[0]!)).toEqual(['owner']);
    expect(validateProjectConfig(old).filter((i) => i.severity !== 'warning')).toEqual([]);
  });
});
