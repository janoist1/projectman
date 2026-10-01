import { routes } from '@projectman/shared';
import type { Session } from '@projectman/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { waitFor } from '../src/runner/test-helpers';
import { createAppHarness, createProject, OWNER_LOGIN, setupOwner } from './helpers/app-harness';
import type { CliAppHarness } from './helpers/app-harness';

/**
 * The warning limit of a session's tokens (PM-187) through the real runner and the fake Claude
 * Code CLI: the usage read from its transcript crosses a low limit, the owners get one alert, and
 * the session goes on answering. A general chat, so every turn is one this test types: a task's
 * start moves the card, and what its stages hand over could add turns of their own.
 */

let h: CliAppHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

/** One turn of the fake CLI with FAKE_CLAUDE_INPUT_TOKENS=6000: 6 000 + 5 + 20 + a tenth of 100. */
const TURN = 6_035;

it(
  'alerts the owners once when a turn crosses the limit, and the session works on',
  { timeout: 90_000 },
  async () => {
    vi.stubEnv('FAKE_CLAUDE_INPUT_TOKENS', '6000');
    h = await createAppHarness({ runner: 'fake-cli' });
    const { app } = h;
    const cookie = await setupOwner(app);
    const headers = { cookie };
    await createProject(h, cookie);
    const { domain } = app.projectman;
    await domain.projects.update(
      'AR',
      { actor: { kind: 'human', handle: 'owner' }, author: OWNER_LOGIN },
      (config) => {
        const dev = config.team.members.find((m) => m.handle === 'dev-1');
        if (dev?.kind === 'ai') dev.provider = 'claude';
        config.team.limits.warnAboveSessionTokens = 10_000;
        return 'Warn above 10 000 tokens a session';
      },
    );
    const started = await app.inject({
      method: 'POST',
      url: routes.startConversation('AR', 'dev-1'),
      headers,
    });
    expect(started.statusCode, started.body).toBe(202);
    const sessionId = started.json<Session>().id;
    const alerts = () => domain.inbox.list('AR', { kind: 'alert' });
    const session = () => domain.sessions.get('AR', sessionId);
    const idle = (what: string) => waitFor(() => session().state === 'idle', { what, timeoutMs: 20_000 });
    const said = (text: string) =>
      vi.waitFor(
        async () => {
          const { chat } = await domain.sessions.detail('AR', sessionId);
          expect(chat.some((i) => i.kind === 'assistant_text' && i.text === text)).toBe(true);
        },
        { timeout: 20_000 },
      );
    const turn = async (text: string) => {
      const res = await app.inject({
        method: 'POST',
        url: routes.sessionMessages('AR', sessionId),
        headers,
        payload: { text },
      });
      expect(res.statusCode, res.body).toBe(202);
      await said(`Echo: ${text}`);
    };
    /** Uncached input of the session's own conversation: 6 000 a turn, once its response is read. */
    const input = () => session().usage?.rows.find((row) => row.scope === 'main')?.input ?? 0;

    // One turn stays below the limit.
    await idle('the chat to be ready');
    await turn('First step');
    await waitFor(() => input() === 6_000, { what: 'the first turn usage', timeoutMs: 20_000 });
    expect(alerts()).toEqual([]);
    expect(session()).not.toHaveProperty('usageAlert');

    // The second crosses it: one alert, the session marked with the same numbers.
    await idle('the first turn to end');
    await turn('Second step');
    await waitFor(() => alerts().length > 0, { what: 'the alert', timeoutMs: 20_000 });
    const [alert] = alerts();
    expect(alert).toMatchObject({
      state: 'open',
      assignees: ['owner'],
      source: 'dev-1',
      sessionId,
      taskKey: null,
      payload: { alert: 'session_tokens', limitTokens: 10_000, workItem: { type: 'general' } },
    });
    // A response's lines may be read together or apart: its output count grows from a placeholder.
    const counted = alert!.payload.countedTokens as number;
    expect(counted).toBeGreaterThanOrEqual(10_000);
    expect(counted).toBeLessThanOrEqual(2 * TURN);
    expect(session().usageAlert).toMatchObject({ countedTokens: counted, limitTokens: 10_000 });

    // It answers on; a third turn raises no second alert.
    await idle('the second turn to end');
    await turn('Third step');
    await waitFor(() => input() === 18_000, { what: 'the third turn usage', timeoutMs: 20_000 });
    expect(alerts()).toHaveLength(1);
    expect(session().usageAlert?.countedTokens).toBe(counted);
    expect(app.projectman.runnerModule.runner.isRunning(sessionId)).toBe(true);
  },
);
