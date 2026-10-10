/** PM-474: the stage chip yields space to the drawer's actions at desktop and phone widths. */
const WIDTHS = [1512, 390];

export default async ({ instance, open, shoot, step, log }) => {
  const { config, version } = await instance.api('/api/projects/AC/config');
  const review = config.pipeline.stages.find((stage) => stage.kind === 'step');
  if (!review) throw new Error('The demo pipeline has no review step.');
  const column = config.pipeline.columns.find((entry) => entry.id === review.columnId);
  if (!column) throw new Error('The review step has no column.');
  const columnName = `${column.name} — Extended review phase`;
  const stepName = `${review.name} — Detailed implementation and acceptance review`;
  await instance.api('/api/projects/AC/config', {
    method: 'PATCH',
    body: {
      baseVersion: version,
      pipeline: {
        ...config.pipeline,
        columns: config.pipeline.columns.map((entry) =>
          entry.id === column.id ? { ...entry, name: columnName } : entry,
        ),
        stages: config.pipeline.stages.map((entry) =>
          entry.id === review.id ? { ...entry, name: stepName, gate: undefined } : entry,
        ),
      },
    },
  });
  const { key } = await instance.api('/api/projects/AC/tasks', {
    method: 'POST',
    body: { title: 'Review the checkout implementation', repo: 'webshop' },
  });
  await instance.api(`/api/projects/AC/tasks/${key}`, {
    method: 'PATCH',
    body: { stageId: review.id },
  });
  const index = config.pipeline.stages.findIndex((entry) => entry.id === review.id) + 1;
  const label = `${columnName} · ${stepName} · ${index}/${config.pipeline.stages.length}`;
  const page = await open({ path: `/p/AC/tasks/${key}` });
  await page.getByTitle(label, { exact: true }).waitFor();

  for (const width of WIDTHS) {
    await step(`verify and capture the toolbar at ${width}px`, async () => {
      await page.setViewportSize({ width, height: width === 1512 ? 982 : 844 });
      await page.evaluate(() => document.fonts.ready);
      const layout = await page.getByTitle(label, { exact: true }).evaluate((chip) => {
        const row = chip.parentElement;
        const bounds = row.getBoundingClientRect();
        const items = [...row.children].map((item) => {
          const box = item.getBoundingClientRect();
          return { left: box.left, right: box.right, center: box.top + box.height / 2 };
        });
        const text = chip.firstElementChild;
        return {
          name: chip.getAttribute('aria-label'),
          title: chip.title,
          ellipsis: getComputedStyle(text).textOverflow,
          truncated: text.scrollWidth > text.clientWidth,
          sameRow: items.every((item) => Math.abs(item.center - items[0].center) < 1),
          contained: items.every((item) => item.left >= bounds.left && item.right <= bounds.right + 1),
          closeAtEnd: row.lastElementChild.querySelector('svg') !== null,
        };
      });
      if (
        layout.name !== label ||
        layout.title !== label ||
        layout.ellipsis !== 'ellipsis' ||
        !layout.truncated ||
        !layout.sameRow ||
        !layout.contained ||
        !layout.closeAtEnd
      ) {
        throw new Error(`Toolbar regression: ${JSON.stringify(layout)}`);
      }
      log(`${width}px: ${JSON.stringify(layout)}`);
      await shoot(page, 'long-stage-toolbar', { widths: [width] });
    });
  }
};
