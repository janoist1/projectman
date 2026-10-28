import { describe, expect, it } from 'vitest';
import { ControlRequest, ControlResponse } from './pause';
import {
  HybridDeployment,
  HybridReleaseTarget,
  isDeploymentActive,
  RELEASE_TAG_PATTERN,
  ReleaseDeployBegin,
  ReleaseDeployChange,
  ReleaseDeploymentChange,
  ReleaseReport,
  releaseTagName,
} from './release';

describe('releaseTagName', () => {
  const day = new Date('2026-10-11T23:59:59Z');

  it('names the tag after the UTC date, without leading zeros', () => {
    expect(releaseTagName(day, [])).toBe('v2026.10.11');
    expect(releaseTagName(new Date('2026-03-05T00:00:00Z'), [])).toBe('v2026.3.5');
    // The UTC date counts, not the local one.
    expect(releaseTagName(new Date('2026-12-31T23:30:00Z'), [])).toBe('v2026.12.31');
  });

  it('adds a counter from 2 when the date already has a tag', () => {
    expect(releaseTagName(day, ['v2026.10.11'])).toBe('v2026.10.11.2');
    expect(releaseTagName(day, ['v2026.10.11', 'v2026.10.11.2'])).toBe('v2026.10.11.3');
  });

  it('ignores tags of other days and fills no gap behind a taken counter', () => {
    expect(releaseTagName(day, ['v2026.10.10', 'v2026.9.11'])).toBe('v2026.10.11');
    expect(releaseTagName(day, ['v2026.10.11', 'v2026.10.11.3'])).toBe('v2026.10.11.2');
  });

  it('always produces a tag the pattern accepts', () => {
    expect(RELEASE_TAG_PATTERN.test(releaseTagName(day, []))).toBe(true);
    expect(RELEASE_TAG_PATTERN.test(releaseTagName(day, ['v2026.10.11']))).toBe(true);
    expect(RELEASE_TAG_PATTERN.test('latest')).toBe(false);
  });
});

describe('ReleaseReport', () => {
  it('accepts the four outcomes and refuses a tag outside the pattern', () => {
    expect(ReleaseReport.safeParse({ outcome: 'live' }).success).toBe(true);
    expect(
      ReleaseReport.safeParse({
        outcome: 'failed',
        failure: { step: 'publish', message: 'x', rolledBack: true },
      }).success,
    ).toBe(true);
    expect(ReleaseReport.safeParse({ outcome: 'published', tag: 'v2026.10.11', url: 'u' }).success).toBe(
      true,
    );
    expect(ReleaseReport.safeParse({ outcome: 'published', tag: 'latest', url: 'u' }).success).toBe(false);
    expect(ReleaseReport.safeParse({ outcome: 'publish_failed', message: 'no network' }).success).toBe(true);
    expect(ReleaseReport.safeParse({ outcome: 'deployed' }).success).toBe(false);
  });
});

describe('hybrid release contracts', () => {
  const sha = (n: number) => String(n).repeat(40).slice(0, 40);
  const hash = 'a'.repeat(64);
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const image = (n: number) => ({
    commit: sha(n),
    imageId: `sha256:${'b'.repeat(64)}`,
    platform: 'linux/arm64' as const,
  });
  const artifact = {
    ...image(2),
    manifestSha256: hash,
    archiveSha256: hash,
    archiveBytes: 1024,
  };
  const deployment = {
    version: 1 as const,
    releaseId: 'rel_1',
    attemptId: uuid(1),
    controllerId: uuid(2),
    targetHash: hash,
    engineId: 'eng_abcdefghijkl',
    revision: 0,
    phase: 'preparing' as const,
    previousImage: image(1),
    previousEngineCommit: sha(1),
    previousSchemaVersion: 74,
    artifact: null,
    pauseId: null,
    maintenance: false,
    recovery: null,
    startedAt: '2026-10-17T10:00:00.000Z',
    updatedAt: '2026-10-17T10:00:00.000Z',
  };

  it('accepts a deployment and refuses an unknown field, a short commit and a non-arm image', () => {
    expect(HybridDeployment.safeParse(deployment).success).toBe(true);
    expect(HybridDeployment.safeParse({ ...deployment, extra: 1 }).success).toBe(false);
    expect(HybridDeployment.safeParse({ ...deployment, previousEngineCommit: 'abc123' }).success).toBe(false);
    expect(
      HybridDeployment.safeParse({
        ...deployment,
        previousImage: { ...image(1), platform: 'linux/amd64' },
      }).success,
    ).toBe(false);
  });

  it('holds the slot in an unfinished phase or while the fence is up', () => {
    expect(isDeploymentActive({ phase: 'switching', maintenance: true })).toBe(true);
    expect(isDeploymentActive({ phase: 'recovery_required', maintenance: false })).toBe(true);
    expect(isDeploymentActive({ phase: 'live', maintenance: true })).toBe(true);
    expect(isDeploymentActive({ phase: 'live', maintenance: false })).toBe(false);
    expect(isDeploymentActive({ phase: 'published', maintenance: false })).toBe(false);
    expect(isDeploymentActive({ phase: 'failed', maintenance: false })).toBe(false);
  });

  it('takes a report only with the image that runs afterwards', () => {
    const live = { kind: 'report', report: { outcome: 'live' } };
    expect(ReleaseDeploymentChange.safeParse(live).success).toBe(false);
    expect(ReleaseDeploymentChange.safeParse({ ...live, image: image(2) }).success).toBe(true);

    const rolledBack = {
      kind: 'report',
      report: { outcome: 'failed', failure: { step: 'rollback', message: 'x', rolledBack: true } },
    };
    expect(ReleaseDeploymentChange.safeParse(rolledBack).success).toBe(false);
    expect(ReleaseDeploymentChange.safeParse({ ...rolledBack, image: image(1) }).success).toBe(true);

    const notRolledBack = {
      kind: 'report',
      report: { outcome: 'failed', failure: { step: 'rollback', message: 'x', rolledBack: false } },
    };
    expect(ReleaseDeploymentChange.safeParse(notRolledBack).success).toBe(true);
    expect(ReleaseDeploymentChange.safeParse({ ...notRolledBack, image: image(1) }).success).toBe(false);
    expect(
      ReleaseDeploymentChange.safeParse({
        kind: 'report',
        report: { outcome: 'published', tag: 'v2026.10.17', url: 'u' },
        image: image(2),
      }).success,
    ).toBe(false);
  });

  it('knows the other changes and refuses an unknown kind or a stray field', () => {
    expect(ReleaseDeploymentChange.safeParse({ kind: 'prepared', artifact }).success).toBe(true);
    expect(ReleaseDeploymentChange.safeParse({ kind: 'quiesce' }).success).toBe(true);
    expect(ReleaseDeploymentChange.safeParse({ kind: 'switch' }).success).toBe(true);
    expect(ReleaseDeploymentChange.safeParse({ kind: 'resume', pauseId: 'p1' }).success).toBe(true);
    expect(
      ReleaseDeploymentChange.safeParse({ kind: 'recovery', code: 'rollback_failed', message: 'x' }).success,
    ).toBe(true);
    expect(
      ReleaseDeploymentChange.safeParse({ kind: 'recovery', code: 'something_else', message: 'x' }).success,
    ).toBe(false);
    expect(ReleaseDeploymentChange.safeParse({ kind: 'switch', force: true }).success).toBe(false);
    expect(ReleaseDeploymentChange.safeParse({ kind: 'live' }).success).toBe(false);
  });

  it('keeps begin and change requests strict and keyed by uuids', () => {
    const begin = {
      releaseId: 'rel_1',
      attemptId: uuid(1),
      controllerId: uuid(2),
      requestId: uuid(3),
      targetHash: hash,
      engineId: 'eng_abcdefghijkl',
      previousImage: image(1),
    };
    expect(ReleaseDeployBegin.safeParse(begin).success).toBe(true);
    expect(ReleaseDeployBegin.safeParse({ ...begin, requestId: 'nope' }).success).toBe(false);
    expect(ReleaseDeployBegin.safeParse({ ...begin, credentials: 'x' }).success).toBe(false);

    const change = {
      releaseId: 'rel_1',
      attemptId: uuid(1),
      requestId: uuid(4),
      expectedRevision: 0,
      change: { kind: 'quiesce' },
    };
    expect(ReleaseDeployChange.safeParse(change).success).toBe(true);
    expect(ReleaseDeployChange.safeParse({ ...change, expectedRevision: -1 }).success).toBe(false);
  });

  it('names a remote engine as the second target, never the local one', () => {
    expect(HybridReleaseTarget.safeParse({ engineId: 'eng_abcdefghijkl', targetHash: hash }).success).toBe(
      true,
    );
    expect(HybridReleaseTarget.safeParse({ engineId: 'local', targetHash: hash }).success).toBe(false);
    expect(HybridReleaseTarget.safeParse({ engineId: 'eng_abcdefghijkl', targetHash: 'abc' }).success).toBe(
      false,
    );
  });

  it('carries the release deploy ops through the control protocol', () => {
    expect(ControlRequest.safeParse({ op: 'release_deploy_get', releaseId: 'rel_1' }).success).toBe(true);
    expect(
      ControlRequest.safeParse({
        op: 'release_deploy_begin',
        releaseId: 'rel_1',
        attemptId: uuid(1),
        controllerId: uuid(2),
        requestId: uuid(3),
        targetHash: hash,
        engineId: 'eng_abcdefghijkl',
        previousImage: image(1),
      }).success,
    ).toBe(true);
    expect(
      ControlRequest.safeParse({
        op: 'release_deploy_change',
        releaseId: 'rel_1',
        attemptId: uuid(1),
        requestId: uuid(4),
        expectedRevision: 3,
        change: { kind: 'switch' },
      }).success,
    ).toBe(true);
    expect(ControlRequest.safeParse({ op: 'release_deploy_get' }).success).toBe(false);

    const answer = ControlResponse.safeParse({
      ok: true,
      pause: null,
      deployment,
      drain: {
        observedAt: '2026-10-17T10:00:00.000Z',
        ready: false,
        uncertain: true,
        engineOnline: true,
        pending: { sessions: 1, merges: 0, documentWrites: 0, fullTests: 0, screenshots: 0 },
      },
      databaseSchemaVersion: 75,
    });
    expect(answer.success).toBe(true);
  });
});
