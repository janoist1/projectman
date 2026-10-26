import { describe, expect, it } from 'vitest';
import { seniorWaitMinutesOf } from './developer-level';
import { workStageOf } from '../config/senior';
import { Pipeline } from './pipeline';

describe('developer wait helpers', () => {
  it('uses the configured timeout or the default', () => {
    expect(seniorWaitMinutesOf({})).toBe(30);
    expect(seniorWaitMinutesOf({ seniorWaitMinutes: 90 })).toBe(90);
  });
  it('finds the current work stage, falling back to the first work stage', () => {
    const pipeline = Pipeline.parse({
      columns: [{ id: 'all', name: 'All' }],
      stages: ['first', 'second'].map((id) => ({ id, name: id, kind: 'work', columnId: 'all' })),
    });
    expect(workStageOf({ pipeline }, { stageId: 'second' })?.id).toBe('second');
    expect(workStageOf({ pipeline }, { stageId: 'missing' })?.id).toBe('first');
    expect(workStageOf({ pipeline: { ...pipeline, stages: [] } }, { stageId: 'missing' })).toBeUndefined();
  });
});
