/**
 * PM-1304 (PM-1290 C1): the card's Comments tab, one column with a one-level reply, an open reply box and the pinned
 * composer, and the Process tab with the earlier conversations block.
 *
 *   npm run shots -- scripts/scenarios/card-comments.mjs
 */
const WIDTHS = [1512, 390];
const COMMENTS = '/api/projects/AC/tasks/AC-1/comments';

export default async ({ instance, open, shoot, step }) => {
  const post = (body) => instance.api(COMMENTS, { method: 'POST', body });
  await post({ text: 'Can we show the basket total in the e-mail too?' });
  const { threads } = await instance.api(COMMENTS);
  const first = threads[0].comment.id;
  await post({ text: 'Yes, @owner, the total is already in the order data.', replyTo: first });
  await post({ text: 'Then I will add it to the template.', replyTo: first });
  await post({
    text: 'Imported from the old tracker: the customer asked for this twice.',
    importedAuthor: 'Morgan Example',
    importedAt: '2024-01-02T03:04:05Z',
  });

  await step('the Comments tab', async () => {
    const page = await open({ path: '/p/AC/tasks/AC-1/thread' });
    await page.getByRole('textbox', { name: /Hozzászólás szövege|Comment text/ }).waitFor();
    await shoot(page, 'comments-tab', { widths: WIDTHS });
    await page.getByRole('button', { name: /^(Válasz|Reply)/ }).first().click();
    await shoot(page, 'comments-reply-box', { widths: WIDTHS });
  });

  await step('the Process tab', async () => {
    const page = await open({ path: '/p/AC/tasks/AC-1/steps' });
    await page.getByRole('heading', { level: 3 }).first().waitFor();
    await shoot(page, 'process-tab', { widths: WIDTHS });
  });
};
