import { describe, expect, it } from 'vitest';
import { CardBusyDetails, cardBusyGroups } from './card-busy';

describe('cardBusyGroups', () => {
  it('reports a joining member alongside a worker of the same role', () => {
    const groups = cardBusyGroups({
      working: [{ handle: 'dev-1', role: 'developer', state: 'waiting_permission' }],
      joining: [{ handle: 'dev-2', role: 'developer' }],
    });
    expect(groups).toEqual([
      { role: 'developer', working: [{ handle: 'dev-1', state: 'waiting_permission' }], joining: ['dev-2'] },
    ]);
    expect(CardBusyDetails.parse({ taskKey: 'PM-662', groups })).toEqual({ taskKey: 'PM-662', groups });
  });

  it('reports two joining members even without a current worker', () => {
    expect(
      cardBusyGroups({
        working: [],
        joining: [
          { handle: 'arch', role: 'architect' },
          { handle: 'arch-2', role: 'architect' },
        ],
      }),
    ).toEqual([{ role: 'architect', working: [], joining: ['arch', 'arch-2'] }]);
  });

  it('omits workers without joiners, lone joiners and different-role collaboration', () => {
    expect(
      cardBusyGroups({
        working: [
          { handle: 'dev-1', role: 'developer', state: 'working' },
          { handle: 'dev-2', role: 'developer', state: 'idle' },
        ],
        joining: [{ handle: 'cr', role: 'code_review' }],
      }),
    ).toEqual([]);
    expect(cardBusyGroups({ working: [], joining: [] })).toEqual([]);
  });

  it('preserves first role occurrence and handle order across workers and joiners', () => {
    expect(
      cardBusyGroups({
        working: [
          { handle: 'cr-2', role: 'code_review', state: 'idle' },
          { handle: 'dev-1', role: 'developer', state: 'working' },
          { handle: 'cr', role: 'code_review', state: 'waiting_input' },
        ],
        joining: [
          { handle: 'arch-2', role: 'architect' },
          { handle: 'dev-2', role: 'developer' },
          { handle: 'cr-3', role: 'code_review' },
          { handle: 'arch', role: 'architect' },
          { handle: 'dev-3', role: 'developer' },
        ],
      }),
    ).toEqual([
      {
        role: 'code_review',
        working: [
          { handle: 'cr-2', state: 'idle' },
          { handle: 'cr', state: 'waiting_input' },
        ],
        joining: ['cr-3'],
      },
      { role: 'developer', working: [{ handle: 'dev-1', state: 'working' }], joining: ['dev-2', 'dev-3'] },
      { role: 'architect', working: [], joining: ['arch-2', 'arch'] },
    ]);
  });

  it('rejects empty collision details and groups without joining members', () => {
    expect(CardBusyDetails.safeParse({ taskKey: 'PM-662', groups: [] }).success).toBe(false);
    expect(
      CardBusyDetails.safeParse({
        taskKey: 'PM-662',
        groups: [{ role: 'developer', working: [], joining: [] }],
      }).success,
    ).toBe(false);
  });
});
