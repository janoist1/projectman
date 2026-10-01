import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerEvent, Session, TokenUsage } from '@projectman/shared';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

/** Token usage of sessions, cards and members (PM-178), fed by the runner's `usage` events. */

const OPUS = (input: number, output = 0): TokenUsage => ({
  model: 'claude-opus-5-5',
  scope: 'main',
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
});
const HAIKU_SUBAGENT: TokenUsage = {
  model: 'claude-haiku-4-5',
  scope: 'subagent',
  input: 3,
  output: 2,
  cacheRead: 30,
  cacheWrite: 1,
};

describe('token usage', () => {
  let h: DomainHarness;
  let now: Date;
  let events: ServerEvent[];
  const task = { type: 'task' as const, taskKey: 'AR-1' };
  const VIEWER = { access: 'owner' as const, handle: 'owner' };

  beforeEach(async () => {
    now = new Date('2026-10-01T12:00:00.000Z');
    h = await createDomainHarness({ now: () => now });
    events = [];
    h.domain.bus.subscribe((e) => events.push(e));
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
  });
  afterEach(() => h.cleanup());

  const published = (id: string): Session[] =>
    events.flatMap((e) => (e.type === 'session_upserted' && e.session.id === id ? [e.session] : []));

  it("adds up a session's usage per model, its subagents' apart, and shows it once the turn is over", async () => {
    const { session } = await h.domain.sessions.ensureSession('AR', 'cr', task);
    expect(session.usage).toEqual({ since: now.toISOString(), rows: [] });

    h.runner.setState(session.id, 'working', 'Bash: npm test');
    events = [];
    h.runner.emit({ type: 'usage', sessionId: session.id, entries: [OPUS(10, 1)] });
    h.runner.emit({ type: 'usage', sessionId: session.id, entries: [OPUS(0, 4), HAIKU_SUBAGENT] });
    // During a turn the state changes carry it to the screens.
    expect(published(session.id)).toEqual([]);
    h.runner.setState(session.id, 'idle', null);
    expect(published(session.id).at(-1)?.usage?.rows).toEqual([OPUS(10, 5), HAIKU_SUBAGENT]);

    // The last lines of a turn may come after its Stop: then the usage event itself shows them.
    events = [];
    h.runner.emit({ type: 'usage', sessionId: session.id, entries: [OPUS(1)] });
    expect(published(session.id).at(-1)?.usage?.rows).toEqual([OPUS(11, 5), HAIKU_SUBAGENT]);
    expect(h.domain.sessions.get('AR', session.id).usage).toEqual({
      since: '2026-10-01T12:00:00.000Z',
      rows: [OPUS(11, 5), HAIKU_SUBAGENT],
    });
    // The card's sessions carry their usage.
    expect(h.domain.sessions.list('AR', { taskKey: 'AR-1' })[0]!.usage?.rows).toEqual([
      OPUS(11, 5),
      HAIKU_SUBAGENT,
    ]);
  });

  it('has no usage for a session from before the measurement, and counts it from its resume on', async () => {
    const { session } = await h.domain.sessions.ensureSession('AR', 'cr', task);
    h.runner.emit({ type: 'transcript_path', sessionId: session.id, path: '/tmp/transcript.jsonl' });
    h.runner.emit({ type: 'exit', sessionId: session.id, exitCode: 0, signal: null });
    // As a row written by an older build.
    h.repos.db.prepare('UPDATE sessions SET usage_since = NULL WHERE id = ?').run(session.id);
    const old = h.domain.sessions.get('AR', session.id);
    expect(old).not.toHaveProperty('usage');
    expect((await h.domain.sessions.detail('AR', session.id)).session).not.toHaveProperty('usage');

    now = new Date('2026-10-02T08:00:00.000Z');
    const resumed = await h.domain.sessions.ensureSession('AR', 'cr', task);
    expect(resumed).toMatchObject({ resumed: true });
    expect(resumed.session.usage).toEqual({ since: '2026-10-02T08:00:00.000Z', rows: [] });

    // A later resume keeps counting from the first measured one.
    h.runner.emit({ type: 'usage', sessionId: session.id, entries: [OPUS(7)] });
    h.runner.emit({ type: 'exit', sessionId: session.id, exitCode: 0, signal: null });
    now = new Date('2026-10-02T09:00:00.000Z');
    const again = await h.domain.sessions.ensureSession('AR', 'cr', task);
    expect(again.session.usage).toEqual({ since: '2026-10-02T08:00:00.000Z', rows: [OPUS(7)] });
  });

  it("sums a member's sessions over the last day and the last week, by the hour", async () => {
    const { session } = await h.domain.sessions.ensureSession('AR', 'cr', task);
    const general = await h.domain.sessions.ensureSession('AR', 'cr', { type: 'general' });
    const at = (iso: string, sessionId: string, entries: TokenUsage[]) => {
      now = new Date(iso);
      h.runner.emit({ type: 'usage', sessionId, entries });
    };
    at('2026-09-20T12:00:00.000Z', session.id, [OPUS(1000)]); // older than a week
    at('2026-09-28T12:00:00.000Z', session.id, [OPUS(100)]);
    at('2026-10-01T10:30:00.000Z', session.id, [OPUS(10), HAIKU_SUBAGENT]);
    at('2026-10-01T11:59:00.000Z', general.session.id, [OPUS(1)]);
    // The last day starts in the hour of 2026-10-01T10:15: all of that hour counts.
    now = new Date('2026-10-02T10:15:00.000Z');

    const profile = await h.domain.profiles.profile('AR', 'cr', VIEWER);
    expect(profile.usage).toEqual({
      lastDay: [OPUS(11), HAIKU_SUBAGENT],
      lastWeek: [OPUS(111), HAIKU_SUBAGENT],
    });
    // Another member used nothing; a human member has no usage at all.
    expect((await h.domain.profiles.profile('AR', 'dev-1', VIEWER)).usage).toEqual({
      lastDay: [],
      lastWeek: [],
    });
    expect(await h.domain.profiles.profile('AR', 'owner', VIEWER)).not.toHaveProperty('usage');
  });
});
