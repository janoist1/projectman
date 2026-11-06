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
  });

  // `shoot` resizes the window: the box is opened at the width it is shot at, so the scroll to it is seen.
  for (const [width, height] of [
    [1512, 982],
    [390, 844],
  ]) {
    await step(`the reply box at ${width}px`, async () => {
      const page = await open({ path: '/p/AC/tasks/AC-1/thread' });
      await page.setViewportSize({ width, height });
      await page.getByRole('textbox', { name: /Hozzászólás szövege|Comment text/ }).waitFor();
      await page
        .getByRole('button', { name: /^(Válasz|Reply)/ })
        .first()
        .click();
      await page.waitForTimeout(300);
      await shoot(page, `comments-reply-box-${width}`, { widths: [width] });
    });
  }

  await step('the frame of a comment a link led to', async () => {
    const page = await open({ path: `/p/AC/tasks/AC-1/thread#timeline-${first}` });
    await page.locator('[class*="flash"]').first().waitFor();
    await shoot(page, 'comments-linked', { widths: [1512] });
  });

  await step('the reply box under an imported comment', async () => {
    const page = await open({ path: '/p/AC/tasks/AC-1/thread' });
    await page.getByRole('textbox', { name: /Hozzászólás szövege|Comment text/ }).waitFor();
    await page
      .getByRole('button', { name: /^(Válasz|Reply)/ })
      .last()
      .click();
    await page.waitForTimeout(300);
    await shoot(page, 'comments-imported-reply', { widths: [1512] });
  });

  // The old `?message=` link at a narrow width: the story above the block grows after the page opens.
  await step('the old message link at 390px', async () => {
    const members = await instance.api('/api/projects/AC/members');
    const ai = members.find((member) => member.kind === 'ai' && member.role !== 'project_manager');
    const owner = (await instance.api('/api/me')).handles.AC;
    const at = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
    const earlier = [
      {
        id: 'msg_demo_1',
        projectKey: 'AC',
        from: owner,
        to: [ai.handle],
        taskKey: 'AC-1',
        body: 'Please check the catalogue images before the release.',
        createdAt: at(300),
        deliveredAt: at(300),
      },
      {
        id: 'msg_demo_2',
        projectKey: 'AC',
        from: ai.handle,
        to: [owner],
        taskKey: 'AC-1',
        body: 'Checked: two images are missing, they are listed in the description.',
        createdAt: at(290),
        deliveredAt: at(290),
      },
    ];
    // The messages arrive at once, late and later still: the message is in the window and framed each time.
    for (const [width, height, delay] of [
      [390, 844, 0],
      [390, 844, 600],
      [390, 844, 1800],
      [1512, 982, 0],
    ]) {
      const page = await open({ path: '/p/AC' });
      await page.setViewportSize({ width, height });
      await page.route(
        (url) => url.searchParams.get('place') === 'card' && url.searchParams.get('taskKey') === 'AC-1',
        async (route) => {
          await new Promise((resolve) => setTimeout(resolve, delay));
          await route.fulfill({ json: { messages: earlier } });
        },
      );
      await page.goto(`${instance.webUrl}/p/AC/tasks/AC-1/thread?message=msg_demo_2`);
      await page.locator('[data-flash]').waitFor();
      await page.waitForTimeout(800);
      const box = await page.locator('[data-flash]').boundingBox();
      console.log(
        `message link at ${width}px (messages after ${delay} ms): top ${Math.round(box.y)}, bottom ${Math.round(box.y + box.height)}, window ${height}`,
      );
      if (delay === 0) await shoot(page, `earlier-linked-${width}`, { widths: [width] });
    }
  });

  await step('the Process tab', async () => {
    const page = await open({ path: '/p/AC/tasks/AC-1/steps' });
    await page.getByRole('heading', { level: 3 }).first().waitFor();
    await shoot(page, 'process-tab', { widths: WIDTHS });
  });
};
