import { describe, expect, it } from 'vitest';
import { StartMergeRequest } from './dto';

describe('merge request', () => {
  it('keeps empty calls and trims resolution notes', () => {
    expect(StartMergeRequest.parse({})).toEqual({});
    expect(StartMergeRequest.parse({ resolution: '  Fix imports  ' })).toEqual({ resolution: 'Fix imports' });
    expect(StartMergeRequest.parse({ resolution: 'x'.repeat(2000) }).resolution).toHaveLength(2000);
  });
  it.each(['', '   ', 'x'.repeat(2001), 3])('rejects invalid resolution %s', (resolution) => {
    expect(StartMergeRequest.safeParse({ resolution }).success).toBe(false);
  });
});
