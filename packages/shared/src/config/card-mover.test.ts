import { describe, expect, it } from 'vitest';
import type { Actor } from '../domain/event';
import { cardMoverHandle, cardMoverOf, handOnDecision, isHandOnMove } from './card-mover';
import { applyConfigPatch, PatchConfigRequest } from './edit';
import { projectManagerMoveRefusal } from './project-manager';
import { ProjectConfig } from './schema';
import type { CardMover } from './schema';

function config(cardMover?: CardMover): ProjectConfig {
  return ProjectConfig.parse({
    schemaVersion: 1,
    project: { key: 'AR', name: 'Acme', workspacePath: '/work/acme', repos: [] },
    team: {
      cardMover,
      limits: {},
      members: [
        { kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner' },
        { kind: 'ai', handle: 'dev', displayName: 'Developer', role: 'developer', sponsor: 'owner' },
        { kind: 'ai', handle: 'pm', displayName: 'PM', role: 'project_manager', sponsor: 'owner' },
      ],
    },
    pipeline: {
      columns: [{ id: 'all', name: 'All' }],
      labels: [],
      stages: [
        { id: 'first', name: 'First', kind: 'queue', columnId: 'all' },
        { id: 'queue', name: 'Queue', kind: 'queue', columnId: 'all' },
        { id: 'work', name: 'Work', kind: 'work', columnId: 'all' },
        { id: 'step', name: 'Step', kind: 'step', columnId: 'all' },
        {
          id: 'release',
          name: 'Release',
          kind: 'release',
          columnId: 'all',
          gate: { conditions: [{ type: 'has_label', label: 'approved' }] },
        },
        { id: 'done', name: 'Done', kind: 'done', columnId: 'all' },
      ],
    },
  });
}

describe('card mover', () => {
  const movers: CardMover[] = [
    { kind: 'worker' },
    { kind: 'project_manager' },
    { kind: 'human', handle: 'owner' },
  ];
  it('never hands on from a refinement step, nor widens PM rights there', () => {
    for (const mover of movers) {
      const c = config(mover);
      c.pipeline.stages.splice(1, 0, {
        id: 'plan',
        name: 'Plan',
        kind: 'step',
        duty: 'task_breakdown',
        columnId: 'all',
      });
      expect(isHandOnMove(c, 'plan', 'queue')).toBe(false);
      expect(handOnDecision(c, { kind: 'system', handle: null }, 'plan', 'queue')).toEqual({ kind: 'move' });
      expect(handOnDecision(c, { kind: 'ai', handle: 'dev' }, 'plan', 'queue')).toEqual({ kind: 'move' });
      expect(projectManagerMoveRefusal(c, 'plan', 'queue')).toBe('project_manager_move_refused');
    }
  });
  for (const mover of movers) {
    const moverHandle = mover.kind === 'human' ? 'owner' : mover.kind === 'project_manager' ? 'pm' : null;
    const actors: Actor[] = [
      { kind: 'human', handle: 'someone' },
      { kind: 'ai', handle: 'dev' },
      { kind: 'system', handle: null },
      { kind: mover.kind === 'human' ? 'human' : 'ai', handle: moverHandle ?? 'dev' },
    ];
    for (const actor of actors)
      for (const from of ['queue', 'work', 'step', 'release']) {
        it(`${mover.kind}: ${actor.kind}/${actor.handle} moving from ${from}`, () => {
          const c = config(mover);
          const requests =
            from !== 'queue' &&
            actor.kind !== 'human' &&
            moverHandle !== null &&
            actor.handle !== moverHandle;
          expect(handOnDecision(c, actor, from, 'done')).toEqual(
            requests ? { kind: 'request', mover: moverHandle } : { kind: 'move' },
          );
          expect(handOnDecision(c, actor, from, 'first')).toEqual({ kind: 'move' });
          expect(handOnDecision(c, actor, from, from)).toEqual({ kind: 'move' });
        });
      }
  }
  it('defaults to worker and allows missing or invalid movers to move', () => {
    const c = config();
    expect(cardMoverOf(c)).toEqual({ kind: 'worker' });
    expect(cardMoverHandle(c)).toBeNull();
    const actor: Actor = { kind: 'ai', handle: 'dev' };
    for (const mover of [
      { kind: 'human', handle: 'missing' },
      { kind: 'human', handle: 'dev' },
      { kind: 'project_manager' },
    ] as CardMover[]) {
      c.team.cardMover = mover;
      c.team.members = c.team.members.filter((m) => m.handle !== 'pm');
      expect(handOnDecision(c, actor, 'work', 'done')).toEqual({ kind: 'move' });
    }
    expect(isHandOnMove(c, 'missing', 'done')).toBe(false);
    expect(isHandOnMove(c, 'work', 'missing')).toBe(false);
  });
  it('permits the project manager to hand on only in project manager mode', () => {
    const c = config({ kind: 'project_manager' });
    for (const from of ['work', 'step', 'release'])
      expect(projectManagerMoveRefusal(c, from, 'done')).toBeNull();
    expect(projectManagerMoveRefusal(c, 'step', 'work')).toBe('project_manager_move_refused');
    expect(projectManagerMoveRefusal(c, 'first', 'work')).toBe('project_manager_move_refused');
    expect(projectManagerMoveRefusal(c, 'queue', 'work')).toBeNull();
    c.team.cardMover = { kind: 'worker' };
    expect(projectManagerMoveRefusal(c, 'work', 'step')).toBe('project_manager_move_refused');
  });
  it('patches the mover without changing unrelated fields and retains it on later edits', () => {
    const c = config();
    const patch = PatchConfigRequest.parse({
      baseVersion: 'v1',
      cardMover: { kind: 'human', handle: 'owner' },
    });
    const next = applyConfigPatch(c, patch);
    expect(next.team.cardMover).toEqual(patch.cardMover);
    expect(next.team.members).toEqual(c.team.members);
    expect(c.team.cardMover).toBeUndefined();
    expect(applyConfigPatch(next, { baseVersion: 'v2' }).team.cardMover).toEqual(patch.cardMover);
  });
});
