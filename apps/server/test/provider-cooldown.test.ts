import { afterEach, describe, expect, it } from 'vitest';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { waitFor } from '../src/runner/test-helpers';

describe('NanoGPT provider cooldown admission', () => {
  let h: DomainHarness;
  afterEach(() => h?.cleanup());

  it('raises one owner alert for simultaneous failures and refuses input into another live session', async () => {
    let now = new Date('2026-10-06T12:00:00Z');
    h = await createDomainHarness({
      now: () => now,
      adjust: (config) => {
        for (const member of config.team.members)
          if (member.kind === 'ai' && ['dev-1', 'dev-2'].includes(member.handle)) member.provider = 'nanogpt';
      },
    });
    const first = await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
    const second = await h.domain.sessions.ensureSession('AR', 'dev-2', { type: 'general' });
    for (const session of [first.session, second.session])
      h.runner.emit({
        type: 'rate_limited',
        sessionId: session.id,
        provider: 'nanogpt',
        message: '429 Too Many Requests',
        at: now.toISOString(),
      });
    const alerts = h.repos.inbox
      .list('AR', { kind: 'alert' })
      .filter((item) => item.payload.alert === 'provider_rate_limited');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      assignees: ['owner'],
      source: 'dev-1',
      payload: { provider: 'nanogpt', until: '2026-10-06T12:15:00.000Z', message: '429 Too Many Requests' },
    });
    expect(() => h.domain.sessions.typeInto(second.session, 'Blocked input')).toThrow(
      expect.objectContaining({ code: 'provider_rate_limited' }),
    );
    await h.domain.messaging.send('AR', 'owner', { to: ['dev-2'], text: 'Deferred live input' });
    await waitFor(() => h.repos.deferredStarts.list().length > 0);
    expect(h.runner.messages.some((message) => message.text.includes('Deferred live input'))).toBe(false);
    now = new Date('2026-10-06T12:30:00Z');
    await h.domain.admission.retryDeferred();
    await waitFor(() => h.runner.messages.some((message) => message.text.includes('Deferred live input')));
    expect(h.runner.started).toHaveLength(2);
  });

  it('defers message wakeups across members until expiry and resets after a successful turn', async () => {
    let now = new Date('2026-10-06T12:00:00Z');
    h = await createDomainHarness({
      now: () => now,
      adjust: (config) => {
        for (const member of config.team.members)
          if (member.kind === 'ai' && ['dev-1', 'dev-2'].includes(member.handle)) member.provider = 'nanogpt';
      },
    });
    const first = await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
    h.runner.emit({
      type: 'rate_limited',
      sessionId: first.session.id,
      provider: 'nanogpt',
      message: '429 Too Many Requests',
      at: now.toISOString(),
    });
    h.runner.setState(first.session.id, 'failed', '429 Too Many Requests');
    await h.runner.stop(first.session.id);
    const task = await h.domain.tasks.create('AR', { title: 'Fictional quota retry' }, OWNER_ACTOR);
    await h.domain.messaging.send('AR', 'owner', {
      to: ['dev-2'],
      text: 'Continue after quota reset',
      taskKey: task.key,
    });
    expect(await waitFor(() => h.domain.tasks.get('AR', task.key).startWaiting)).toMatchObject({
      reason: 'provider_rate_limited',
      provider: 'nanogpt',
      until: '2026-10-06T12:15:00.000Z',
    });
    now = new Date('2026-10-06T12:14:59Z');
    await h.domain.admission.retryDeferred();
    expect(h.runner.started).toHaveLength(1);
    now = new Date('2026-10-06T12:15:00Z');
    await h.domain.admission.retryDeferred();
    const next = await waitFor(() =>
      h.domain.sessions.findRunning('AR', 'dev-2', { type: 'task', taskKey: task.key }),
    );
    expect(h.runner.started).toHaveLength(2);
    h.runner.emit({
      type: 'rate_limited',
      sessionId: next.id,
      provider: 'nanogpt',
      message: '429',
      at: now.toISOString(),
    });
    await expect(h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' })).rejects.toMatchObject({
      code: 'provider_rate_limited',
      details: { until: '2026-10-06T12:45:00.000Z' },
    });
    now = new Date('2026-10-06T12:45:00Z');
    h.runner.setState(next.id, 'working');
    h.runner.setState(next.id, 'idle');
    h.runner.emit({
      type: 'rate_limited',
      sessionId: next.id,
      provider: 'nanogpt',
      message: '429',
      at: now.toISOString(),
    });
    await expect(h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' })).rejects.toMatchObject({
      details: { until: '2026-10-06T13:00:00.000Z' },
    });
  });
});
