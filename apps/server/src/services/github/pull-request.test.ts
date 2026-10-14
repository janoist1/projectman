import { describe, expect, it } from 'vitest';
import { GithubError } from './errors';
import {
  mapReviewDecision,
  parsePullRequestJson,
  parsePullRequestListJson,
  pullRequestFingerprint,
  summarizeChecks,
  type GhCheckContext,
} from './pull-request';
import { checkRun, ghPullRequestJson, pullRequestInfo, statusContext } from './test-fixtures/harness';

const json = (value: unknown) => JSON.stringify(value);

describe('parsePullRequestJson', () => {
  it('maps gh output to PullRequestInfo', () => {
    const pr = parsePullRequestJson(
      'acme/app',
      json(
        ghPullRequestJson({
          isDraft: true,
          reviewDecision: 'REVIEW_REQUIRED',
          statusCheckRollup: [checkRun('build', 'COMPLETED', 'SUCCESS')],
        }),
      ),
    );
    expect(pr).toEqual({
      repo: 'acme/app',
      number: 12,
      title: 'AR-21 Add room search',
      url: 'https://github.com/acme/app/pull/12',
      state: 'open',
      draft: true,
      headRef: 'AR-21-room-search',
      baseRef: 'main',
      checks: 'success',
      reviewDecision: 'review_required',
      additions: 120,
      deletions: 8,
      changedFiles: 5,
      updatedAt: '2026-09-29T10:00:00Z',
    });
  });

  it('maps the head commit when gh supplies it', () => {
    const pr = parsePullRequestJson('acme/app', json(ghPullRequestJson({ headRefOid: 'a1b2c3d' })));
    expect(pr.headSha).toBe('a1b2c3d');
  });

  it('echoes the repo as given by the caller', () => {
    expect(parsePullRequestJson('Acme/App', json(ghPullRequestJson())).repo).toBe('Acme/App');
  });

  it.each([
    [{ state: 'OPEN' }, 'open'],
    [{ state: 'CLOSED' }, 'closed'],
    [{ state: 'MERGED', mergedAt: '2026-09-29T12:00:00Z' }, 'merged'],
    [{ state: 'MERGED', mergedAt: null }, 'merged'],
    [{ state: 'CLOSED', mergedAt: '2026-09-29T12:00:00Z' }, 'merged'],
  ])('maps state %o to %s', (fields, state) => {
    expect(parsePullRequestJson('acme/app', json(ghPullRequestJson(fields))).state).toBe(state);
  });

  it('treats a missing check rollup as no checks', () => {
    expect(
      parsePullRequestJson('acme/app', json(ghPullRequestJson({ statusCheckRollup: null }))).checks,
    ).toBe('none');
  });

  it('rejects output that is not JSON', () => {
    expect(() => parsePullRequestJson('acme/app', 'Welcome to GitHub CLI')).toThrowError(
      expect.objectContaining({ code: 'invalid_response' }),
    );
  });

  it('rejects JSON without the requested fields', () => {
    const { isDraft: _isDraft, ...withoutDraft } = ghPullRequestJson();
    let error: unknown;
    try {
      parsePullRequestJson('acme/app', json(withoutDraft));
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(GithubError);
    expect((error as GithubError).code).toBe('invalid_response');
    expect((error as GithubError).message).toContain('isDraft');
  });

  it('rejects an unknown state', () => {
    expect(() => parsePullRequestJson('acme/app', json(ghPullRequestJson({ state: 'LOCKED' })))).toThrowError(
      expect.objectContaining({ code: 'invalid_response' }),
    );
  });
});

describe('parsePullRequestListJson', () => {
  it('maps every pull request of the list', () => {
    const list = parsePullRequestListJson(
      'acme/app',
      json([ghPullRequestJson({ number: 14 }), ghPullRequestJson({ number: 9, state: 'CLOSED' })]),
    );
    expect(list.map((pr) => [pr.number, pr.state])).toEqual([
      [14, 'open'],
      [9, 'closed'],
    ]);
  });

  it('accepts an empty list', () => {
    expect(parsePullRequestListJson('acme/app', '[]\n')).toEqual([]);
  });
});

describe('mapReviewDecision', () => {
  it.each([
    ['APPROVED', 'approved'],
    ['CHANGES_REQUESTED', 'changes_requested'],
    ['REVIEW_REQUIRED', 'review_required'],
    ['', null],
    [null, null],
    [undefined, null],
    ['SOMETHING_NEW', null],
  ])('maps %o to %o', (value, expected) => {
    expect(mapReviewDecision(value)).toBe(expected);
  });
});

describe('summarizeChecks', () => {
  const summarize = (...contexts: Record<string, unknown>[]) => summarizeChecks(contexts as GhCheckContext[]);

  it('returns none without checks', () => {
    expect(summarize()).toBe('none');
  });

  it('returns success when every check passed', () => {
    expect(
      summarize(
        checkRun('build', 'COMPLETED', 'SUCCESS'),
        checkRun('lint', 'COMPLETED', 'NEUTRAL'),
        checkRun('deploy-preview', 'COMPLETED', 'SKIPPED'),
        statusContext('ci/legacy', 'SUCCESS'),
      ),
    ).toBe('success');
  });

  it.each(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])(
    'treats a %s check run as failure',
    (conclusion) => {
      expect(
        summarize(checkRun('build', 'COMPLETED', 'SUCCESS'), checkRun('test', 'COMPLETED', conclusion)),
      ).toBe('failure');
    },
  );

  it.each(['FAILURE', 'ERROR'])('treats a %s status context as failure', (state) => {
    expect(summarize(statusContext('ci/legacy', state))).toBe('failure');
  });

  it.each(['QUEUED', 'IN_PROGRESS', 'WAITING', 'PENDING', 'REQUESTED'])(
    'treats a %s check run as pending',
    (status) => {
      expect(summarize(checkRun('build', 'COMPLETED', 'SUCCESS'), checkRun('test', status, ''))).toBe(
        'pending',
      );
    },
  );

  it.each(['PENDING', 'EXPECTED'])('treats a %s status context as pending', (state) => {
    expect(summarize(statusContext('ci/legacy', state))).toBe('pending');
  });

  it('treats stale and unknown results as pending', () => {
    expect(summarize(checkRun('build', 'COMPLETED', 'STALE'))).toBe('pending');
    expect(summarize(checkRun('build', 'COMPLETED', ''))).toBe('pending');
    expect(summarize(statusContext('ci/legacy', 'SOMETHING_NEW'))).toBe('pending');
  });

  it('lets a failure win over pending checks', () => {
    expect(summarize(checkRun('build', 'IN_PROGRESS', ''), statusContext('ci/legacy', 'ERROR'))).toBe(
      'failure',
    );
  });

  it('counts only the latest run of a re-run check', () => {
    const failed = checkRun('test', 'COMPLETED', 'FAILURE', { startedAt: '2026-09-29T10:00:00Z' });
    const passed = checkRun('test', 'COMPLETED', 'SUCCESS', { startedAt: '2026-09-29T11:00:00Z' });
    expect(summarize(failed, passed)).toBe('success');
    expect(summarize(passed, failed)).toBe('success');
  });

  it('treats a queued re-run (not started yet) as the latest run', () => {
    const failed = checkRun('test', 'COMPLETED', 'FAILURE');
    const queued = checkRun('test', 'QUEUED', '', { startedAt: '0001-01-01T00:00:00Z' });
    expect(summarize(failed, queued)).toBe('pending');
    expect(summarize(queued, failed)).toBe('pending');
  });

  it('keeps checks with the same name in different workflows apart', () => {
    expect(
      summarize(
        checkRun('build', 'COMPLETED', 'SUCCESS', { workflowName: 'CI', startedAt: '2026-09-29T11:00:00Z' }),
        checkRun('build', 'COMPLETED', 'FAILURE', {
          workflowName: 'Release',
          startedAt: '2026-09-29T10:00:00Z',
        }),
      ),
    ).toBe('failure');
  });

  it('uses the latest status of a status context', () => {
    expect(
      summarize(
        statusContext('ci/legacy', 'FAILURE', { startedAt: '2026-09-29T10:00:00Z' }),
        statusContext('ci/legacy', 'SUCCESS', { startedAt: '2026-09-29T10:30:00Z' }),
      ),
    ).toBe('success');
  });

  it('recognises both shapes without __typename', () => {
    expect(summarize({ name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' })).toBe('failure');
    expect(summarize({ context: 'ci/legacy', state: 'SUCCESS' })).toBe('success');
  });
});

describe('pullRequestFingerprint', () => {
  it('ignores updatedAt', () => {
    expect(pullRequestFingerprint(pullRequestInfo({ updatedAt: '2026-09-29T12:00:00Z' }))).toBe(
      pullRequestFingerprint(pullRequestInfo()),
    );
  });

  it('changes with any other field', () => {
    const base = pullRequestFingerprint(pullRequestInfo());
    expect(pullRequestFingerprint(pullRequestInfo({ checks: 'success' }))).not.toBe(base);
    expect(pullRequestFingerprint(pullRequestInfo({ state: 'merged' }))).not.toBe(base);
    expect(pullRequestFingerprint(pullRequestInfo({ reviewDecision: 'approved' }))).not.toBe(base);
    expect(pullRequestFingerprint(pullRequestInfo({ draft: true }))).not.toBe(base);
    expect(pullRequestFingerprint(pullRequestInfo({ title: 'Renamed' }))).not.toBe(base);
  });

  it('does not depend on key order', () => {
    const { repo, ...rest } = pullRequestInfo();
    expect(pullRequestFingerprint({ ...rest, repo })).toBe(pullRequestFingerprint(pullRequestInfo()));
  });
});
