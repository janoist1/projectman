/**
 * Screenshots for PM-1100 (docs/SCREENSHOTS.md): Settings → Team → "Új kártya nyitása", the lowest human
 * access that may open a new card, and the client's board when clients may.
 *
 *   a. owner, the default (developer chosen), the group at the top of the Team section  1512
 *   b. owner, the client option chosen through the UI (with the first-stage note)      390
 *   c. admin, read only, with the "only the owner" line                                  1512
 *   d. client, the board with the new card button (client setting)                      390
 *   e. client, read only settings with the client value                                  390
 *   f. owner, a refused save (the error banner, the choice back on the saved value)      1512
 *
 *   npm run shots -- scripts/scenarios/task-create-access.mjs --widths 1512,390
 */

export default async ({ instance, open, shoot, step }) => {
  const setAccess = async (taskCreateAccess) => {
    const { version } = await instance.api('/api/projects/AC/config');
    await instance.api('/api/projects/AC/config', {
      method: 'PATCH',
      body: { baseVersion: version, taskCreateAccess },
    });
  };
  // Load the actual locale through Vite; UI wording stays in hu.ts.
  const first = await open({});
  const ui = await first.evaluate(async () => (await import('/src/i18n/hu.ts')).hu);
  const copy = ui.settings.team.taskCreate;
  const group = async (page) => {
    await page.waitForSelector('#settings-task-create-title');
    await page.evaluate(() => document.getElementById('settings-task-create-title')?.scrollIntoView());
  };

  const admin = await instance.invite({
    project: 'AC',
    email: 'ada-admin@example.test',
    name: 'Ada Admin',
    access: 'admin',
  });
  const client = await instance.invite({
    project: 'AC',
    email: 'cili-client@example.test',
    name: 'Cili Megrendelő',
    access: 'client',
  });

  await step('a: owner, the default', async () => {
    const page = await open({ path: '/p/AC/settings/team' });
    await group(page);
    await shoot(page, 'a-owner-default', { widths: [1512], highlight: '#settings-task-create-title' });
  });

  await step('b: owner chooses the client option', async () => {
    const page = await open({ path: '/p/AC/settings/team' });
    await group(page);
    await page.getByRole('radio', { name: new RegExp(copy.options.client) }).check();
    await page.waitForFunction(
      () => !document.querySelector('fieldset[aria-busy="true"]'),
    );
    await shoot(page, 'b-owner-client', { widths: [390], highlight: '#settings-task-create-title' });
  });

  await step('c: admin, read only', async () => {
    await setAccess('developer');
    const page = await open({ as: admin, path: '/p/AC/settings/team' });
    await group(page);
    await shoot(page, 'c-admin-read-only', { widths: [1512], highlight: '#settings-task-create-title' });
  });

  await step('d: client, the board with the new card button', async () => {
    await setAccess('client');
    const page = await open({ as: client, path: '/p/AC' });
    await page.getByRole('button', { name: ui.topbar.newTask }).first().waitFor();
    await shoot(page, 'd-client-board', { widths: [390] });
  });

  await step('e: client, read only settings with the client value', async () => {
    const page = await open({ as: client, path: '/p/AC/settings/team' });
    await group(page);
    await shoot(page, 'e-client-read-only', { widths: [390], highlight: '#settings-task-create-title' });
  });

  await step('f: owner, a refused save', async () => {
    await setAccess('developer');
    const page = await open({ path: '/p/AC/settings/team' });
    await page.route('**/api/projects/AC/config', async (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      await route.fulfill({
        status: 403,
        json: { error: { code: 'owner_only', message: 'only an owner may change who may open new cards' } },
      });
    });
    await group(page);
    await page.getByRole('radio', { name: new RegExp(copy.options.admin) }).check();
    await page.getByRole('region', { name: copy.title }).getByRole('alert').first().waitFor();
    await shoot(page, 'f-owner-error', { widths: [1512], highlight: '#settings-task-create-title' });
  });
};
