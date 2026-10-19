import { describe, expect, it } from 'vitest';
import {
  MERGE_TEST_FAILED_PREFIX,
  MERGE_TEST_FLAKY_PREFIX,
  MERGE_TEST_MARKED_FILES_MAX,
  mergeTestMarkedFiles,
  mergeTestMarkerLine,
} from './merge-test';

describe('mergeTestMarkerLine', () => {
  it('builds a line per kind', () => {
    expect(mergeTestMarkerLine('failed', 'apps/server/test/a.test.ts')).toBe(
      `${MERGE_TEST_FAILED_PREFIX}apps/server/test/a.test.ts`,
    );
    expect(mergeTestMarkerLine('flaky', 'apps/web/src/b.test.tsx')).toBe(
      `${MERGE_TEST_FLAKY_PREFIX}apps/web/src/b.test.tsx`,
    );
  });

  it.each(['/abs/a.test.ts', '../a.test.ts', 'a//b.test.ts', '', 'a\\b.test.ts', '.git/x'])(
    'refuses %j',
    (path) => {
      expect(() => mergeTestMarkerLine('failed', path)).toThrow(TypeError);
    },
  );
});

describe('mergeTestMarkedFiles', () => {
  it('reads the lines of the kind only, in order and unique', () => {
    const output = [
      'noise',
      'merge-test failed: a.test.ts',
      'merge-test flaky: b.test.ts',
      'merge-test failed: c.test.ts',
      'merge-test failed: a.test.ts',
    ].join('\n');
    expect(mergeTestMarkedFiles(output, 'failed')).toEqual(['a.test.ts', 'c.test.ts']);
    expect(mergeTestMarkedFiles(output, 'flaky')).toEqual(['b.test.ts']);
  });

  it('removes ANSI and accepts CRLF', () => {
    const output = '\u001b[31mmerge-test failed: a.test.ts\u001b[0m\r\nmerge-test failed: b.test.ts\r\n';
    expect(mergeTestMarkedFiles(output, 'failed')).toEqual(['a.test.ts', 'b.test.ts']);
  });

  it('is line-anchored', () => {
    const output = '  merge-test failed: a.test.ts\nsee merge-test failed: b.test.ts\n';
    expect(mergeTestMarkedFiles(output, 'failed')).toEqual([]);
  });

  it('skips invalid paths', () => {
    const output =
      'merge-test failed: /etc/passwd\nmerge-test failed: ../x.test.ts\nmerge-test failed: \nmerge-test failed: ok.test.ts';
    expect(mergeTestMarkedFiles(output, 'failed')).toEqual(['ok.test.ts']);
  });

  it('stops at the upper limit', () => {
    const output = Array.from({ length: 30 }, (_, i) => `merge-test flaky: t/${i}.test.ts`).join('\n');
    expect(mergeTestMarkedFiles(output, 'flaky')).toHaveLength(MERGE_TEST_MARKED_FILES_MAX);
  });
});
