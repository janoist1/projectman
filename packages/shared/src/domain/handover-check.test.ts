import { describe, expect, it } from 'vitest';
import { handoverCheckVerdict, type HandoverCheckRecord } from './handover-check';

const setting = { command: 'npm run handover-check' };
const commit = 'a'.repeat(40);
const record: HandoverCheckRecord = {
  version: 1,
  commit,
  clean: true,
  outcome: 'passed',
  exitCode: 0,
  startedAt: '2026-11-12T10:00:00.000Z',
  finishedAt: '2026-11-12T10:01:00.000Z',
};

describe('handoverCheckVerdict', () => {
  it('is off without a setting, whatever the record says', () => {
    expect(handoverCheckVerdict({ setting: undefined, commit, record: null, exceptions: [] })).toEqual({
      status: 'off',
    });
  });

  it('passes on a clean green record of the commit', () => {
    expect(handoverCheckVerdict({ setting, commit, record, exceptions: [] })).toEqual({ status: 'passed' });
  });

  it('is excepted when the commit has an exception, before it looks at the record', () => {
    expect(handoverCheckVerdict({ setting, commit, record: 'unsupported', exceptions: [commit] })).toEqual({
      status: 'excepted',
    });
  });

  it('does not take the exception of another commit', () => {
    expect(handoverCheckVerdict({ setting, commit, record: null, exceptions: ['b'.repeat(40)] })).toEqual({
      status: 'missing',
      miss: 'no_record',
    });
  });

  it.each([
    ['engine_outdated', 'unsupported', undefined],
    ['no_record', null, undefined],
    ['other_commit', { ...record, commit: 'c'.repeat(40) }, 'c'.repeat(40)],
    ['not_clean', { ...record, clean: false }, undefined],
    ['failed', { ...record, outcome: 'failed' as const, exitCode: 1 }, undefined],
  ] as const)('is missing with %s', (miss, read, recordCommit) => {
    expect(handoverCheckVerdict({ setting, commit, record: read, exceptions: [] })).toEqual({
      status: 'missing',
      miss,
      ...(recordCommit ? { recordCommit } : {}),
    });
  });
});
