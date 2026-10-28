/**
 * Scenario for PM-1079 (docs/SCREENSHOTS.md): the cards of the ready queue that wait for a prerequisite. It shoots,
 * at 1512 and 390 px:
 *
 *   a. the board: startable cards (green stripe, "Indítható") beside cards that wait ("Vár: … (Szakasz)", "+2"), and
 *      the column head's "N indítható" chip
 *   b. the drawer of the card with three prerequisites ("Miért áll?")
 *   c. the board where no card can be started ("nincs indítható")
 *   d. the board with a card a developer works on, which also has an open prerequisite (the meta chip)
 *   e. the same as a., in the dark theme
 *
 *   npm run shots -- scripts/scenarios/ready-startable.mjs [--widths 1512,390]
 */

const WIDTHS = [1512, 390];

export default async ({ instance, open, shoot, step, log }) => {
  const { config } = await instance.api('/api/projects/AC/config');
  const stages = config.pipeline.stages;
  const workIndex = stages.findIndex((stage) => stage.kind === 'work');
  const ready = stages.findLast((stage, index) => index < workIndex && stage.kind === 'queue');
  const review = stages.find((stage, index) => index > workIndex && stage.kind === 'step');
  if (!ready || !review)
    throw new Error('The demo pipeline needs a queue before the work stage and a later step.');
  log(`ready ${ready.id}, work ${stages[workIndex].id}, review ${review.id}`);

  const card = async (title, stageId, prerequisites = []) =>
    (
      await instance.api('/api/projects/AC/tasks', {
        method: 'POST',
        body: {
          title,
          repo: 'webshop',
          description: 'Fictional Acme webshop demo task.',
          labels: [],
          stageId,
          relations: prerequisites.map((key) => ({ kind: 'prerequisite', key })),
        },
      })
    ).key;
  const relate = (key, prerequisites) =>
    instance.api(`/api/projects/AC/tasks/${key}`, {
      method: 'PATCH',
      body: { relations: { add: prerequisites.map((other) => ({ kind: 'prerequisite', key: other })) } },
    });

  // The cards that others wait for: two in the review step, one still in the work stage.
  const first = await card('Add a wish list', review.id);
  const second = await card('Show delivery estimates', review.id);
  const third = await card('Migrate the order history', stages[workIndex].id);
  // The ready queue: two cards a person can start, one that waits for one card, one that waits for three.
  const startable = await card('Add tiered shipping rates', ready.id);
  const startableToo = await card('Print packing slips', ready.id);
  const single = await card('Send an order confirmation', ready.id, [first]);
  const several = await card('Export orders to CSV', ready.id, [first, second, third]);
  log(`cards: ${startable}, ${startableToo} startable; ${single} waits for ${first}; ${several} for three`);

  const board = async (name, colorScheme) => {
    const page = await open({ path: '/p/AC' });
    await page.emulateMedia({ colorScheme });
    await page.getByText(single, { exact: false }).first().waitFor();
    await shoot(page, name, { widths: WIDTHS });
    return page;
  };

  await step('a. the ready queue, mixed', () => board('a-ready-mixed', 'light'));

  await step('b. the card with three prerequisites', async () => {
    const page = await open({ path: `/p/AC/tasks/${several}` });
    await page.getByRole('region', { name: 'Miért áll?' }).waitFor();
    await shoot(page, 'b-drawer-several', { widths: WIDTHS });
  });

  await step('d. a card a developer works on, with an open prerequisite', async () => {
    const developer = (await instance.api('/api/projects/AC/members')).find(
      (member) => member.kind === 'ai' && member.role === 'developer',
    );
    const working = await card('Add a gift wrap option', stages[workIndex].id);
    const sessionId = await instance.startSession('AC', working, developer.handle);
    await instance.waitIdle('AC', sessionId);
    await relate(working, [first]);
    await board('d-working-chip', 'light');
  });

  await step('e. the ready queue, dark theme', () => board('e-ready-dark', 'dark'));

  await step('c. nothing can be started', async () => {
    // The demo's own cards in the queue wait for a card as well.
    const { tasks } = await instance.api('/api/projects/AC/board');
    for (const task of tasks) {
      if (task.stageId === ready.id && !task.links.some((link) => link.kind === 'prerequisite')) {
        await relate(task.key, [first]);
      }
    }
    await board('c-none-startable', 'light');
  });
};
