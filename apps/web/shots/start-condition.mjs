/** PM-1470: real board, direct priority requests and the shared condition rules. */
export default async ({ instance, open, shoot, log }) => {
  const { version } = await instance.api('/api/projects/AC/config');
  await instance.api('/api/projects/AC/config', {
    method: 'PATCH',
    body: {
      baseVersion: version,
      startCondition: { priority: 'any', hold: ['waiting-answer'], graceMinutes: 5 },
    },
  });
  const create = (body) => instance.api('/api/projects/AC/tasks', { method: 'POST', body });
  const theme = await create({ kind: 'theme', title: 'Webshop improvements' });
  const inherited = await create({ title: 'Improve the checkout', themeKey: theme.key });
  const idea = await create({ title: 'Weekly order summary' });
  const held = await create({ title: 'Discuss the new catalogue', themeKey: theme.key });
  await instance.api(`/api/projects/AC/tasks/${held.key}`, {
    method: 'PATCH',
    body: { labels: ['waiting-answer'] },
  });
  const page = await open({ path: '/p/AC' });
  await page.getByRole('region', { name: 'Indító feltétel szerinti szűrés' }).waitFor();
  const tile = page.getByRole('button', { name: /Webshop improvements/ }).locator('..');
  await tile.getByRole('button', { name: 'Magas', exact: true }).click();
  await page.locator(`[data-card-key="${inherited.key}"]`).getByText('→ Mehet').waitFor();
  log(`start marks: ${JSON.stringify(await instance.api('/api/projects/AC/start-condition-marks'))}`);
  for (const style of ['classic', 'win311']) {
    await instance.api('/api/me/ui-style', { method: 'PUT', body: { style } });
    for (const scheme of ['light', 'dark']) {
      await page.goto(`${instance.webUrl}/p/AC`);
      await page.emulateMedia({ colorScheme: scheme });
      await page.locator(`[data-card-key="${inherited.key}"]`).getByText('→ Mehet').waitFor();
      await shoot(page, `start-${style}-${scheme}-board`, { widths: [1512, 390] });
      await page.getByRole('button', { name: /^Ötletek \(/ }).click();
      await page.locator(`[data-card-key="${idea.key}"]`).waitFor();
      await shoot(page, `start-${style}-${scheme}-ideas`, { widths: [1512, 390] });
      await page.getByRole('button', { name: /^Mehet \(/ }).click();
      await page.locator(`[data-card-key="${inherited.key}"]`).getByText('→ Mehet').waitFor();
      await shoot(page, `start-${style}-${scheme}-inherited-grace`, {
        widths: [1512, 390],
        highlight: `[data-card-key="${inherited.key}"]`,
      });
    }
  }
  // A failed real mutation shows the local retry control without changing the saved value.
  await page.getByRole('button', { name: /^Ötletek \(/ }).click();
  const card = page.locator(`[data-card-key="${idea.key}"]`);
  await card.scrollIntoViewIfNeeded();
  await page.route(`**/api/projects/AC/tasks/${idea.key}`, (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    return route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'unexpected_failure', message: 'Fixture failure' } }),
    });
  });
  await card.getByRole('button', { name: 'Magas', exact: true }).click();
  const retry = card.getByRole('button', { name: 'Újra', exact: true });
  await retry.waitFor();
  const box = await retry.boundingBox();
  if (!box || box.height < 44) throw new Error('Retry target is smaller than 44px');
  const summary = page.locator('summary').filter({ hasText: 'Mit jelent a Mehet?' });
  const summaryBox = await summary.boundingBox();
  if (!summaryBox || summaryBox.height < 44) throw new Error('Explanation target is smaller than 44px');
  await shoot(page, 'start-mobile-save-error', {
    widths: [390],
    highlight: `[data-card-key="${idea.key}"] [role="alert"]`,
  });
  await page.close();
};
