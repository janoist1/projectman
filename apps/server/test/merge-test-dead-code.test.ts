import { describe, expect, it } from 'vitest';
import { deadCodeKeys, newDeadCode } from '../../../scripts/merge-test/dead-code';

describe('dead-code baseline', () => {
  it('accepts existing debt after positions change or other debt disappears', () => {
    const baseline = deadCodeKeys({
      issues: [{ file: 'a.ts', exports: [{ name: 'old', line: 1 }, { name: 'gone' }] }],
    });
    expect(
      newDeadCode({ issues: [{ file: 'a.ts', exports: [{ name: 'old', line: 50 }] }] }, baseline),
    ).toEqual([]);
  });

  it.each(['files', 'exports', 'types'])('rejects a new %s issue independently of existing debt', (kind) => {
    const existing = { file: 'a.ts', exports: [{ name: 'old' }] };
    const report = { issues: [existing, { file: 'b.ts', [kind]: [{ name: 'added' }] }] };
    expect(newDeadCode(report, deadCodeKeys({ issues: [existing] }))).toEqual([
      JSON.stringify([kind, 'b.ts', kind === 'files' ? '' : 'added']),
    ]);
  });

  it.each([null, {}, { issues: [{}] }, { issues: [{ file: 'a.ts', exports: [{}] }] }])(
    'fails closed on a malformed report (%j)',
    (report) => {
      expect(() => newDeadCode(report, [])).toThrow();
    },
  );

  it('fails closed on a malformed baseline', () => {
    expect(() => newDeadCode({ issues: [] }, {})).toThrow();
  });
});
