import { routes } from '@projectman/shared';
import type { Task, TaskDetail } from '@projectman/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { waitFor } from '../src/runner/test-helpers';
import { createAppHarness, createProject, OWNER_LOGIN, setupOwner } from './helpers/app-harness';
import type { CliAppHarness } from './helpers/app-harness';

/**
 * The warning limit of a session's tokens (PM-187) through the real runner and the fake Claude
 * Code CLI: the usage read from its transcript crosses a low limit, the owners get one alert, and
 * the session goes on answering.
 */

let h: CliAppHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

it(
  'alerts the owners once when a turn crosses the limit, and the session works on',
  { timeout: 90_000 },
  async () => {
    // Each turn: 6 000 input + 5 output + 20 cache writes + a tenth of 100 cache reads = 6 035.
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
    const created = await app.inject({
      method: 'POST',
      url: routes.tasks('AR'),
      headers,
      payload: { title: 'Acme checkout' },
    });
    const { key } = created.json<Task>();
    const started = await app.inject({
      method: 'POST',
      url: routes.startTask('AR', key),
      headers,
      payload: { assignee: 'dev-1' },
    });
    expect(started.statusCode).toBe(200);
    const sessionId = started.json<TaskDetail>().sessions[0]!.id;
    const alerts = () => domain.inbox.list('AR', { kind: 'alert' });
    const said = (text: string) =>
      vi.waitFor(
        async () => {
          const { chat } = await domain.sessions.detail('AR', sessionId);
          expect(chat.some((i) => i.kind === 'assistant_text' && i.text === text)).toBe(true);
        },
        { timeout: 20_000 },
      );
    const write = async (text: string) => {
      const res = await app.inject({
        method: 'POST',
        url: routes.sessionMessages('AR', sessionId),
        headers,
        payload: { text },
      });
      expect(res.statusCode).toBe(202);
    };
    const counted = () => domain.sessions.get('AR', sessionId).usage?.rows[0]?.input ?? 0;

    // The brief's turn stays below the limit.
    await waitFor(() => counted() === 6_000, { what: 'the first turn usage' });
    expect(alerts()).toEqual([]);

    // The second turn crosses it: one alert, the session marked.
    await waitFor(() => domain.sessions.get('AR', sessionId).state === 'idle', { what: 'idle' });
    await write('Second step');
    await waitFor(() => alerts().length > 0, { what: 'the alert' });
    expect(alerts()).toMatchObject([
      {
        state: 'open',
        assignees: ['owner'],
        source: 'dev-1',
        sessionId,
        taskKey: key,
        payload: { alert: 'session_tokens', countedTokens: 12_070, limitTokens: 10_000 },
      },
    ]);
    expect(domain.sessions.get('AR', sessionId).usageAlert).toMatchObject({ countedTokens: 12_070 });

    // It answers on; a third turn raises no second alert.
    await said('Echo: Second step');
    await waitFor(() => domain.sessions.get('AR', sessionId).state === 'idle', { what: 'idle again' });
    await write('Third step');
    await said('Echo: Third step');
    await waitFor(() => counted() === 18_000, { what: 'the third turn usage' });
    expect(alerts()).toHaveLength(1);
    expect(app.projectman.runnerModule.runner.isRunning(sessionId)).toBe(true);
  },
);
