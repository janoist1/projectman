import { describe, expect, it } from 'vitest';
import { gateRequestOf } from './inbox';

const request = {
  requestId: 'gat_1',
  taskKey: 'AR-1',
  fromStageId: 'code_review',
  toStageId: 'merge',
  stageId: 'merge',
  label: 'merge-ok',
  requestedBy: { kind: 'ai', handle: 'dev-1' },
};

describe('gateRequestOf', () => {
  it.each<[string, Record<string, unknown>, unknown]>([
    ['reads a gate request', { gate: request }, request],
    [
      'reads a request from before labels (no label)',
      { gate: { ...request, label: undefined, conditionIndex: 0 } },
      { ...request, label: undefined },
    ],
    ['has none on other items', { toolName: 'Bash' }, null],
    ['refuses a malformed request', { gate: { ...request, taskKey: 'not a key' } }, null],
  ])('%s', (_name, payload, expected) => {
    expect(gateRequestOf({ payload })).toEqual(expected);
  });
});
