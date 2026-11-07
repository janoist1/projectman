/**
 * PM-1276: the mention of the owner in "Rád vár": the card with the excerpt and its three actions, the open reply
 * box with a draft, and the Említés filter. A colleague writes the comments; the owner reads them.
 *
 *   npm run shots -- scripts/scenarios/mention-inbox.mjs --widths 1512,375
 */
const WIDTHS = [1512, 375];
const COMMENTS = '/api/projects/AC/tasks/AC-1/comments';

export default async ({ instance, open, shoot, step }) => {
  const owner = (await instance.api('/api/me')).handles.AC;
  const colleague = await instance.invite({
    project: 'AC',
    email: 'mention-inbox@example.test',
    name: 'Dana Dev',
    access: 'developer',
  });
  const post = (body) => instance.api(COMMENTS, { method: 'POST', body, as: colleague });
  await post({ text: `@${owner} can you decide which e-mail template the basket total goes into?` });
  const long =
    `@${owner} I went through the order data again and the total is there, but the tax split is not: ` +
    'the template has no place for it, and the old export wrote it into a note field that the new shop ignores. ' +
    'If we want it in the e-mail we need either a new field or a line in the footer, and I would like your call ' +
    'before I touch the template, because the accountant reads these mails too. ';
  await post({ text: long.repeat(2) });

  await step('the cards in Rád vár', async () => {
    const page = await open({ path: '/p/AC/inbox' });
    await page
      .getByRole('button', { name: /^(Láttam|Seen)$/ })
      .first()
      .waitFor();
    await shoot(page, 'mention-list', { widths: WIDTHS, mask: ['time'] });
  });

  for (const width of WIDTHS) {
    await step(`the reply box at ${width}px`, async () => {
      const page = await open({ path: '/p/AC/inbox' });
      await page.setViewportSize({ width, height: width > 600 ? 982 : 667 });
      await page
        .getByRole('button', { name: /^(Válasz|Reply)$/ })
        .first()
        .click();
      const box = page.getByRole('textbox', { name: /Válasz szövege|Reply text/ });
      await box.fill('Thanks, I will put it in the footer.');
      await page.waitForTimeout(300);
      await shoot(page, `mention-reply-${width}`, { widths: [width], mask: ['time'] });
    });
  }

  await step('the Említés filter', async () => {
    const page = await open({ path: '/p/AC/inbox' });
    await page.getByRole('button', { name: /^(Említés|Mention)/ }).click();
    await shoot(page, 'mention-filter', { widths: [1512], mask: ['time'] });
  });
};
