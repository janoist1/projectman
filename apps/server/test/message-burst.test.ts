import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InboxItem } from '@projectman/shared';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

/** The message storm warning of a card (PM-186): its count, window and one alert per storm. */

const MINUTE = 60_000;

describe('message storm warning', () => {
  let h: DomainHarness;
  let now: Date;

  beforeEach(async () => {
    now = new Date('2026-10-01T12:00:00.000Z');
    h = await createDomainHarness({ now: () => now });
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    await h.domain.tasks.create('AR', { title: 'Other card' }, OWNER_ACTOR);
  });
  afterEach(async () => {
    await h.domain.stop();
    await h.cleanup();
  });

  const setBurst = (burst: { count: number; minutes: number } | null) =>
    h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (config) => {
      if (burst === null) delete config.team.limits.messageBurst;
      else config.team.limits.messageBurst = burst;
      return 'Set the message storm threshold';
    });
  const alerts = (): InboxItem[] => h.domain.inbox.list('AR', { kind: 'alert', taskKey: 'AR-1' });
  const note = (taskKey = 'AR-1') => h.domain.tasks.addNote('AR', taskKey, 'Update', OWNER_ACTOR);
  const notes = async (n: number, everyMs = 0, taskKey = 'AR-1') => {
    for (let i = 0; i < n; i++) {
      await note(taskKey);
      now = new Date(now.getTime() + everyMs);
    }
  };
  const seen = () =>
    h.domain.inbox.resolve('AR', alerts()[0]!.id, { optionId: 'seen' }, { handle: 'owner', access: 'owner' });

  it('raises one alert for the tenth entry within fifteen minutes, and none for the eleventh', async () => {
    await notes(9, MINUTE);
    expect(alerts()).toEqual([]);
    await note();
    const [item, ...more] = alerts();
    expect(more).toEqual([]);
    expect(item).toMatchObject({
      kind: 'alert',
      state: 'open',
      assignees: ['owner'],
      taskKey: 'AR-1',
      payload: { alert: 'message_burst', taskKey: 'AR-1', count: 10, minutes: 15, members: ['owner'] },
      options: [{ id: 'seen', label: 'seen', style: 'primary' }],
    });
    await note();
    await note();
    expect(alerts()).toHaveLength(1);
  });

  it('does not count entries older than the window, or those on other cards', async () => {
    await notes(9, 2 * MINUTE);
    await notes(9, 0, 'AR-2');
    expect(alerts()).toEqual([]);
    expect(h.domain.inbox.list('AR', { kind: 'alert' })).toEqual([]);
  });

  it('counts team messages with notes, and names who wrote and who was written to', async () => {
    await notes(8);
    await h.domain.messaging.send('AR', 'owner', { to: ['cr'], text: 'Please look.', taskKey: 'AR-1' });
    expect(alerts()).toEqual([]);
    await h.domain.messaging.send('AR', 'owner', { to: ['cr', 'dev-1'], text: 'And you.', taskKey: 'AR-1' });
    expect(alerts()[0]!.payload).toMatchObject({ count: 10, members: ['owner', 'cr', 'dev-1'] });
  });

  it('does not count imported comments', async () => {
    for (let i = 0; i < 12; i++)
      await h.domain.tasks.addNote('AR', 'AR-1', 'Old', OWNER_ACTOR, null, { importedAuthor: 'Ann' });
    expect(alerts()).toEqual([]);
  });

  it('takes the threshold from the configuration', async () => {
    await setBurst({ count: 3, minutes: 5 });
    await notes(2, MINUTE);
    expect(alerts()).toEqual([]);
    await note();
    expect(alerts()[0]!.payload).toMatchObject({ count: 3, minutes: 5 });

    // A narrower window: the same pace stays under it.
    await seen();
    await setBurst({ count: 3, minutes: 1 });
    now = new Date(now.getTime() + 10 * MINUTE);
    await notes(4, 2 * MINUTE);
    expect(alerts()).toHaveLength(1);
  });

  it('does not arm again for the same storm after the alert was closed', async () => {
    await notes(10);
    await seen();
    expect(alerts()[0]).toMatchObject({ state: 'resolved' });
    now = new Date(now.getTime() + 5 * MINUTE);
    await notes(10);
    expect(alerts()).toHaveLength(1);
  });

  it('arms again once a whole window has passed since the last alert', async () => {
    await notes(10);
    await seen();
    now = new Date(now.getTime() + 15 * MINUTE + 1);
    await notes(9);
    expect(alerts()).toHaveLength(1);
    await note();
    expect(alerts()).toHaveLength(2);
    expect(alerts()[1]).toMatchObject({ state: 'open', payload: { count: 10 } });
  });

  it('stays quiet for a storm that goes on after "Láttam", and speaks again after a quiet window', async () => {
    // One note a minute: the tenth raises the alert.
    await notes(10, MINUTE);
    expect(alerts()).toHaveLength(1);
    await seen();
    // The owner saw it; the storm goes on for another hour.
    await notes(60, MINUTE);
    expect(alerts()).toHaveLength(1);

    // It stops, and a new one after twenty quiet minutes is told again.
    now = new Date(now.getTime() + 20 * MINUTE);
    await notes(9, MINUTE);
    expect(alerts()).toHaveLength(1);
    await note();
    expect(alerts()).toHaveLength(2);
    expect(alerts()[1]).toMatchObject({ state: 'open', payload: { count: 10 } });
  });

  it('is not raised twice for one card while the alert is open, even after the window', async () => {
    await notes(10);
    now = new Date(now.getTime() + 60 * MINUTE);
    await notes(10);
    expect(alerts()).toHaveLength(1);
  });
});
