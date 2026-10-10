import { afterEach, describe, expect, it } from 'vitest';
import { alertPayloadOf } from '@projectman/shared';
import type { AgentProvider, ProjectConfig } from '@projectman/shared';
import { waitFor } from '../src/runner/test-helpers';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { rejection } from './helpers/errors';
import { settle } from './helpers/fakes';

/**
 * An automatic start of a member whose provider is not logged in waits (`provider_not_logged_in`,
 * PM-324) and starts once the login is there; a person's start gets the refusal. A provider whose
 * state cannot be checked holds nothing back.
 */

const codexDev1 = (config: ProjectConfig): void => {
  const dev1 = config.team.members.find((m) => m.handle === 'dev-1');
  if (dev1?.kind === 'ai') dev1.provider = 'codex';
};

/** Makes the fake runner report the login of each provider (undefined: it cannot tell). */
function loginOf(h: DomainHarness, state: { loggedIn: boolean | null | 'throws' }) {
  Object.assign(h.runner, {
    providerStatus: async (provider: AgentProvider) => {
      if (state.loggedIn === 'throws') throw new Error('fictional: the check failed');
      return {
        provider,
        loggedIn: state.loggedIn,
        method: state.loggedIn ? 'chatgpt' : 'none',
        checkedAt: '2026-01-01T00:00:00.000Z',
        ...(state.loggedIn === false ? { problem: 'not_logged_in' as const } : {}),
      };
    },
  });
}

describe('a start while the provider is not logged in', () => {
  let h: DomainHarness;
  afterEach(() => h?.cleanup());
  it.each(['no_key', 'cli_too_old', 'cli_missing', 'chatgpt_login', 'not_logged_in'] as const)(
    'defers NanoGPT for %s and starts after readiness changes',
    async (problem) => {
      h = await createDomainHarness({
        adjust: (config) => {
          const member = config.team.members.find((m) => m.handle === 'dev-1');
          if (member?.kind === 'ai') member.provider = 'nanogpt';
        },
      });
      let ready = false;
      Object.assign(h.runner, {
        providerStatus: async () => ({
          provider: 'nanogpt',
          loggedIn: ready,
          method: 'api_key',
          checkedAt: '2026-01-01T00:00:00.000Z',
          ...(!ready ? { problem } : {}),
        }),
      });
      const task = await h.domain.tasks.create('AR', { title: 'Fictional NanoGPT wait' }, OWNER_ACTOR);
      await h.domain.messaging.send('AR', 'owner', {
        to: ['dev-1'],
        text: 'Start the fictional task',
        taskKey: task.key,
      });
      expect(await waitFor(() => h.domain.tasks.get('AR', task.key).startWaiting)).toMatchObject({
        reason:
          problem === 'no_key'
            ? 'nanogpt_key_missing'
            : problem === 'not_logged_in'
              ? 'provider_not_logged_in'
              : 'nanogpt_setup_incomplete',
        provider: 'nanogpt',
      });
      expect(h.runner.started).toEqual([]);
      ready = true;
      await h.domain.admission.retryDeferred();
      await waitFor(() => h.domain.sessions.findRunning('AR', 'dev-1', { type: 'task', taskKey: task.key }));
      expect(h.runner.started).toHaveLength(1);
    },
  );

  it('waits with the provider, and starts on the next retry once logged in', async () => {
    h = await createDomainHarness({ adjust: codexDev1 });
    const state = { loggedIn: false as boolean | null | 'throws' };
    loginOf(h, state);
    const task = await h.domain.tasks.create('AR', { title: 'Fictional login wait' }, OWNER_ACTOR);
    await h.domain.messaging.send('AR', 'owner', {
      to: ['dev-1'],
      text: 'Look at this fictional task.',
      taskKey: task.key,
    });
    const waiting = await waitFor(() => h.domain.tasks.get('AR', task.key).startWaiting);
    expect(waiting).toMatchObject({
      reason: 'provider_not_logged_in',
      member: 'dev-1',
      provider: 'codex',
      since: expect.any(String),
    });
    expect(h.runner.started).toEqual([]);

    await h.domain.outages.check();
    const item = h.domain.inbox
      .list('AR', { kind: 'alert', state: 'open' })
      .find((item) => alertPayloadOf(item)?.alert === 'work_outage');
    expect(item).toMatchObject({ payload: { tasks: [task.key], members: ['dev-1'] } });
    expect(h.domain.tasks.get('AR', task.key).outage).toMatchObject({ kind: 'provider', provider: 'codex' });
    expect(
      (await h.domain.members.roster('AR')).find((member) => member.handle === 'dev-1')?.outage,
    ).toMatchObject({ provider: 'codex' });

    state.loggedIn = true;
    await h.domain.outages.check();
    await waitFor(() => h.domain.sessions.findRunning('AR', 'dev-1', { type: 'task', taskKey: task.key }));
    expect(h.runner.started).toHaveLength(1);
    expect(h.domain.tasks.get('AR', task.key).startWaiting).toBeUndefined();
    expect(h.domain.tasks.get('AR', task.key).outage).toBeUndefined();
    expect(h.domain.inbox.get('AR', item!.id)).toMatchObject({
      state: 'resolved',
      resolution: { rule: 'outage_ended' },
    });
  });

  it("gives a person's start the refusal instead of waiting", async () => {
    h = await createDomainHarness({ adjust: codexDev1 });
    loginOf(h, { loggedIn: false });
    const err = await rejection(h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' }));
    expect(err).toMatchObject({ code: 'provider_not_logged_in', details: { provider: 'codex' } });
    expect(h.runner.started).toEqual([]);
  });

  it('observes a session auth error without waiting for the periodic check', async () => {
    h = await createDomainHarness({ adjust: codexDev1 });
    const state = { loggedIn: true as boolean | null | 'throws' };
    loginOf(h, state);
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
    state.loggedIn = false;
    h.runner.emit({ type: 'auth_error', sessionId: session.id, provider: 'codex', message: 'Login expired' });
    const item = await waitFor(() =>
      h.domain.inbox
        .list('AR', { kind: 'alert', state: 'open' })
        .find((item) => alertPayloadOf(item)?.alert === 'work_outage'),
    );
    expect(item.payload).toMatchObject({
      outage: { kind: 'provider', provider: 'codex' },
      members: ['dev-1'],
    });
  });

  it.each([null, 'throws'] as const)(
    'does not hold the start back when the login is unknown (%s)',
    async (unknown) => {
      h = await createDomainHarness({ adjust: codexDev1 });
      loginOf(h, { loggedIn: unknown });
      const task = await h.domain.tasks.create('AR', { title: 'Fictional unknown login' }, OWNER_ACTOR);
      await h.domain.messaging.send('AR', 'owner', {
        to: ['dev-1'],
        text: 'Look at this fictional task.',
        taskKey: task.key,
      });
      await waitFor(() => h.domain.sessions.findRunning('AR', 'dev-1', { type: 'task', taskKey: task.key }));
      await settle();
      expect(h.domain.tasks.get('AR', task.key).startWaiting).toBeUndefined();
    },
  );
});
