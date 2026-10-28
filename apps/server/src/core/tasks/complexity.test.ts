import { describe, expect, it } from 'vitest';
import { AiMemberConfig, ProjectConfig } from '@projectman/shared';
import type { ComplexityRequest, Task } from '@projectman/shared';
import { aiActor, humanActor } from '../../kernel';
import { planComplexity } from './complexity';

const config = {
  team: ProjectConfig.shape.team.parse({
    members: [
      { kind: 'human' as const, handle: 'owner', displayName: 'Owner', access: 'owner' as const, roles: [] },
      ...['developer', 'architect'].map((role) =>
        AiMemberConfig.parse({ kind: 'ai', handle: role, displayName: role, role, sponsor: 'owner' }),
      ),
    ],
    roles: [],
    limits: {},
  }),
};
const actor = humanActor('owner');
const at = '2026-10-25T22:00:00Z';
const task: Pick<Task, 'key' | 'status' | 'kind' | 'complexity'> = { key: 'AR-1', status: 'active' };

describe('planComplexity', () => {
  it.each([4, 0, 21])('refuses points outside the scale: %s', (points) => {
    expect(() => planComplexity(config, task, { points }, actor, at)).toThrowError(
      expect.objectContaining({ code: 'complexity_points_invalid', status: 400 }),
    );
  });

  it('checks permission before theme, status or scale', () => {
    expect(() =>
      planComplexity(
        config,
        { ...task, kind: 'theme', status: 'done' },
        { points: 4 },
        aiActor('developer'),
        at,
      ),
    ).toThrowError(expect.objectContaining({ code: 'complexity_forbidden', status: 403 }));
  });

  it.each([
    [{ ...task, kind: 'theme' as const, status: 'done' as const }, 'task_is_theme'],
    [{ ...task, status: 'done' as const }, 'task_closed'],
  ])('checks card eligibility before the scale', (card, code) => {
    expect(() => planComplexity(config, card, { points: 4 }, actor, at)).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it('refuses an oversized reason', () => {
    expect(() =>
      planComplexity(config, task, { points: 5, reason: 'x'.repeat(301) }, actor, at),
    ).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
  });

  it('records points, normalized reason, author and time', () => {
    expect(
      planComplexity(config, null, { points: 5, reason: '  two modules  ' }, aiActor('architect'), at),
    ).toEqual({
      next: { points: 5, reason: 'two modules', setBy: 'architect', setAt: at },
      event: { points: 5, reason: 'two modules', previous: null },
    });
  });

  it('records a changed reason even when points stay the same', () => {
    const complexity = { points: 5 as const, reason: null, setBy: 'owner', setAt: at };
    expect(
      planComplexity(config, { ...task, complexity }, { points: 5, reason: 'reason' }, actor, at)?.event,
    ).toEqual({ points: 5, reason: 'reason', previous: { points: 5, reason: null } });
  });

  it.each<ComplexityRequest>([{ points: 5 }, { points: 5, reason: '' }, { points: 5, reason: '  ' }])(
    'ignores a request with no effective change: %j',
    (request) => {
      const complexity = { points: 5 as const, reason: null, setBy: 'architect', setAt: at };
      expect(planComplexity(config, { ...task, complexity }, request, actor, at)).toBeNull();
    },
  );

  it('ignores removing absent points and ignores the removal reason', () => {
    expect(planComplexity(config, task, { points: null, reason: 'x'.repeat(301) }, actor, at)).toBeNull();
    const complexity = { points: 8 as const, reason: 'old', setBy: 'owner', setAt: at };
    expect(
      planComplexity(config, { ...task, complexity }, { points: null, reason: 'ignored' }, actor, at),
    ).toEqual({
      next: null,
      event: { points: null, reason: null, previous: { points: 8, reason: 'old' } },
    });
  });
});
