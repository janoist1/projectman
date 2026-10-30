/**
 * The card's Process tab (PM-1160): the "Most" box, the comment box and the story in rounds.
 * The card goes forward, back and forward again, so the story has several rounds with their outcomes,
 * a round the card only passed through and runs of system events.
 *
 *   npm run shots -- scripts/scenarios/card-story.mjs --widths 1512,390
 */
import { hu } from '../../apps/web/src/i18n/hu.ts';

const WIDTHS = [1512, 390];

export default async ({ instance, open, shoot, step, log }) => {
  const { config } = await instance.api('/api/projects/AC/config');
  const stages = config.pipeline.stages;
  const workIndex = stages.findIndex((stage) => stage.kind === 'work');
  const ready = stages.findLast((stage, index) => index < workIndex && stage.kind === 'queue');
  const work = stages[workIndex];
  const review = stages.find((stage, index) => index > workIndex && stage.kind === 'step');
  if (!ready || !review)
    throw new Error('The demo pipeline needs a queue before the work stage and a later step.');
  const developer = (await instance.api('/api/projects/AC/members')).find(
    (member) => member.kind === 'ai' && member.role === 'developer',
  );
  const { key } = await instance.api('/api/projects/AC/tasks', {
    method: 'POST',
    body: { title: 'Add a wish list', repo: 'webshop', stageId: ready.id },
  });
  const move = (stageId) =>
    instance.api(`/api/projects/AC/tasks/${key}`, { method: 'PATCH', body: { stageId } });
  const comment = (text) =>
    instance.api(`/api/projects/AC/tasks/${key}/comments`, { method: 'POST', body: { text } });

  // Round 1 in the work stage, with a session; round 2 in the review step, sent back; round 3 in the work
  // stage again; round 4 in the review step, still running. The ready queue is the first, short round.
  await move(work.id);
  const session = await instance.startSession('AC', key, developer.handle);
  await instance.waitIdle('AC', session);
  await comment('The list needs to survive a reload.');
  await move(review.id);
  await comment('Reload loses the list: please keep it per account.');
  await move(work.id);
  const again = await instance.startSession('AC', key, developer.handle);
  await instance.waitIdle('AC', again);
  await move(review.id);
  log(`${key}: ${ready.id} → ${work.id} → ${review.id} → ${work.id} → ${review.id}`);

  const path = `/p/AC/tasks/${key}/steps`;
  const story = (page) => page.getByRole('heading', { name: new RegExp(`^${hu.task.story.title}`) });
  const setView = (page, view) =>
    page.evaluate((value) => window.localStorage.setItem('pm:cardStory.view', value), view);

  await step('the story in its essence', async () => {
    const page = await open({ path });
    await story(page).waitFor();
    await shoot(page, 'story-essence', { widths: WIDTHS });
  });
  await step('an earlier round opened', async () => {
    const page = await open({ path });
    await story(page).waitFor();
    await page.locator('button[aria-expanded="false"]').first().click();
    await shoot(page, 'story-round-open', { widths: WIDTHS });
  });
  await step('every event, with a noise run opened', async () => {
    const page = await open({ path });
    await setView(page, 'all');
    await page.reload();
    await story(page).waitFor();
    await shoot(page, 'story-all', { widths: WIDTHS });
    await setView(page, 'essence');
    await page.reload();
    await story(page).waitFor();
    const run = page.getByRole('button', { name: /rendszer-esemény/ }).first();
    if (await run.count()) {
      await run.click();
      await shoot(page, 'story-noise-open', { widths: WIDTHS });
    }
  });
  await step('a card that has only just started', async () => {
    const page = await open({ path: '/p/AC/tasks/AC-1/steps' });
    await story(page).waitFor();
    await shoot(page, 'story-new', { widths: WIDTHS });
  });
};
