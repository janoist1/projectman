/**
 * The PM-270 browser probe: what the single-process Chromium does in a sandbox. Run it where the
 * browser is installed (docs/SCREENSHOTS.md, "The probe") and put the output on the card:
 *
 *   npm run shots -- scripts/scenarios/probe.mjs
 *
 * It tries a second account (the one browser context logs in again), a popup (`window.open`), the
 * four widths and a full-page image. A second browser context is not tried: the single-process
 * Chromium crashes on it (the first probe, PM-270).
 */
export default async ({ instance, open, shoot, step, log }) => {
  const colleague = await instance.invite({
    project: 'AC',
    email: 'dana@acme.test',
    name: 'Dana Dev',
    access: 'developer',
  });

  await step('two accounts, one after the other', async () => {
    const owner = await open({ path: '/p/AC' });
    await shoot(owner, 'probe-owner', { widths: [1512] });
    const other = await open({ as: colleague, path: '/p/AC' });
    await shoot(other, 'probe-colleague', { widths: [1512] });
    const again = await open({ path: '/p/AC' });
    await shoot(again, 'probe-owner-again', { widths: [390] });
    log('two accounts: ok');
  });

  await step('a popup', async () => {
    const page = await open({ path: '/p/AC' });
    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      page.evaluate(() => window.open('/p/AC/team')),
    ]);
    await popup.waitForLoadState();
    await shoot(popup, 'probe-popup', { widths: [800] });
    log('popup: ok');
  });

  await step('four widths and a full page', async () => {
    const page = await open({ path: '/p/AC' });
    await shoot(page, 'probe-widths');
    await shoot(page, 'probe-full', { widths: [1512], fullPage: true });
    log('widths and full page: ok');
  });
};
