/**
 * PM-1397 (PM-1378 C): the small-card rule of a step stage. The stage panel in Settings › Path (the block with its
 * summary, the label warning and an invalid pattern), the path overview line, and the card's "Most" box with the
 * reason the stage gave it to its owners, plus the timeline's second line.
 *
 *   npm run shots -- scripts/scenarios/small-cards-owner.mjs --widths 1512,390
 */
const WIDTHS = [1512, 390];

export default async ({ instance, open, shoot, step, log }) => {
  const { config, version } = await instance.api('/api/projects/AC/config');
  const stages = config.pipeline.stages;
  const workIndex = stages.findIndex((stage) => stage.kind === 'work');
  const ready = stages.findLast((stage, index) => index < workIndex && stage.kind === 'queue');
  const work = stages[workIndex];
  const review = stages.find((stage, index) => index > workIndex && stage.kind === 'step');
  if (!ready || !review) throw new Error('The demo pipeline needs a queue, a work stage and a later step.');
  const members = await instance.api('/api/projects/AC/members');
  const ai = members.filter((member) => member.kind === 'ai');
  const small = ai.find((member) => member.role !== 'developer') ?? ai[0];

  await instance.api('/api/projects/AC/config', {
    method: 'PATCH',
    body: {
      baseVersion: version,
      pipeline: {
        ...config.pipeline,
        labels: config.pipeline.labels.map((label) =>
          label.id === 'code-review-ok' ? { ...label, setBy: 'anyone' } : label,
        ),
        stages: stages.map((stage) =>
          stage.id === review.id
            ? {
                ...stage,
                smallCards: { maxPoints: 3, owners: [small.handle], centralPaths: ['packages/shared/**'] },
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

  await step('stage panel with the rule', async () => {
    const page = await open({ path: `/p/AC/settings/pipeline?show=stage:${review.id}` });
    const block = page.getByRole('group', { name: 'Kis kártya', exact: true });
    await block.waitFor();
    await block.scrollIntoViewIfNeeded();
    await shoot(page, 'stage-panel', { widths: WIDTHS, highlight: '[aria-label="Kis kártya"] textarea' });
    // The panel is a different layout per width, so it is opened again at each width before the shot.
    for (const [width, height] of [
      [1512, 982],
      [390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      const details = page.locator('[aria-label="Kis kártya"] details');
      await details.waitFor();
      if (!(await details.evaluate((element) => element.open))) await details.locator('summary').click();
      await shoot(page, 'stage-panel-when-open', {
        widths: [width],
        highlight: '[aria-label="Kis kártya"] details',
      });
    }
  });

  await step('stage panel with an invalid pattern', async () => {
    const page = await open({ path: `/p/AC/settings/pipeline?show=stage:${review.id}` });
    const paths = page.getByRole('group', { name: 'Kis kártya', exact: true }).locator('textarea');
    await paths.waitFor();
    await paths.fill('packages/shared/**\n\n/absolute');
    await page.getByRole('alert').first().waitFor();
    await shoot(page, 'stage-panel-error', {
      widths: WIDTHS,
      highlight: '[aria-label="Kis kártya"] [role="alert"]',
    });
  });

  await step('path overview', async () => {
    const page = await open({ path: '/p/AC/settings/pipeline' });
    await page.getByText('kis kártyák', { exact: false }).first().waitFor();
    await shoot(page, 'path-overview', { widths: WIDTHS });
  });

  for (const [name, key] of [
    ['card-small', sized],
    ['card-unsized', unsized],
  ]) {
    await step(`card ${key}`, async () => {
      const page = await open({ path: `/p/AC/tasks/${key}/steps` });
      await page.getByRole('region').first().waitFor();
      await shoot(page, name, { widths: WIDTHS });
    });
  }
};
