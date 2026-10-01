import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InboxView, routes } from '@projectman/shared';
import type { ConfigView, SessionDetail, Task } from '@projectman/shared';
import { createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

/**
 * The warning limit of a session's tokens (PM-187) over HTTP: the owner sets and removes it in the
 * settings, a session crossing it shows up in the inbox and on the session, and keeps working.
 */
describe('session token warning limit through the API', () => {
  let h: AppHarness;
  let cookie: string;

  beforeEach(async () => {
    h = await createAppHarness();
    cookie = await setupOwner(h.app);
    await createProject(h, cookie);
  });
  afterEach(() => h.close());

  const patchLimits = async (limits: Record<string, unknown>) => {
    const view = (await inject(h.app, 'GET', routes.config('AR'), cookie)).json<ConfigView>();
    return inject(h.app, 'PATCH', routes.patchConfig('AR'), cookie, { baseVersion: view.version, limits });
  };
  const limitsNow = async () =>
    (await inject(h.app, 'GET', routes.config('AR'), cookie)).json<ConfigView>().config.team.limits;

  it('is set and removed in the settings, and refused out of range', async () => {
    expect(await limitsNow()).not.toHaveProperty('warnAboveSessionTokens');
    const set = await patchLimits({ warnAboveSessionTokens: 2_000_000 });
    expect(set.statusCode, set.body).toBe(200);
    expect((await limitsNow()).warnAboveSessionTokens).toBe(2_000_000);

    const tooLow = await patchLimits({ warnAboveSessionTokens: 100 });
    expect(tooLow.statusCode).toBe(400);
    expect((await limitsNow()).warnAboveSessionTokens).toBe(2_000_000);

    const removed = await patchLimits({ warnAboveSessionTokens: null });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(await limitsNow()).not.toHaveProperty('warnAboveSessionTokens');
  });

  it("puts one alert in the owner's inbox, marks the session and lets it work on", async () => {
    expect((await patchLimits({ warnAboveSessionTokens: 10_000 })).statusCode).toBe(200);
    const task = (
      await inject(h.app, 'POST', routes.tasks('AR'), cookie, { title: 'Validate the login form' })
    ).json<Task>();
    expect((await inject(h.app, 'POST', routes.startTask('AR', task.key), cookie, {})).statusCode).toBe(200);
    const { sessionId } = h.runner.lastStarted();
    const usage = (input: number) =>
      h.runner.emit({
        type: 'usage',
        sessionId,
        entries: [
          { model: 'claude-opus-5-5', scope: 'main', input, output: 0, cacheRead: 10_000, cacheWrite: 0 },
        ],
      });
    const alerts = async () =>
      InboxView.parse(
        (await inject(h.app, 'GET', `${routes.inbox('AR')}?state=all`, cookie)).json(),
      ).items.filter((item) => item.kind === 'alert');
    // 2 000 input + a tenth of 30 000 cache reads = 5 000.
    usage(1_000);
    usage(1_000);
    usage(0);
    expect(await alerts()).toEqual([]);

    // 7 000 input + a tenth of 40 000 = 11 000: over the limit; more usage raises no second alert.
    usage(5_000);
    usage(5_000);
    const [item, ...more] = await alerts();
    expect(more).toEqual([]);
    expect(item).toMatchObject({
      state: 'open',
      assignees: ['owner'],
      sessionId,
      taskKey: task.key,
      payload: { alert: 'session_tokens', countedTokens: 11_000, limitTokens: 10_000 },
    });

    const detail = (
      await inject(h.app, 'GET', routes.session('AR', sessionId), cookie)
    ).json<SessionDetail>();
    expect(detail.session.usageAlert).toMatchObject({ countedTokens: 11_000, limitTokens: 10_000 });
    expect(detail.session.state).not.toMatch(/exited|failed/);

    // The session takes a message as before.
    const written = await inject(h.app, 'POST', routes.sessionMessages('AR', sessionId), cookie, {
      text: 'Carry on, please.',
    });
    expect(written.statusCode, written.body).toBe(202);
    expect(h.runner.isRunning(sessionId)).toBe(true);

    const seen = await inject(h.app, 'POST', routes.resolveInbox('AR', item!.id), cookie, {
      optionId: 'seen',
    });
    expect(seen.statusCode, seen.body).toBe(200);
    expect(await alerts()).toMatchObject([{ state: 'resolved', resolution: { optionId: 'seen' } }]);
  });
});
