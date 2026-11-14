import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectManagerAgreementData } from '@projectman/shared';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { makeRepoless } from './helpers/test-template';
import { flush } from './helpers/fakes';

let h: DomainHarness;
let now: Date;
afterEach(async () => {
  vi.restoreAllMocks();
  await h?.cleanup();
});

async function setup(involvement?: ProjectManagerAgreementData['involvement']) {
  now = new Date('2026-11-14T10:00:00.000Z');
  h = await createDomainHarness({
    now: () => now,
    adjust(config) {
      makeRepoless(config);
      const pm = config.team.members.find((member) => member.handle === 'pm');
      if (pm?.kind === 'ai') pm.onLeave = false;
    },
  });
  // Hold delivery so independently committed closures can join the queued notice.
  vi.spyOn(h.domain.projectManagerSignals, 'deliver').mockResolvedValue();
  if (involvement) {
    const store = h.domain.projectManagerKnowledge;
    const doc = await store.readKnowledge('AR');
    await store.compareAndSwapKnowledge('AR', doc.revision, {
      ...doc,
      revision: doc.revision + 1,
      agreement: {
        version: 1,
        approvedBy: 'owner',
        approvedAt: now.toISOString(),
        data: { summary: 'Working agreement', involvement, extraCritical: [] },
      },
    });
  }
}

const signals = () =>
  h.repos.projectManagerSignals.list('AR').filter((signal) => signal.kind === 'cards_closed');
const facts = (id: string) =>
  JSON.parse(h.domain.projectManagerSignals.noticeText('AR', [id]).split('\n').at(-1)!).facts as {
    key: string;
    title: string;
  }[];
async function closeCard(title = 'Finished card') {
  const task = await h.domain.tasks.create(
    'AR',
    { title, stageId: 'release', importedAt: now.toISOString() },
    OWNER_ACTOR,
  );
  now = new Date(now.getTime() + 1000);
  const read = vi.spyOn(h.domain.projectManagerKnowledge, 'readKnowledge');
  await h.domain.tasks.moveToStage('AR', task.key, 'done', OWNER_ACTOR);
  await Promise.all(read.mock.results.map((result) => result.value));
  await flush();
  return task.key;
}

describe('card closure notices', () => {
  it('coalesces closures into one pending notice at every_step', async () => {
    await setup('every_step');
    const first = await closeCard('First card');
    await vi.waitFor(() => expect(signals()).toHaveLength(1));
    const second = await closeCard('Second card');
    expect(h.domain.projectManagerSignals.deliver).toHaveBeenCalled();
    expect(signals()).toMatchObject([{ caseKey: 'cards_closed', resolvedAt: null }]);
    expect(facts(signals()[0]!.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: first, title: 'First card' }),
        expect.objectContaining({ key: second, title: 'Second card' }),
      ]),
    );
  });

  it.each(['important', 'minimal', undefined] as const)(
    'raises no closure notice at %s',
    async (involvement) => {
      await setup(involvement);
      await closeCard();
      expect(signals()).toEqual([]);
    },
  );

  it('releases the case on delivery and reports only the next batch of closures', async () => {
    await setup('every_step');
    const first = await closeCard('First batch');
    const previous = signals()[0]!;
    const notice = JSON.parse(
      h.domain.projectManagerSignals.noticeText('AR', [previous.id]).split('\n').at(-1)!,
    );
    expect(notice).toMatchObject({ step: null, steps_left: 0, next_step_at: null });
    expect(notice.facts).toEqual([expect.objectContaining({ key: first })]);
    now = new Date(now.getTime() + 1000);
    h.domain.projectManagerSignals.markDelivered('AR', 'pm', previous.id, null);
    expect(h.repos.projectManagerSignals.get(previous.id)).toMatchObject({
      state: 'resolved',
      deliveredAt: now.toISOString(),
      resolvedAt: now.toISOString(),
    });
    const second = await closeCard('Second batch');
    expect(signals()).toHaveLength(2);
    const current = signals()[1]!;
    expect(current.resolvedAt).toBeNull();
    expect(facts(current.id)).toEqual([expect.objectContaining({ key: second })]);
  });

  it('limits the notice to twenty completed cards and excludes cancellations', async () => {
    await setup('every_step');
    for (let index = 0; index < 22; index++) await closeCard(`Card ${index}`);
    const cancelled = await h.domain.tasks.create('AR', { title: 'Cancelled' }, OWNER_ACTOR);
    await h.domain.tasks.cancel('AR', cancelled.key, {}, OWNER_ACTOR);
    const cards = facts(signals()[0]!.id);
    expect(cards).toHaveLength(20);
    expect(cards.map((card) => card.key)).not.toContain(cancelled.key);
  });
});
