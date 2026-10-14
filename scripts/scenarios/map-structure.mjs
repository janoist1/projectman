/** PM-685: landscape, selections, phone sheet, empty/error/loading states and keyboard focus. */
export default async ({ instance, open, shoot, step, log }) => {
  const tasks = await instance.api('/api/projects/AC/tasks');
  const taskKeys = tasks
    .filter((t) => t.kind !== 'theme')
    .slice(0, 3)
    .map((t) => t.key);
  const area = (id, name, summary) => ({ id, name, summary });
  const module = (id, area, kind, name, summary) => ({
    id,
    area,
    kind,
    name,
    summary,
    paths: kind === 'external' ? [] : [`src/${id}/`],
  });
  const card = (taskKey, source, modules) => ({
    taskKey,
    source,
    commit: 'fixture',
    files: 12,
    modules: modules.map((id, i) => ({ id, files: 6 - i })),
    unmapped: ['README.md'],
    truncated: false,
  });
  const repo = {
    repo: 'webshop',
    status: 'ok',
    problem: null,
    reason: null,
    commit: 'fixture',
    readAt: '2026-10-14T12:00:00Z',
    truncated: false,
    map: {
      version: 1,
      ignore: [],
      areas: [
        area('experience', 'Vásárlói élmény', 'A vásárlás látható részei.'),
        area('engine', 'Működés', 'A rendelések és az adatok kezelése.'),
        area('partners', 'Partnerek', 'Külső szolgáltatások.'),
      ],
      modules: [
        module('shop', 'experience', 'module', 'Webáruház', 'A termékek és a kosár felülete.'),
        module('checkout', 'experience', 'module', 'Pénztár', 'A vásárlás befejezése.'),
        module('orders', 'engine', 'core', 'Rendelések', 'A rendelés életútját vezérli.'),
        module('database', 'engine', 'store', 'Adattár', 'A rendelések tartós tárolása.'),
        module('payment', 'partners', 'external', 'Fizetési szolgáltató', 'A bankkártyás fizetést végzi.'),
      ],
      links: [
        { from: 'shop', to: 'orders', label: 'rendelést indít' },
        { from: 'checkout', to: 'orders', label: 'véglegesít' },
        { from: 'orders', to: 'database', label: 'eltárol' },
        { from: 'orders', to: 'payment', label: 'fizetést kér' },
      ],
    },
    sizes: [
      { id: 'shop', files: 210 },
      { id: 'checkout', files: 32 },
      { id: 'orders', files: 126 },
      { id: 'database', files: 6 },
    ],
    cards: [
      card(taskKeys[0], 'branch', ['shop', 'orders']),
      card(taskKeys[1], 'review', ['orders']),
      card(taskKeys[2], 'merge', ['database']),
    ],
    unmapped: { count: 3, examples: ['README.md', 'scripts/check.ts', 'package.json'] },
  };
  let response = {
    repos: [
      repo,
      {
        ...repo,
        repo: 'mobile',
        status: 'missing',
        map: null,
        cards: [],
        sizes: [],
        unmapped: { count: 0, examples: [] },
      },
    ],
  };
  const page = await open({ path: '/p/AC/map', width: 1512 });
  await page.route('**/api/projects/AC/structure', (route) => route.fulfill({ json: response }));
  // Resolve from the page's URL rather than assuming the disposable instance's port.
  const origin = new URL(page.url()).origin;
  const show = async (query = '') => {
    await page.goto(`${origin}/p/AC/map${query}`);
    await page.locator('[aria-busy="false"]').first().waitFor();
  };
  await step('Landscape and keyboard focus', async () => {
    await show();
    await page.locator('[data-module="orders"]').waitFor();
    await shoot(page, '01-landscape', { widths: [1512, 390] });
    await page.setViewportSize({ width: 1512, height: 982 });
    const plot = page.locator('[data-module="orders"]');
    await plot.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('complementary').getByRole('heading', { name: 'Rendelések', exact: true }).waitFor();
    await shoot(page, '03-module', { widths: [1512] });
    await page.keyboard.press('Escape');
    if (!(await plot.evaluate((el) => document.activeElement === el)))
      throw new Error('Escape did not restore the initiating plot focus');
    log('Keyboard Enter and Escape restore plot focus.');
  });
  await step('Card, completed work and outside files', async () => {
    await show(`?card=${taskKeys[0]}`);
    await shoot(page, '02-card', { widths: [1512] });
    await show('?cards=all');
    await shoot(page, '04-completed', { widths: [1512] });
    response.repos[0].truncated = true;
    await show('?outside=1');
    await shoot(page, '08-outside-truncated', { widths: [1512] });
    response.repos[0].truncated = false;
  });
  await step('Phone module sheet', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await show('?module=orders');
    await page.getByRole('dialog').waitFor();
    await shoot(page, '05-phone-sheet', { widths: [390] });
    await page.keyboard.press('Escape');
    if (await page.getByRole('dialog').count()) throw new Error('Escape did not close phone sheet');
  });
  await step('Missing repositories', async () => {
    await show('?repo=mobile');
    await shoot(page, '06-missing-two-repos', { widths: [1512] });
    response = { repos: [response.repos[1]] };
    await show();
    await shoot(page, '06-missing-phone', { widths: [390] });
  });
  await step('Invalid and offline', async () => {
    response = {
      repos: [
        {
          ...repo,
          status: 'invalid',
          map: null,
          problem: 'modules[2].area: Unknown area\nCheck the descriptor on the default branch.',
        },
      ],
    };
    await show();
    await shoot(page, '07-invalid', { widths: [1512] });
    response = { repos: [{ ...repo, status: 'unavailable', map: null, reason: 'engine_offline' }] };
    await show();
    await shoot(page, '07-offline', { widths: [390] });
  });
  await step('Loading skeleton', async () => {
    await page.unroute('**/api/projects/AC/structure');
    // Holding the request keeps the initial skeleton visible; a screenshot does not need its result.
    await page.route('**/api/projects/AC/structure', () => {});
    await page.goto(`${origin}/p/AC/map`, { waitUntil: 'domcontentloaded' });
    await page.locator('main[aria-busy="true"]').waitFor();
    await shoot(page, '09-loading', { widths: [1512] });
  });
};
