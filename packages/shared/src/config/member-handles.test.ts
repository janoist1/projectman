import { describe, expect, it } from 'vitest';
import { memberStorageHandle } from './member-handles';

describe('memberStorageHandle', () => {
  it('is the current handle of a member that was never renamed', () => {
    expect(memberStorageHandle({ handle: 'dev' })).toBe('dev');
  });

  it('is the oldest former handle of a renamed member', () => {
    expect(memberStorageHandle({ handle: 'dev-3', formerHandles: ['dev', 'dev-2'] })).toBe('dev');
  });
});
