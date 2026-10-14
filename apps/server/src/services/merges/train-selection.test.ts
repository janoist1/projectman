import { describe, expect, it } from 'vitest';
import { selectMergeTrain } from './train-selection';
import type { MergeTrainCandidate } from './train-selection';

const reviewTest = { command: 'npm run merge-test', maxWorkers: 2, timeoutMinutes: 15 };
const at = '2026-10-14T10:00:00.000Z';
function candidate(seq: number, patch: Partial<MergeTrainCandidate> = {}): MergeTrainCandidate {
  return {
    mergeId: `merge_member0${seq}`,
    taskKey: `PM-${seq}`,
    commit: 'a'.repeat(40),
    branch: `PM-${seq}-change`,
    startedBy: 'claude',
    startedAt: at,
    projectKey: 'PM',
    repo: 'projectman',
    base: 'main',
    engineId: 'local',
    reviewTest: { ...reviewTest },
    eligible: true,
    solo: false,
    ...patch,
  };
}
const diagnostic = (maxCards: number, parentTrainId = 'mrg_parent00') => ({
  diagnostic: { parentTrainId, maxCards },
});

describe('merge train selection', () => {
  it('returns no work for an empty queue or an ineligible head', () => {
    expect(selectMergeTrain([])).toEqual([]);
    expect(selectMergeTrain([candidate(1, { eligible: false }), candidate(2)])).toEqual([]);
  });

  it('preserves priority and FIFO input order without changing snapshots', () => {
    const queued = [
      candidate(4, { prioritizedAt: '2026-10-14T12:00:00.000Z' }),
      candidate(3, { prioritizedAt: '2026-10-14T11:00:00.000Z' }),
      candidate(2, { startedAt: '2026-10-14T09:00:00.000Z' }),
      candidate(1),
    ];
    const snapshot = structuredClone(queued);
    expect(selectMergeTrain(queued)).toEqual(queued.map((item) => item.mergeId));
    expect(queued).toEqual(snapshot);
  });

  it('caps a compatible prefix at eight cards', () => {
    const queued = Array.from({ length: 10 }, (_, i) => candidate(i + 1));
    expect(selectMergeTrain(queued)).toEqual(queued.slice(0, 8).map((item) => item.mergeId));
  });

  it('returns a singleton for the individual path', () => {
    expect(selectMergeTrain([candidate(1)])).toEqual(['merge_member01']);
  });

  it.each([{ solo: true }, { reviewTest: undefined }])('keeps an individual head alone: %j', (patch) => {
    expect(selectMergeTrain([candidate(1, patch), candidate(2)])).toEqual(['merge_member01']);
  });

  it.each<Partial<MergeTrainCandidate>>([
    { projectKey: 'OTHER' },
    { repo: 'other' },
    { base: 'release' },
    { engineId: 'eng_abcdefgh1234' },
    { reviewTest: { ...reviewTest, command: 'npm test' } },
    { reviewTest: { ...reviewTest, maxWorkers: 3 } },
    { reviewTest: { ...reviewTest, timeoutMinutes: 20 } },
    { reviewTest: undefined },
    { eligible: false },
    { solo: true },
  ])('stops at an incompatible or individual card without skipping it: %j', (patch) => {
    expect(selectMergeTrain([candidate(1), candidate(2), candidate(3, patch), candidate(4)])).toEqual([
      'merge_member01',
      'merge_member02',
    ]);
  });

  it('compares review test values independently of object identity or property order', () => {
    const next = { timeoutMinutes: 15, maxWorkers: 2, command: 'npm run merge-test' };
    expect(selectMergeTrain([candidate(1), candidate(2, { reviewTest: next })])).toEqual([
      'merge_member01',
      'merge_member02',
    ]);
  });

  it.each([1, 2, 4, 8])('honors a diagnostic limit of %i', (maxCards) => {
    const queued = Array.from({ length: 9 }, (_, i) => candidate(i + 1, diagnostic(maxCards)));
    expect(selectMergeTrain(queued)).toEqual(queued.slice(0, maxCards).map((item) => item.mergeId));
  });

  it('honors every selected diagnostic member limit', () => {
    expect(
      selectMergeTrain([
        candidate(1, diagnostic(8)),
        candidate(2, diagnostic(2)),
        candidate(3, diagnostic(8)),
      ]),
    ).toEqual(['merge_member01', 'merge_member02']);
    expect(selectMergeTrain([candidate(1, diagnostic(8)), candidate(2, diagnostic(1))])).toEqual([
      'merge_member01',
    ]);
  });

  it.each([0, -1, 9, 1.5, NaN, Infinity, undefined, null])(
    'refuses an invalid diagnostic limit %s',
    (value) => {
      const maxCards = value as number;
      expect(selectMergeTrain([candidate(1, diagnostic(maxCards)), candidate(2)])).toEqual([]);
      expect(selectMergeTrain([candidate(1, diagnostic(8)), candidate(2, diagnostic(maxCards))])).toEqual([
        'merge_member01',
      ]);
    },
  );

  it('never mixes normal and diagnostic cards in either direction', () => {
    expect(selectMergeTrain([candidate(1), candidate(2, diagnostic(2)), candidate(3)])).toEqual([
      'merge_member01',
    ]);
    expect(
      selectMergeTrain([candidate(1, diagnostic(2)), candidate(2), candidate(3, diagnostic(2))]),
    ).toEqual(['merge_member01']);
  });

  it('never crosses diagnostic parent groups', () => {
    expect(
      selectMergeTrain([
        candidate(1, diagnostic(4)),
        candidate(2, diagnostic(4)),
        candidate(3, diagnostic(4, 'mrg_other000')),
        candidate(4, diagnostic(4)),
      ]),
    ).toEqual(['merge_member01', 'merge_member02']);
  });
});
