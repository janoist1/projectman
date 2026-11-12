/**
 * PM-1397 (PM-1378 C): the small-card rule of a step stage. The stage panel in Settings › Path (off, filled in with
 * both warnings, the "when" part, refused saves), the path overview line in Settings and in How we work, the card's
 * "Most" box with the reason the stage gave it to its owners (small, central files, no points) and the timeline's
 * second line.
 *
 *   npm run shots -- scripts/scenarios/small-cards-owner.mjs --widths 1512,390
 */
const WIDTHS = [1512, 390];
const HEIGHTS = { 1512: 982, 390: 844 };
const BLOCK = '[aria-label="Kis kártya"]';

export default async ({ instance, open, shoot, step }) => {
  const { config, version } = await instance.api('/api/projects/AC/config');
  const stages = config.pipeline.stages;
  const workIndex = stages.findIndex((stage) => stage.kind === 'work');
  const ready = stages.findLast((stage, index) => index < workIndex && stage.kind === 'queue');
  const work = stages[workIndex];
  const steps = stages.filter((stage, index) => index > workIndex && stage.kind === 'step');
  const review = steps[0];
  const plain = steps[1];
  if (!ready || !review || !plain)
    throw new Error('The demo pipeline needs a queue, a work stage and two later steps.');
  const members = await instance.api('/api/projects/AC/members');
  const ai = members.filter((member) => member.kind === 'ai');
  const small = ai.find((member) => member.role !== 'developer') ?? ai[0];
  // The second small owner is away; it is not one of the stage's own owners, so the cards stay where they are.
  const away =
    ai.findLast(
      (member) => member.handle !== small.handle && !/review/i.test(`${member.handle} ${member.displayName}`),
    ) ?? ai[1];

  await instance.api('/api/projects/AC/config', {
    method: 'PATCH',
    body: {
      baseVersion: version,
      pipeline: {
        ...config.pipeline,
        stages: stages.map((stage) =>
          stage.id === review.id
            ? {
                ...stage,
                smallCards: {
                  maxPoints: 3,
                  owners: [small.handle, away.handle],
                  centralPaths: ['packages/shared/**', 'apps/server/src/db/**'],
                },
              }
            : stage,
        ),
      },
    },
  });

  const create = async (body) => (await instance.api('/api/projects/AC/tasks', { method: 'POST', body })).key;
  const move = (key, stageId) =>
    instance.api(`/api/projects/AC/tasks/${key}`, { method: 'PATCH', body: { stageId } });
  const sized = await create({
    title: 'Fix the cart badge',
    repo: 'webshop',
    stageId: ready.id,
    complexity: { points: 2, reason: 'A one-line change in one component.' },
  });
  const unsized = await create({ title: 'Rework the checkout', repo: 'webshop', stageId: ready.id });
  for (const key of [sized, unsized]) {
    await move(key, work.id);
    await move(key, review.id);
  }
  // The leave comes after the cards entered, so the small owners were free when the stage picked.
  await instance.api(`/api/projects/AC/members/${away.handle}`, { method: 'PATCH', body: { onLeave: true } });

  /** The same page at each width: the panel is a different layout per width, so each one is set up again. */
  const atWidths = async (name, path, prepare, highlight) => {
    for (const width of WIDTHS) {
      const page = await open({ path });
      await page.setViewportSize({ width, height: HEIGHTS[width] });
      await prepare(page);
      await shoot(page, name, { widths: [width], ...(highlight ? { highlight } : {}) });
    }
  };
  const panelOf = (stage) => `/p/AC/settings/pipeline?show=stage:${stage.id}`;
  const toggle = (page) => page.getByRole('checkbox', { name: 'A kis kártyáknak külön gazdája van' });

  await step('a. the rule is off', () =>
    atWidths(
      'stage-panel-off',
      panelOf(plain),
      async (page) => {
        await toggle(page).waitFor();
      },
      `${BLOCK} label`,
    ),
  );

  await step('b. the rule on, with both warnings and the "when" part', () =>
    atWidths(
      'stage-panel-warnings',
      panelOf(review),
      async (page) => {
        await page.locator(`${BLOCK} ul[class*="warnings"]`).waitFor();
      },
      `${BLOCK} ul[class*="warnings"]`,
    ),
  );
  await step('b2. the "when" part open', () =>
    atWidths(
      'stage-panel-when-open',
      panelOf(review),
      async (page) => {
        const details = page.locator(`${BLOCK} details`);
        await details.waitFor();
        if (!(await details.evaluate((element) => element.open))) await details.locator('summary').click();
      },
      `${BLOCK} details`,
    ),
  );

  await step('c. refused saves: no owner, and an invalid pattern after a blank line', () =>
    atWidths(
      'stage-panel-errors',
      panelOf(plain),
      async (page) => {
        const checkbox = toggle(page);
        await checkbox.waitFor();
        if (!(await checkbox.isChecked())) await checkbox.check();
        await page.locator(`${BLOCK} textarea`).fill('packages/shared/**\n\n/absolute');
        await page.locator(`${BLOCK} [role="alert"]`).first().waitFor();
      },
      `${BLOCK} [role="alert"]`,
    ),
  );
  await step('c2. the invalid pattern, with its line number', () =>
    atWidths(
      'stage-panel-pattern-error',
      panelOf(plain),
      async (page) => {
        const checkbox = toggle(page);
        await checkbox.waitFor();
        if (!(await checkbox.isChecked())) await checkbox.check();
        // A pattern is checked once the rule has an owner, so the owner comes first.
        await page.locator(BLOCK).getByRole('button', { name: 'Tag hozzáadása' }).click();
        const search = page.locator(BLOCK).getByRole('combobox', { name: 'Keresés név vagy szerep szerint' });
        await search.fill(small.displayName);
        await search.press('Enter');
        await page.locator(`${BLOCK} textarea`).fill('packages/shared/**\n\n/absolute');
        await page.locator('[id$="smallPaths-errors"] [role="alert"]').waitFor();
      },
      '[id$="smallPaths-errors"] [role="alert"]',
    ),
  );

  await step('d. the path overview, in Settings and in How we work', async () => {
    await atWidths('path-overview', '/p/AC/settings/pipeline', async (page) => {
      await page.getByText('kis kártyák', { exact: false }).first().waitFor();
    });
    await atWidths(
      'how-we-work',
      '/p/AC/how-we-work',
      async (page) => {
        await page.getByText('kis kártyák', { exact: false }).first().waitFor();
      },
      'text=kis kártyák >> visible=true',
    );
  });

  const card = (name, key) =>
    step(`card ${key}`, () =>
      atWidths(name, `/p/AC/tasks/${key}/steps`, async (page) => {
        await page.getByRole('region').first().waitFor();
      }),
    );
  await card('card-small', sized);
  await card('card-no-points', unsized);

  await step('e. central files as the reason', async () => {
    // The demo has no branch to read files from, so the decision the stage took is injected into the card.
    const page = await open({ path: '/p/AC/settings/pipeline' });
    await page.route(`**/api/projects/AC/tasks/${sized}`, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      const json = await response.json();
      const task = json.task ?? json;
      task.stageOwnerPick = {
        stageId: review.id,
        small: false,
        reason: {
          code: 'central_files',
          files: ['packages/shared/src/index.ts', 'apps/server/src/db/migrations.ts'],
          count: 5,
        },
      };
      return route.fulfill({ response, json });
    });
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: HEIGHTS[width] });
      await page.goto(page.url().replace(/\/settings\/pipeline.*$/, `/tasks/${sized}/steps`));
      await page.getByRole('region').first().waitFor();
      await shoot(page, 'card-central-files', { widths: [width] });
    }
  });

  await step('f. the timeline with the pick line', () =>
    atWidths(
      'timeline-pick',
      `/p/AC/tasks/${sized}/timeline`,
      async (page) => {
        await page.getByRole('region').first().waitFor();
        await page.getByText('Minden', { exact: true }).click();
        await page.locator('[class*="aside"]').first().waitFor();
      },
      '[class*="aside"]',
    ),
  );
};
