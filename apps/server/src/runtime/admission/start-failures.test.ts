import { describe, expect, it, vi } from 'vitest';
import { START_FAILURE_LIMIT, startRetryDelayMs } from '@projectman/shared';
import type { EngineId, Session, WorkItemRef } from '@projectman/shared';
import { createRepositories, openDatabase } from '../../db';
import type { DomainContext } from '../../core/base';
import { conflict, DomainError } from '../../kernel';
import { StartFailures } from './start-failures';
import type { StartFailureTarget } from './start-failures';

const START = Date.parse('2026-11-12T10:00:00.000Z');
const ENGINE = 'eng_aaaaaaaaaaaa' as EngineId;
const PLACE: WorkItemRef = { type: 'task', taskKey: 'AR-1' };
const TARGET: StartFailureTarget = { projectKey: 'AR', member: 'dev-1', place: PLACE, provider: 'codex' };

function world(opts: { onHold?: boolean; engine?: EngineId | null; awaitsFirstTurn?: boolean } = {}) {
  const repos = createRepositories(openDatabase(':memory:'));
  let nowMs = START;
  const ctx = { repos, now: () => new Date(nowMs) } as unknown as DomainContext;
  const build = () =>
    new StartFailures({
      ctx,
      engineOf: () => opts.engine ?? null,
      providerOnHold: () => opts.onHold === true,
      awaitsFirstTurn: () => opts.awaitsFirstTurn === true,
    });
  return {
    failures: build(),
    build,
    advance: (ms: number) => void (nowMs += ms),
    nowMs: () => nowMs,
  };
}

const ended = (patch: Partial<Session> & { beforeFirstTurn?: boolean } = {}) =>
  ({
    id: 'ses_1',
    projectKey: 'AR',
    member: 'dev-1',
    provider: 'codex',
    workItem: PLACE,
    state: 'failed',
    lastStop: { kind: 'failed' },
    beforeFirstTurn: true,
    ...patch,
  }) as unknown as Session & { beforeFirstTurn?: boolean };

describe('failed session starts (PM-1335)', () => {
  it('waits 30 s, 1, 2 and 4 minutes after the first failures, and the fifth one stops the place', () => {
    const { failures, advance, nowMs } = world();
    const reached = vi.fn();
    failures.useReachedLimit(reached);
    const gaps: number[] = [];
    for (let i = 1; i < START_FAILURE_LIMIT; i++) {
      const hold = failures.record(TARGET, { code: 'link_down', sessionId: null });
      expect(hold).toMatchObject({ code: 'start_backoff', failures: i });
      gaps.push(Date.parse((hold as { until: string }).until) - nowMs());
      advance(startRetryDelayMs(i));
      expect(failures.holdOf(TARGET)).toBeNull();
    }
    expect(gaps).toEqual([30_000, 60_000, 120_000, 240_000]);
    const last = failures.record(TARGET, { code: 'link_down', sessionId: null });
    expect(last).toMatchObject({ code: 'start_failing', failures: START_FAILURE_LIMIT });
    expect(reached).toHaveBeenCalledOnce();
    advance(24 * 3_600_000);
    expect(failures.holdOf(TARGET)).toMatchObject({ code: 'start_failing' });
    expect(failures.stoppedFor('AR', 'dev-1')).toBe(true);
  });

  it('holds the next automatic start while the backoff runs', () => {
    const { failures, advance } = world();
    failures.record(TARGET, { code: 'link_down', sessionId: null });
    expect(() => failures.beginAttempt(TARGET, true)).toThrowError(
      expect.objectContaining({ code: 'start_backoff' }),
    );
    expect(() => failures.beginAttempt(TARGET, false)).not.toThrow();
    advance(30_000);
    expect(() => failures.beginAttempt(TARGET, true)).not.toThrow();
  });

  it('counts a session once, however many points see its failure', () => {
    const { failures } = world();
    failures.record(TARGET, { code: 'session_start_failed', sessionId: 'ses_1' });
    failures.record(TARGET, { code: 'exited_before_first_input', sessionId: 'ses_1' });
    expect(failures.holdOf(TARGET)).toMatchObject({ failures: 1 });
    failures.record(TARGET, { code: 'session_start_failed', sessionId: 'ses_2' });
    expect(failures.holdOf(TARGET)).toMatchObject({ failures: 2 });
  });

  it('counts a new attempt that fails with the session the last one failed with', () => {
    const { failures } = world();
    failures.record(TARGET, { code: 'session_start_failed', sessionId: 'ses_1' });
    failures.beginAttempt(TARGET, false);
    failures.record(TARGET, { code: 'session_start_failed', sessionId: 'ses_1' });
    expect(failures.holdOf(TARGET)).toMatchObject({ failures: 2 });
  });

  it('keeps the hold across a restart: a new instance on the same database reads it', () => {
    const { failures, build } = world();
    for (let i = 0; i < START_FAILURE_LIMIT; i++)
      failures.record(TARGET, { code: 'link_down', sessionId: null });
    expect(build().holdOf(TARGET)).toMatchObject({ code: 'start_failing', failures: START_FAILURE_LIMIT });
  });

  it('gives a released place one more try, and its next failure stops it again', () => {
    const { failures } = world({ engine: ENGINE });
    const released = vi.fn();
    failures.useReleased(released);
    for (let i = 0; i < START_FAILURE_LIMIT; i++)
      failures.record(TARGET, { code: 'link_down', sessionId: null });
    failures.release({ provider: 'claude' });
    expect(failures.stoppedFor('AR', 'dev-1')).toBe(true);
    failures.release({ provider: 'codex', engineId: ENGINE });
    expect(released).toHaveBeenCalledOnce();
    expect(failures.stoppedFor('AR', 'dev-1')).toBe(false);
    expect(failures.holdOf(TARGET)).toBeNull();
    expect(failures.record(TARGET, { code: 'link_down', sessionId: null })).toMatchObject({
      code: 'start_failing',
    });
  });

  it('forgets the count once a session of the place works', () => {
    const { failures } = world();
    failures.record(TARGET, { code: 'link_down', sessionId: null });
    failures.stateChanged(ended({ state: 'working' }));
    expect(failures.holdOf(TARGET)).toBeNull();
    failures.record(TARGET, { code: 'link_down', sessionId: null });
    failures.stateChanged(ended({ state: 'idle' }));
    expect(failures.holdOf(TARGET)).toBeNull();
  });

  it('does not take an idle session that waits for its first turn as a working start', () => {
    const { failures } = world({ awaitsFirstTurn: true });
    failures.record(TARGET, { code: 'link_down', sessionId: null });
    failures.stateChanged(ended({ state: 'idle' }));
    expect(failures.holdOf(TARGET)).toMatchObject({ failures: 1 });
  });

  it('counts a session that ended before its first turn, and only that', () => {
    const { failures } = world();
    failures.sessionEnded(ended({ beforeFirstTurn: false }));
    failures.sessionEnded(ended({ id: 'ses_2', lastStop: { kind: 'manual' } }));
    failures.sessionEnded(
      ended({ id: 'ses_3', lastStop: { kind: 'failed', code: 'provider_rate_limited' } }),
    );
    // A clean exit (code 0) may be a stop nobody recorded: it is no failed start.
    failures.sessionEnded(ended({ id: 'ses_4', lastStop: { kind: 'exited' } }));
    expect(failures.holdOf(TARGET)).toBeNull();
    failures.sessionEnded(ended({ id: 'ses_5' }));
    expect(failures.holdOf(TARGET)).toMatchObject({ failures: 1 });
  });

  it('does not count a session that ended while its provider is in a rate-limit cooldown', () => {
    const { failures } = world({ onHold: true });
    failures.sessionEnded(ended());
    expect(failures.holdOf(TARGET)).toBeNull();
  });

  it('turns the failure of an automatic start into a refusal it can wait for, and leaves a personal start alone', () => {
    const { failures } = world();
    const startFailed = new DomainError('session_start_failed', 'no process', {
      status: 500,
      details: { sessionId: 'ses_9' },
    });
    const personal = failures.failedStart(startFailed, TARGET, false);
    expect(personal).toBe(startFailed);
    const automatic = failures.failedStart(new Error('the engine call timed out'), TARGET, true);
    expect(automatic).toMatchObject({ code: 'start_backoff', details: { failures: 2, provider: 'codex' } });
  });

  it('does not take a refusal of admission for a failed start', () => {
    const { failures } = world();
    const refusal = conflict('repo_required', 'choose a repository');
    expect(failures.failedStart(refusal, TARGET, true)).toBe(refusal);
    expect(failures.holdOf(TARGET)).toBeNull();
  });
});
