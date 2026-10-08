/** PM-406: the Map overview (menu, group tiles, filters, first use, empty states) in both themes. */
export default async ({ instance, open, shoot, step, log }) => {
  const root = '/api/projects/AC/tasks';
  let page = await open({ path: '/p/AC/map' });
  // Load the actual locale through Vite; UI wording stays in hu.ts.
  const ui = await page.evaluate(async () => (await import('/src/i18n/hu.ts')).hu);

  // The demo seed has four cards and no theme: the first-use state.
  await step('first use', async () => {
    await page.getByText(ui.map.firstUse.body, { exact: false }).first().waitFor();
    await shoot(page, 'map-first-use', { widths: [1512, 390] });
  });

  const create = (body) => instance.api(root, { method: 'POST', body });
  const themes = [];
  for (const title of ['Webshop checkout', 'Search relaunch', 'Mobile app']) {
    themes.push(await create({ kind: 'theme', title }));
  }
  const cards = [];
  for (const [index, theme] of themes.entries()) {
    for (const n of [1, 2, 3, 4].slice(0, index + 2)) {
      cards.push(await create({ title: `${theme.title} step ${n}`, repo: 'webshop', themeKey: theme.key }));
    }
  }
  await create({ title: 'Loose card without a theme', repo: 'webshop' });
  await instance.api(`${root}/${cards[0].key}`, { method: 'PATCH', body: { priority: 'high' } });

  await step('first use and overview', async () => {
    page = await open({ path: '/p/AC/map' });
    await page.getByRole('link', { name: /Webshop checkout/ }).waitFor();
    await shoot(page, 'map-overview', { widths: [1512, 800, 390, 360] });
    await page.emulateMedia({ colorScheme: 'dark' });
    await shoot(page, 'map-overview-dark', { widths: [1512, 390] });
    await page.emulateMedia({ colorScheme: 'light' });
  });

  await step('filters', async () => {
    page = await open({ path: '/p/AC/map?show=needsYou' });
    await page.waitForLoadState('networkidle');
    await shoot(page, 'map-filter-needs-you', { widths: [1512, 390] });
    page = await open({ path: '/p/AC/map?show=blocked' });
    await page.waitForLoadState('networkidle');
    await shoot(page, 'map-filter-blocked', { widths: [1512] });
  });

  await step('keyboard focus', async () => {
    page = await open({ path: '/p/AC/map' });
    await page.getByRole('link', { name: /Webshop checkout/ }).waitFor();
    await page.getByRole('link', { name: /Webshop checkout/ }).focus();
    await shoot(page, 'map-tile-focus', { widths: [1512] });
  });

  await step('error', async () => {
    page = await open({ path: '/p/AC/map' });
    await page.getByRole('link', { name: /Webshop checkout/ }).waitFor();
    // The routes belong to the page: block the board request, then load the page again.
    await page.route('**/api/projects/AC/board**', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'screenshot_failure', message: 'Simulated failure' } }),
      }),
    );
    await page.route('**/api/projects/AC/tasks**', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'screenshot_failure', message: 'Simulated failure' } }),
      }),
    );
    await page.reload();
    await page.getByRole('alert').first().waitFor();
    await shoot(page, 'map-error', { widths: [1512] });
  });
  log('PM-406 map screenshots complete');
};
