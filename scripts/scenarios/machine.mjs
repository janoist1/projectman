/** PM-322 review images. Run with --machine scripts/fixtures/machine/busy.json (or calm.json). */
const WIDTHS = [1600, 1512, 1440, 1280, 1200, 800, 390];

export default async ({ instance, open, shoot, step, log }) => {
  const members = await instance.api('/api/projects/AC/members');
  const developers = members
    .filter((member) => member.kind === 'ai' && member.role === 'developer')
    .slice(0, 2);
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
    await page.setViewportSize({ width: 1600, height: 900 });
    const search = page.getByRole('search');
    const original = await search.evaluate((element) => {
      const name = element.parentElement.firstElementChild.querySelector('button > span:nth-child(2)');
      const value = name.textContent;
      name.textContent = Array(6).fill(value).join(' ');
      return value;
    });
    for (const width of [1600, 1512, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(100);
      const fits = await search.evaluate((element) => {
        const header = element.parentElement;
        const boxes = [...header.children]
          .map((child) => child.getBoundingClientRect())
          .filter((box) => box.width > 0);
        return (
          element.getBoundingClientRect().width >= 139.5 &&
          boxes.every((box, index) => index === 0 || box.left >= boxes[index - 1].right - 0.5) &&
          boxes.at(-1).right <= header.getBoundingClientRect().right
        );
      });
      if (!fits) throw new Error(`Top bar overlaps with the maximum project name at ${width}px.`);
    }
    await shoot(page, 'topbar-long-name', { widths: [1600, 1512, 1280] });
    await search.evaluate((element, value) => {
      element.parentElement.firstElementChild.querySelector('button > span:nth-child(2)').textContent = value;
    }, original);
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
      await page.keyboard.press('Escape');
      // The supplied busy fixture has two orphans; add a third only for the requested bulk-confirmation image.
      const threeOrphans = async (route) => {
        const response = await route.fetch();
        const data = await response.json();
        if (data.orphans?.length === 2)
          data.orphans.push({
            ...data.orphans[0],
            pid: data.orphans[0].pid + 10000,
            name: 'vitest',
            command: 'vitest run',
          });
        await route.fulfill({ response, json: data });
      };
      await page.route('**/api/machine*', threeOrphans);
      await page.reload();
      await indicator().click();
      await panel()
        .getByRole('heading', { name: /Gazdátlan folyamatok.*3/ })
        .waitFor();
      await all.click();
      await shoot(page, 'orphans-confirmation', { widths: [1512] });
      await page.keyboard.press('Escape');
      await page.unroute('**/api/machine*', threeOrphans);
    }
    await page.keyboard.press('Escape');
  });
  await step('orphan refusal and failure', async () => {
    await page.route('**/api/machine/orphans/stop', async (route) => {
      const { orphans } = route.request().postDataJSON();
      await route.fulfill({
        json: {
          results: orphans.map((row, index) => ({ ...row, outcome: index === 0 ? 'refused' : 'failed' })),
        },
      });
    });
    await indicator().click();
    const all = panel().getByRole('button', { name: 'Mind leállítása' });
    if (await all.count()) {
      await all.click();
      await panel().getByRole('button', { name: 'Mind leállítása' }).last().click();
      await panel().getByText('Ezt a folyamatot már nem lehet innen leállítani.').waitFor();
      await panel().getByText('Nem sikerült leállítani. Próbáld újra.').waitFor();
      await shoot(page, 'orphan-outcomes', { widths: [1512] });
    }
    await page.keyboard.press('Escape');
    await page.unroute('**/api/machine/orphans/stop');
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
