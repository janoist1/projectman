import { afterEach, expect, it } from 'vitest';
import {
  createDomainHarness,
  OWNER_ACTOR,
  type DomainHarness,
} from '../../../../test/helpers/domain-harness';
import { makeRepoless } from '../../../../test/helpers/test-template';
import { aiActor } from '../../../kernel';

let h: DomainHarness;
afterEach(async () => {
  await h?.cleanup();
});

async function setup() {
  h = await createDomainHarness({ adjust: makeRepoless });
  await h.domain.tasks.create('AR', { title: 'A card' }, OWNER_ACTOR);
  await h.domain.tasks.update('AR', 'AR-1', { assignee: 'dev-1', stageId: 'development' }, OWNER_ACTOR);
}
const timeline = () => h.domain.timeline.list('AR', { taskKey: 'AR-1' });

it('records review follow-ups with the result label, actor and session', async () => {
  await setup();
  await h.domain.tasks.update(
    'AR',
    'AR-1',
    {
      addLabels: ['code-review-ok'],
      note: 'Checked',
      followUps: ['Reuse the helper', 'Add a test'],
    },
    aiActor('cr'),
    { sessionId: 'ses_cr' },
  );
  expect(timeline().filter((event) => event.type === 'review_follow_ups')).toMatchObject([
    {
      actor: { handle: 'cr' },
      sessionId: 'ses_cr',
      data: { label: 'code-review-ok', items: ['Reuse the helper', 'Add a test'] },
    },
  ]);
});

it.each(['dev-1', 'dev-2'])('refuses follow-ups from %s without recording any changes', async (handle) => {
  await setup();
  const before = timeline();
  await expect(
    h.domain.tasks.update(
      'AR',
      'AR-1',
      {
        addLabels: ['plain-tag'],
        note: 'Do not record',
        followUps: ['Reuse the helper'],
      },
      aiActor(handle),
    ),
  ).rejects.toMatchObject({ code: 'invalid_request' });
  expect(timeline()).toEqual(before);
  expect(h.domain.tasks.get('AR', 'AR-1').labels).not.toContain('plain-tag');
});

it('refuses follow-ups on a closed card without recording changes', async () => {
  await setup();
  await h.domain.tasks.cancel('AR', 'AR-1', {}, OWNER_ACTOR);
  const before = timeline();
  await expect(
    h.domain.tasks.update(
      'AR',
      'AR-1',
      {
        note: 'Do not record',
        followUps: ['Reuse the helper'],
      },
      aiActor('cr'),
    ),
  ).rejects.toMatchObject({ code: 'task_closed' });
  expect(timeline()).toEqual(before);
});
