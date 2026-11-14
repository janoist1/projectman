import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperationsReviewFacts, teamRules } from '@projectman/shared';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { makeRepoless } from './helpers/test-template';
import { flush, settle } from './helpers/fakes';

/*
 * PM-1464: the weekly operations review, an informational signal the sweep raises once a week when something
 * moved, with the measures, the settings changes since the last review and the rules with their reasons.
 */
const DAY_MS = 24 * 3_600_000;
const START = new Date('2026-11-02T10:00:00.000Z');

let h: DomainHarness;
let now: Date;
afterEach(async () => {
  vi.restoreAllMocks();
  await h?.cleanup();
});

async function setup() {
  now = new Date(START);
  h = await createDomainHarness({
    now: () => now,
    adjust(config) {
      makeRepoless(config);
      const pm = config.team.members.find((member) => member.handle === 'pm');
      if (pm?.kind === 'ai') pm.onLeave = false;
    },
  });
  // The review is read from the signal; nobody should be woken by the sweeps below.
  vi.spyOn(h.domain.projectManagerSignals, 'deliver').mockResolvedValue();
}

const later = (days: number) => {
  now = new Date(now.getTime() + days * DAY_MS);
};
const sweep = async () => {
  await h.domain.projectManagerSignals.sweep('AR');
  await flush();
};
const reviews = () =>
  h.repos.projectManagerSignals.list('AR').filter((signal) => signal.kind === 'operations_review');
const notice = (id: string) =>
  JSON.parse(h.domain.projectManagerSignals.noticeText('AR', [id]).split('\n').at(-1)!);
const by = { actor: OWNER_ACTOR, author: OWNER };
async function patch(change: object) {
  const loaded = await h.domain.projects.load('AR');
  return h.domain.projects.patch('AR', { baseVersion: loaded.version, ...change }, by);
}

/** A card that closes a second after now. */
async function closeCard(title = 'Finished card') {
  const task = await h.domain.tasks.create(
    'AR',
    { title, stageId: 'release', importedAt: now.toISOString() },
    OWNER_ACTOR,
  );
  now = new Date(now.getTime() + 1000);
  await h.domain.tasks.moveToStage('AR', task.key, 'done', OWNER_ACTOR);
  await flush();
  return task.key;
}

describe('the weekly operations review (PM-1464)', () => {
  it('raises one informational review a week after the project began, when a card closed', async () => {
    await setup();
    const key = await closeCard();
    await sweep();
    expect(reviews()).toEqual([]);
    later(7);
    await sweep();
    await sweep();
    expect(reviews()).toHaveLength(1);
    const [signal] = reviews();
    expect(signal).toMatchObject({ caseKey: 'operations_review:2026-W46', resolvedAt: null });
    const line = notice(signal!.id);
    expect(line).toMatchObject({ kind: 'operations_review', steps_left: 0, next_step_at: null });
    expect(line.facts.measures).toMatchObject({ closedCards: 1 });
    expect(line.facts.measures.medianLeadHours).toBeGreaterThanOrEqual(0);
    expect(key).toMatch(/^AR-/);
  });

  it('raises none in a week without movement, and the next week after one with it', async () => {
    await setup();
    await closeCard();
    later(8);
    await sweep();
    h.domain.projectManagerSignals.markDelivered('AR', 'pm', reviews()[0]!.id, null);
    expect(reviews()).toHaveLength(1);

    later(8);
    await sweep();
    expect(reviews()).toHaveLength(1);

    await closeCard('Second card');
    await sweep();
    expect(reviews()).toHaveLength(2);
    expect(notice(reviews()[1]!.id).facts.measures.closedCards).toBe(1);
  });

  it('raises none while the setting is off', async () => {
    await setup();
    await patch({ operationsReview: 'off' });
    await closeCard();
    later(8);
    await sweep();
    expect(reviews()).toEqual([]);
  });

  it('lists the settings changed since the last review and the rules with their reasons', async () => {
    await setup();
    const loaded = await h.domain.projects.load('AR');
    const rule = teamRules(loaded.config)[0]!.id;
    await closeCard();
    later(2);
    const saved = await patch({
      ruleReasons: { [rule]: 'Because the team asked for it' },
      mergeAfterReview: false,
    });
    later(6);
    await sweep();
    const [signal] = reviews();
    const facts = OperationsReviewFacts.parse(notice(signal!.id).facts);
    // The history stamps the real time, not the test clock, so the harness's own setup versions are listed too.
    expect(facts.settingChanges[0]).toMatchObject({
      version: saved.version,
      areas: ['section team'],
      restores: null,
    });
    expect(facts.rules.find((entry) => entry.id === rule)).toMatchObject({
      reason: 'Because the team asked for it',
    });
    expect(facts.rules.every((entry) => 'reason' in entry)).toBe(true);
  });

  it('resolves on delivery and asks for the conversation refresh of the project manager', async () => {
    await setup();
    h.repos.users.insert({
      id: 'user-1',
      name: OWNER.name,
      email: OWNER.email,
      passwordHash: 'unused-test-hash',
      createdAt: now.toISOString(),
      language: 'hu',
    });
    h.runner.idleOnStart = true;
    const { session } = await h.domain.sessions.ensureSession('AR', 'pm', { type: 'general' });
    await settle();
    await closeCard();
    later(8);
    await sweep();
    const [signal] = reviews();
    h.domain.projectManagerSignals.markDelivered('AR', 'pm', signal!.id, null);
    await vi.waitFor(() =>
      expect(h.repos.sessions.conversationRefresh(session.id)).toMatchObject({
        state: 'note_requested',
        reason: 'review',
      }),
    );
    expect(h.repos.projectManagerSignals.get(signal!.id)).toMatchObject({ state: 'resolved' });
  });
});
