/** PM-322 review images. Run with --machine scripts/fixtures/machine/busy.json (or calm.json). */
const WIDTHS = [1600, 1512, 1440, 1280, 1200, 800, 390];

export default async ({ instance, open, shoot, step, log }) => {
  const members = await instance.api('/api/projects/AC/members');
  const developers = members.filter((member) => member.kind === 'ai').slice(0, 2);
  for (const [index, member] of developers.entries()) {
    const id = await instance.startSession('AC', index === 0 ? 'AC-1' : 'AC-2', member.handle);
    await instance.waitIdle('AC', id);
  }
  const page = await open({ path: '/p/AC', width: 1512 });
  const indicator = () => page.getByRole('button', { name: /Gép: processzor/ });
  const panel = () => page.getByRole('dialog', { name: 'Gép és munkamenetek' });
  await indicator().waitFor();
  await step('top bar at every step', async () => {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(100);
      log(`${width}px: machine indicators visible=${await indicator().count()}`);
    }
    await shoot(page, 'topbar', { widths: WIDTHS });
  });
  await step('desktop and phone panels', async () => {
    for (const width of [1512, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 982 });
      await indicator().click();
      await panel().waitFor();
      await page.getByRole('heading', { name: /Gazdátlan folyamatok/ }).waitFor();
      await shoot(page, 'panel', { widths: [width] });
      await page.keyboard.press('Escape');
    }
  });
  await step('dark panel and confirmations', async () => {
    await page.setViewportSize({ width: 1512, height: 982 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await indicator().click();
    await shoot(page, 'panel-dark', { widths: [1512] });
    await page.emulateMedia({ colorScheme: 'light' });
    const stop = panel()
      .getByRole('button', { name: /^Leállítás:/ })
      .first();
    await stop.click();
    await shoot(page, 'session-confirmation', { widths: [1512] });
    await page.keyboard.press('Escape');
    const all = panel().getByRole('button', { name: 'Mind leállítása' });
    if (await all.count()) {
      await all.click();
      await shoot(page, 'orphans-confirmation', { widths: [1512] });
      await page.keyboard.press('Escape');
    }
    await page.keyboard.press('Escape');
  });
  await step('delayed sample', async () => {
    await page.route('**/api/machine*', async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      data.sampledAt = new Date(Date.now() - data.intervalMs * 4).toISOString();
      await route.fulfill({ response, json: data });
    });
    await page.reload();
    await indicator().click();
    await page.getByText(/A mérés késik/).waitFor();
    await shoot(page, 'delayed', { widths: [1512] });
  });
};
