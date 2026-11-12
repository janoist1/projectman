/**
 * PM-1387 (L-06): the process labels on the cards. A card in progress shows every label; a done card folds its process
 * labels into a "+n" chip and keeps its area labels, and its drawer opens them with a button. The demo has no done
 * card, so the board and the card answers are changed in the browser (as `english-board-card.mjs` does). It shoots,
 * at 1512 and 390 px:
 *
 *   a. the board with a done card (area label + "+n") beside a card in progress
 *   b. the drawer of the done card, folded
 *   c. the same drawer with the process labels opened
 *
 *   npm run shots -- scripts/scenarios/process-labels-fold.mjs [--widths 1512,390]
 */
const WIDTHS = [1512, 390];

export default async ({ instance, open, shoot, step, log }) => {
  const { config } = await instance.api('/api/projects/AC/config');
  const done = config.pipeline.stages.find((stage) => stage.kind === 'done');
  if (!done) throw new Error('The demo pipeline needs a done stage.');
  const process = (config.pipeline.labels ?? []).slice(0, 5).map((label) => label.id);
  const { tasks } = await instance.api('/api/projects/AC/board');
  const [closed, active] = tasks.filter((task) => task.status === 'active').slice(0, 2);
  if (!closed || !active) throw new Error('The demo board needs two cards.');
  log(`done card ${closed.key}, active card ${active.key}, process labels ${process.join(', ')}`);

  const patch = (task) => {
    if (task.key === closed.key)
      return { ...task, stageId: done.id, status: 'done', labels: ['checkout', ...process] };
    if (task.key === active.key) return { ...task, labels: ['checkout', ...process.slice(0, 2)] };
    return task;
  };
  const page = await open({ path: '/p/AC' });
  await page.route('**/api/projects/AC/board', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.tasks = body.tasks.map(patch);
    await route.fulfill({ response, json: body });
  });
  await page.route(`**/api/projects/AC/tasks/${closed.key}`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.task = patch(body.task);
    await route.fulfill({ response, json: body });
  });

  await step('the board', async () => {
    await page.goto(new URL('/p/AC', page.url()).toString());
    await page.locator('[data-label="checkout"]').first().waitFor();
    await shoot(page, 'process-labels-board', { widths: WIDTHS });
  });

  await step('the drawer, folded and opened', async () => {
    await page.goto(new URL(`/p/AC/tasks/${closed.key}`, page.url()).toString());
    const toggle = page.getByRole('button', { name: /folyamatcímke|process label/ });
    await toggle.waitFor();
    await shoot(page, 'process-labels-drawer-folded', { widths: WIDTHS });
    await toggle.click();
    await page.waitForTimeout(200);
    await shoot(page, 'process-labels-drawer-open', { widths: WIDTHS });
  });
};
