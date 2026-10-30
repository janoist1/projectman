/**
 * The card's Process tab (PM-1160): the "Most" box, the comment box and the story in rounds, in both
 * views of the story.
 *
 *   npm run shots -- scripts/scenarios/card-story.mjs --widths 1512,390
 */
import { hu } from '../../apps/web/src/i18n/hu.ts';

export default async ({ open, shoot, step }) => {
  await step('the story in its essence', async () => {
    const page = await open({ path: '/p/AC/tasks/AC-1/steps' });
    await page.getByRole('heading', { name: new RegExp(`^${hu.task.story.title}`) }).waitFor();
    await shoot(page, 'story-essence', { widths: [1512, 390] });
  });
  await step('every event of the story', async () => {
    const page = await open({ path: '/p/AC/tasks/AC-1/steps' });
    // The view is remembered in the browser; a card this young has no switch yet, so set it directly.
    await page.evaluate(() => window.localStorage.setItem('pm:cardStory.view', 'all'));
    await page.reload();
    await page.getByRole('heading', { name: new RegExp(`^${hu.task.story.title}`) }).waitFor();
    await shoot(page, 'story-all', { widths: [1512, 390] });
  });
};
