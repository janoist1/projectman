/**
 * Screenshots for PM-429: the project manager's header button and panel, the leave banner, the
 * phone sheet, and the team page where the project manager cannot be retired.
 */
export default async ({ instance, open, shoot, step, log }) => {
  const members = await instance.api('/api/projects/AC/members');
  const pm = members.find((member) => member.kind === 'ai' && member.role === 'project_manager');
  if (!pm) throw new Error('the demo project has no project manager');
  log(`project manager: ${pm.handle}`);

  const overflow = (page, label) =>
    page.evaluate((name) => {
      const doc = document.documentElement;
      return `${name}: scrollWidth ${doc.scrollWidth} / clientWidth ${doc.clientWidth}`;
    }, label);

  await step('desktop: closed and open', async () => {
    const page = await open({ path: '/p/AC', width: 1512 });
    await page.waitForSelector('[data-pm-button]');
    await shoot(page, 'pm-desktop-closed', { widths: [1512, 1200, 800], highlight: '[data-pm-button]' });
    await page.click('[data-pm-button]');
    await page.waitForSelector('#pm-panel');
    await shoot(page, 'pm-desktop-open', { widths: [1512, 800] });
  });

  await step('desktop: a message and the open card as context', async () => {
    // The card drawer covers the top bar's right end, so the panel is opened first and the card after it.
    const page = await open({ path: '/p/AC', width: 1512 });
    await page.waitForSelector('[data-pm-button]');
    await page.click('[data-pm-button]');
    await page.waitForSelector('#pm-panel textarea');
    await page.getByText('Build the product catalogue').first().click();
    await page.waitForSelector('#pm-panel >> text=AC-1');
    await page.fill('#pm-panel textarea', 'Mi a helyzet ezzel a kártyával?');
    await shoot(page, 'pm-desktop-context', { widths: [1512] });
    await page.press('#pm-panel textarea', 'Enter');
    await page.waitForSelector('#pm-panel [role=log] >> text=Mi a helyzet');
    await shoot(page, 'pm-desktop-sent', { widths: [1512] });
  });

  await step('desktop: the project manager is on leave', async () => {
    await instance.api(`/api/projects/AC/members/${pm.handle}`, { method: 'PATCH', body: { onLeave: true } });
    const page = await open({ path: '/p/AC', width: 1512 });
    await page.waitForSelector('[data-pm-button]');
    await page.click('[data-pm-button]');
    await page.waitForSelector('#pm-panel [role=status]');
    await shoot(page, 'pm-desktop-leave', { widths: [1512] });
    await instance.api(`/api/projects/AC/members/${pm.handle}`, {
      method: 'PATCH',
      body: { onLeave: false },
    });
  });

  await step('phone: header and sheet', async () => {
    const page = await open({ path: '/p/AC', width: 390 });
    await page.waitForSelector('[data-pm-button]');
    log(await overflow(page, '390 closed'));
    await shoot(page, 'pm-phone-closed', { widths: [390, 360] });
    log(await overflow(page, '360 closed'));
    await page.click('[data-pm-button]');
    await page.waitForSelector('#pm-panel');
    await shoot(page, 'pm-phone-open', { widths: [390, 360] });
  });

  await step('team page: the required project manager', async () => {
    const page = await open({ path: '/p/AC/team', width: 1512 });
    await page.waitForSelector(`a[href$="/team/${pm.handle}"]`);
    if (await page.locator('#pm-panel').count()) await page.keyboard.press('Escape');
    await page.getByRole('button', { name: `További műveletek: ${pm.displayName}` }).click();
    // The roster scrolls on its own, so the note under the last items of the menu is brought into view.
    await page.getByText(/egyetlen AI Projektmenedzsere/).scrollIntoViewIfNeeded();
    await shoot(page, 'pm-team-menu', { widths: [1512] });
  });
};
