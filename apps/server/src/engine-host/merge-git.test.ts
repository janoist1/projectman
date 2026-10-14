import { describe, expect, it } from 'vitest';
import { scrubCredentials } from './merge-git';

describe('scrubCredentials', () => {
  it('scrubs credentials from git output', () => {
    expect(scrubCredentials('fatal: unable to access https://user:secret@example.test/r.git/')).toBe(
      'fatal: unable to access https://***@example.test/r.git/',
    );
    expect(scrubCredentials('token ghp_abcDEF123 and Bearer abc.def')).toBe('token *** and Bearer ***');
  });
});
