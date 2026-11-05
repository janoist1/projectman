import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerEvent, TokenUsage } from '@projectman/shared';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';
import { systemNotices } from './helpers/notices';

/** The warning limit of a session's tokens (PM-187), fed by the runner's `usage` events. */

const OPUS = (input: number, cacheRead = 0): TokenUsage => ({
  model: 'claude-opus-5-5',
  scope: 'main',
  input,
  output: 0,
  cacheRead,
  cacheWrite: 0,
});
const SUBAGENT = (output: number): TokenUsage => ({
  model: 'claude-haiku-4-5',
  scope: 'subagent',
  input: 0,
  output,
  cacheRead: 0,
  cacheWrite: 0,
});

describe('session token warning limit', () => {
  let h: DomainHarness;
  let now: Date;
  let events: ServerEvent[];
  const task = { type: 'task' as const, taskKey: 'AR-1' };

  beforeEach(async () => {
    now = new Date('2026-10-01T12:00:00.000Z');
    h = await createDomainHarness({ now: () => now });
    events = [];
    h.domain.bus.subscribe((e) => events.push(e));
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
  });
  afterEach(() => h.cleanup());

  const setLimit = (limit: number | null) =>
    h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (config) => {
      if (limit === null) delete config.team.limits.warnAboveSessionTokens;
      else config.team.limits.warnAboveSessionTokens = limit;
      return 'Set the token warning limit';
    });
  /** The owners are told by a notice message (PM-1250), not by an inbox item. */
  const alerts = async () => {
    await flush();
    return systemNotices(h, 'session_tokens');
  };
  const usage = (sessionId: string, ...entries: TokenUsage[]) =>
    h.runner.emit({ type: 'usage', sessionId, entries });

  it('raises nothing without a limit, however much a session uses', async () => {
    const { session } = await h.domain.sessions.ensureSession('AR', 'cr', task);
    usage(session.id, OPUS(5_000_000_000));
    expect(await alerts()).toEqual([]);
    expect(h.domain.sessions.get('AR', session.id)).not.toHaveProperty('usageAlert');
  });

  it('tells the owners once when a session reaches the limit, and the session keeps running', async () => {
    await setLimit(50_000);
    const { session } = await h.domain.sessions.ensureSession('AR', 'cr', task);
    h.runner.setState(session.id, 'working', 'Bash: npm test');

    // Below the limit: 30 000 input + a tenth of 100 000 cache reads.
    usage(session.id, OPUS(30_000, 100_000));
    expect(await alerts()).toEqual([]);

    // A subagent's output pushes it over: 40 000 + 10 000 = 50 000.
    now = new Date('2026-10-01T12:05:00.000Z');
    events = [];
    usage(session.id, SUBAGENT(10_000));
    const [item, ...more] = await alerts();
    expect(more).toEqual([]);
    expect(item).toMatchObject({
      from: 'system',
      to: ['owner'],
      origin: {
        kind: 'system_notice',
        notice: 'session_tokens',
        params: { counted: 50_000, limit: 50_000, taskKey: 'AR-1' },
      },
    });
    // No inbox item and no push: the notice is the whole alert.
    expect(h.domain.inbox.list('AR', { kind: 'alert' })).toEqual([]);
    const marked = h.domain.sessions.get('AR', session.id);
    expect(marked.usageAlert).toEqual({
      at: '2026-10-01T12:05:00.000Z',
      countedTokens: 50_000,
      limitTokens: 50_000,
    });
    // The screens learn of it at once, even mid-turn; the session is still working.
    const published = events.flatMap((e) => (e.type === 'session_upserted' ? [e.session] : []));
    expect(published.at(-1)?.usageAlert).toEqual(marked.usageAlert);
    expect(marked.state).toBe('working');
    expect(h.runner.isRunning(session.id)).toBe(true);

    // More usage raises nothing more.
    usage(session.id, OPUS(1_000_000));
    usage(session.id, OPUS(1_000_000));
    expect(await alerts()).toHaveLength(1);
    expect(h.domain.sessions.get('AR', session.id).usageAlert?.countedTokens).toBe(50_000);
    expect(h.runner.isRunning(session.id)).toBe(true);
  });

  it("names a chat's session without a card", async () => {
    await setLimit(10_000);
    const { session } = await h.domain.sessions.ensureSession('AR', 'cr', { type: 'general' });
    usage(session.id, OPUS(20_000));
    const [notice, ...more] = await alerts();
    expect(more).toEqual([]);
    expect(notice!.origin.params).toEqual({ counted: 20_000, limit: 10_000 });
    expect(h.domain.sessions.get('AR', session.id).usageAlert).toBeDefined();
  });

  it('raises nothing about ended sessions when the limit is lowered, nor a second one on a resume', async () => {
    await setLimit(1_000_000);
    const quiet = await h.domain.sessions.ensureSession('AR', 'cr', task);
    usage(quiet.session.id, OPUS(200_000));
    h.runner.emit({ type: 'exit', sessionId: quiet.session.id, exitCode: 0, signal: null });
    const loud = await h.domain.sessions.ensureSession('AR', 'dev-1', task);
    usage(loud.session.id, OPUS(1_500_000));
    expect(await alerts()).toHaveLength(1);
    h.runner.emit({ type: 'exit', sessionId: loud.session.id, exitCode: 0, signal: null });

    // Lowered below both: nothing is raised about the ended sessions.
    await setLimit(100_000);
    expect(await alerts()).toHaveLength(1);
    expect(h.domain.sessions.get('AR', quiet.session.id)).not.toHaveProperty('usageAlert');

    // Resumed and using more: the quiet one now raises its one alert, the loud one none again.
    await h.domain.sessions.ensureSession('AR', 'cr', task);
    await h.domain.sessions.ensureSession('AR', 'dev-1', task);
    usage(quiet.session.id, OPUS(1));
    usage(loud.session.id, OPUS(1));
    expect(await alerts()).toHaveLength(2);
    expect(h.domain.sessions.get('AR', loud.session.id).usageAlert).toBeDefined();
    expect(h.domain.sessions.get('AR', quiet.session.id).usageAlert?.limitTokens).toBe(100_000);
  });

  it('raises nothing once the limit is removed', async () => {
    await setLimit(10_000);
    await setLimit(null);
    const { session } = await h.domain.sessions.ensureSession('AR', 'cr', task);
    usage(session.id, OPUS(20_000));
    expect(await alerts()).toEqual([]);
  });
});
