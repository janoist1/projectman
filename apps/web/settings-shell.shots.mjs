export default async ({ instance, open, shoot, step, log }) => {
  const saved = await instance.api('/api/projects/AC/config');
  const invalid = structuredClone(saved);
  invalid.config.pipeline.columns.push({ ...invalid.config.pipeline.columns[0] });
  const page = await open({ path: '/p/AC/settings/pipeline', width: 1440 });
  await page.route('**/api/projects/AC/config', (route) => route.fulfill({ json: invalid }));
  await page.reload();
  await page.locator('#settings-pipeline').waitFor();
  await step('desktop pipeline with stored problems and account', async () => {
    await shoot(page, 'pipeline-problems', { widths: [1440] });
    await page.goto(`${instance.webUrl}/p/AC/settings/account`);
    await page.locator('#settings-account').waitFor();
    await shoot(page, 'account', { widths: [1440] });
  });
  await step('tablet list and section', async () => {
    await page.setViewportSize({ width: 820, height: 900 });
    await page.goto(`${instance.webUrl}/p/AC/settings`);
    await page.locator('#settings-nav-pipeline').waitFor();
    await shoot(page, 'list-tablet', { widths: [820] });
    await page.locator('#settings-nav-project').click();
    await page.locator('#settings-project').waitFor();
    await shoot(page, 'section-tablet', { widths: [820] });
  });
  for (const theme of ['light', 'dark']) {
    await step(`phone list and duties in ${theme} theme`, async () => {
      await page.setViewportSize({ width: 360, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      await page.goto(`${instance.webUrl}/p/AC/settings`);
      await page.locator('#settings-nav-pipeline').waitFor();
      await shoot(page, `list-phone-${theme}`, { widths: [360] });
      await page.locator('#settings-nav-duties').click();
      await page.locator('#settings-duties').waitFor();
      await shoot(page, `duties-phone-${theme}`, { widths: [360] });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      if (overflow) throw new Error('The phone page overflows horizontally');
      log(`phone ${theme}: no horizontal page overflow`);
    });
  }
};
