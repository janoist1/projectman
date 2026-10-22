import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_IDLE_CLOSE_MINUTES } from '@projectman/shared';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

/*
 * PM-297: a card that waits for a member's capacity shows what holds the member's places, read when the
 * card is (never stored), and so does the member's profile.
 */

const VIEWER = { access: 'owner' as const, handle: 'owner' };

describe('what holds the places of a member', () => {
  let h: DomainHarness;
  beforeEach(async () => {
    h = await createDomainHarness();
    await h.domain.tasks.create('AR', { title: 'Acme checkout' }, OWNER_ACTOR);
    await h.domain.tasks.create('AR', { title: 'Acme second checkout' }, OWNER_ACTOR);
  });
  afterEach(async () => {
    await h.domain.stop();
    await h.cleanup();
  });

  const wake = async () => {
    await h.domain.messaging.send('AR', 'owner', { to: ['cr'], text: 'Please check Acme.', taskKey: 'AR-2' });
    await flush();
  };

  it('shows the card that waits for the member the card that holds the place and the close time', async () => {
    const { session } = await h.domain.sessions.ensureSession('AR', 'cr', { type: 'task', taskKey: 'AR-1' });
    await wake();
    const waiting = h.domain.tasks.get('AR', 'AR-2').startWaiting!;
    expect(waiting).toMatchObject({
      reason: 'member_at_capacity',
      member: 'cr',
      capacity: 1,
      closeAfterMinutes: SESSION_IDLE_CLOSE_MINUTES,
    });
    expect(waiting.holders).toEqual([
      {
        kind: 'task',
        taskKey: 'AR-1',
        sessionId: session.id,
        working: true,
        startedAt: session.startedAt,
        lastActivityAt: expect.any(String),
      },
    ]);
    // Nothing of it is stored with the wait: it is read again each time.
    const stored = h.repos.memberQueue.listOpen('AR', 'cr').find((item) => item.taskKey === 'AR-2');
    expect(stored?.wait).toMatchObject({ code: 'member_at_capacity' });
    expect(stored?.waitDetails ?? {}).not.toHaveProperty('holders');
  });

  it('shows the present situation: the other places that fill up, and the profile says the same', async () => {
    await h.domain.sessions.ensureSession('AR', 'cr', { type: 'task', taskKey: 'AR-1' });
    await wake();
    expect(h.domain.tasks.get('AR', 'AR-2').startWaiting!.holders).toHaveLength(1);
    await h.domain.sessions.ensureSession('AR', 'cr', { type: 'general' });
    const holders = h.domain.tasks.get('AR', 'AR-2').startWaiting!.holders!;
    expect(holders.map((holder) => holder.kind)).toEqual(['task', 'general']);

    const profile = await h.domain.profiles.profile('AR', 'cr', VIEWER);
    expect(profile.capacityHolders).toEqual(holders);
    expect(profile.capacityUsed).toBe(holders.length);
    // A human member has no places.
    const owner = await h.domain.profiles.profile('AR', 'owner', VIEWER);
    expect(owner.capacityUsed).toBe(0);
    expect(owner).not.toHaveProperty('capacityHolders');
  });
});
