/**
 * PM-1503: the settings warn that an AI member can release the start condition's hold label.
 *
 * The owner sets a start condition whose hold label anyone (so also an AI member) may set; the settings
 * then show the warning band. Shots: the Classic and the Win 3.11 style, light and dark, at 1512 and 390 px.
 *
 *   npm run shots -- scripts/scenarios/start-condition-ai-hold.mjs --widths 1512,390
 */
export default async ({ instance, open, shoot, step }) => {
  const view = await instance.api('/api/projects/AC/config');
  const hold = view.config.pipeline.labels.find((label) => label.id === 'waiting-answer');
  await instance.api('/api/projects/AC/config', {
    method: 'PATCH',
    body: {
      baseVersion: view.version,
      pipeline: {
        ...view.config.pipeline,
        labels: view.config.pipeline.labels.map((label) =>
          label.id === hold.id ? { ...label, setBy: 'anyone' } : label,
        ),
      },
    },
  });
  const next = await instance.api('/api/projects/AC/config');
  await instance.api('/api/projects/AC/config', {
    method: 'PATCH',
    body: {
      baseVersion: next.version,
      startCondition: { priority: 'any', combine: 'any', graceMinutes: 5, hold: [hold.id] },
    },
  });

  for (const style of ['classic', 'win311'])
    for (const scheme of ['light', 'dark'])
      await step(`${style}, ${scheme}`, async () => {
        const page = await open({ path: '/p/AC/settings/project' });
        await page.emulateMedia({ colorScheme: scheme });
        await page.evaluate((value) => {
          window.localStorage.setItem('pm:ui-style', value);
          document.documentElement.dataset.style = value;
        }, style);
        await page.locator('[role="status"]', { hasText: hold.name }).first().waitFor();
        await shoot(page, `${style}-${scheme}`, {
          widths: [1512, 390],
          highlight: '[role="status"]:has(strong)',
        });
      });
};
