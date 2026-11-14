/** PM-1470: real board, direct priority requests and the shared condition rules. */
export default async ({ instance, open, shoot }) => {
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
    }
  }
  await page.close();
};
