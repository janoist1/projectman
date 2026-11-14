import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectConfig, ReviewFollowUpsFacts } from '@projectman/shared';
import { createDomainHarness, OWNER_ACTOR, waitForSession } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';
import { makeRepoless } from './helpers/test-template';

const AT = '2026-10-14T10:00:00.000Z';

let h: DomainHarness;
let sequence = 0;
afterEach(async () => {
  await h?.cleanup();
});

/** AR-1 stands in the release stage, so that moving it to Done enters only the Done stage. */
async function setup() {
  sequence = 0;
  h = await createDomainHarness({
    adjust(config: ProjectConfig) {
      makeRepoless(config);
      const pm = config.team.members.find((m) => m.handle === 'pm');
      if (pm?.kind === 'ai') pm.onLeave = false;
    },
  });
  await h.domain.tasks.create(
    'AR',
    { title: 'Reviewed card', stageId: 'release', importedAt: AT },
    OWNER_ACTOR,
  );
}
function remark(items: string[], label?: string): string {
  const id = `evt_remark_${++sequence}`;
  h.repos.timeline.insert({
    id,
    projectKey: 'AR',
    taskKey: 'AR-1',
    sessionId: null,
    actor: { kind: 'ai', handle: 'cr' },
    type: 'review_follow_ups',
    data: { items, ...(label ? { label } : {}) },
    createdAt: AT,
  });
  return id;
}
const close = () => h.domain.tasks.moveToStage('AR', 'AR-1', 'done', OWNER_ACTOR);
const cancel = () => h.domain.tasks.cancel('AR', 'AR-1', {}, OWNER_ACTOR);
const reopen = () => h.domain.tasks.reopen('AR', 'AR-1', OWNER_ACTOR);
const signals = () => h.repos.projectManagerSignals.listOfTask('AR', 'AR-1', 'review_follow_ups');

describe('review follow-ups of a closed card (PM-1362)', () => {
  it('raises one signal for the remarks of a card that went to done', async () => {
    await setup();
    const first = remark(['Reuse the helper'], 'code-review-ok');
    const second = remark(['Add a test', 'Rename the flag']);
    await close();
    expect(signals()).toMatchObject([
      {
        caseKey: `review_follow_ups:AR-1:${second}`,
        taskKey: 'AR-1',
        subject: `${first},${second}`,
        state: 'pending',
      },
    ]);
  });

  it('raises no signal for a card without remarks', async () => {
    await setup();
    await close();
    expect(signals()).toEqual([]);
  });

  it('raises the signal for a cancelled card too', async () => {
    await setup();
    const id = remark(['Check the old path']);
    await cancel();
    expect(signals()).toMatchObject([{ subject: id }]);
  });

  it('passes on only the new remarks after a reopen, and nothing when none is new', async () => {
    await setup();
    const old = remark(['Old remark']);
    await cancel();
    await reopen();
    await cancel();
    expect(signals()).toHaveLength(1);
    const fresh = remark(['New remark']);
    await reopen();
    await cancel();
    expect(signals().map((signal) => signal.subject)).toEqual([old, fresh]);
  });

  it('lists the remarks in the facts of the signal text', async () => {
    await setup();
    const id = remark(['Reuse the helper', 'Add a test'], 'code-review-ok');
    await close();
    const signal = signals()[0]!;
    const text = await h.domain.projectManagerSignals.noticeText('AR', [signal.id]);
    const facts = JSON.parse(text.split('\n').at(-1)!).facts as ReviewFollowUpsFacts;
    expect(facts).toMatchObject({ taskKey: 'AR-1', title: 'Reviewed card', status: 'done' });
    expect(facts.items).toEqual([
      { eventId: id, by: 'cr', label: 'code-review-ok', at: AT, text: 'Reuse the helper' },
      { eventId: id, by: 'cr', label: 'code-review-ok', at: AT, text: 'Add a test' },
    ]);
  });

  it('stays for the coordinator alone and stays open until it is dismissed', async () => {
    await setup();
    remark(['Reuse the helper']);
    await close();
    const signal = signals()[0]!;
    await h.domain.projectManagerSignals.sweep('AR');
    await flush();
    const session = await waitForSession(h.domain, { member: 'pm' });
    h.runner.setState(session.id, 'idle');
    await flush();
    const ctx = { projectKey: 'AR', sessionId: session.id, member: 'pm', taskKey: null };
    await expect(
      h.domain.teamTools.sendMessage(ctx, {
        to: ['owner'],
        kind: 'info',
        text: 'Remarks were left.',
        signalIds: [signal.id],
      }),
    ).rejects.toThrow('for you only');
    await h.domain.projectManagerSignals.sweep('AR');
    expect(h.repos.projectManagerSignals.get(signal.id)?.resolvedAt).toBeNull();
    await expect(
      h.domain.teamTools.dismissSignal(ctx, { signalId: signal.id, note: 'Moved to AR-2.' }),
    ).resolves.toEqual({ signalId: signal.id, state: 'dismissed' });
    expect(h.repos.projectManagerSignals.get(signal.id)).toMatchObject({
      state: 'dismissed',
      decisionNote: 'Moved to AR-2.',
    });
  });
});
