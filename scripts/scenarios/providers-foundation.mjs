/** PM-359: provider states, accessible badge and a NanoGPT profile, on desktop and phone. */
export default async ({ instance, open, shoot, step, log }) => {
  const members = await instance.api('/api/projects/AC/members');
  const member = members.find((entry) => entry.kind === 'ai');
  await instance.api(`/api/projects/AC/members/${member.handle}`, {
    method: 'PATCH',
    body: { provider: 'nanogpt', model: 'zai-org/GLM-5.3-Flash-Uncensored', effort: 'medium' },
  });
  const page = await open({ path: '/p/AC/settings' });
  const hu = await page.evaluate(async () => (await import('/src/i18n/hu.ts')).hu);
  let state = 'ready';
  let releaseLoading;
  await page.route('**/api/providers', async (route) => {
    if (state === 'loading')
      await new Promise((resolve) => {
        releaseLoading = resolve;
      });
    if (state === 'error') {
      await route.fulfill({
        status: 503,
        json: { error: { code: 'internal_error', message: 'Provider fixture unavailable' } },
      });
      return;
    }
    const response = await route.fetch();
    const body = await response.json();
    body.providers = body.providers.map((entry) => ({
      ...entry,
      loggedIn: entry.provider !== 'claude' && entry.provider !== 'nanogpt',
      problem:
        entry.provider === 'claude' ? 'not_logged_in' : entry.provider === 'nanogpt' ? 'no_key' : undefined,
    }));
    await route.fulfill({ response, json: body });
  });
  const box = page.locator('section[aria-labelledby="settings-providers"]');
  const boxOptions = {
    widths: [1512, 390],
    fullPage: false,
    highlight: 'section[aria-labelledby="settings-providers"]',
  };
  await step('ready box, with login missing and members', async () => {
    await page.reload();
    await box.getByText(hu.providerSettings.notReady, { exact: true }).waitFor();
    await box.scrollIntoViewIfNeeded();
    await shoot(page, 'providers-ready', boxOptions);
    await page.emulateMedia({ colorScheme: 'dark' });
    await shoot(page, 'providers-dark', boxOptions);
    await page.emulateMedia({ colorScheme: 'light' });
  });
  await step('loading box', async () => {
    state = 'loading';
    await page.reload({ waitUntil: 'domcontentloaded' });
    await box.locator('[aria-busy="true"]').waitFor();
    await box.scrollIntoViewIfNeeded();
    await shoot(page, 'providers-loading', boxOptions);
    state = 'ready';
    releaseLoading();
  });
  await step('failed box and retry focus', async () => {
    state = 'error';
    await page.reload();
    await box.getByText(hu.providerSettings.loadError).waitFor();
    await box.scrollIntoViewIfNeeded();
    await shoot(page, 'providers-error', boxOptions);
    state = 'ready';
    await box.getByRole('button', { name: hu.providerSettings.retry }).click();
    await box.locator('ul[aria-busy="false"]').waitFor();
    log(`retry focus: ${await box.locator('ul').evaluate((element) => element === document.activeElement)}`);
  });
  await step('roster badge tooltip by touch and focus', async () => {
    await page.goto(`${instance.webUrl}/p/AC/team`);
    const badge = page
      .getByRole('group', {
        name: hu.providerSettings.badgeNotReady.replace('{provider}', hu.providers.nanogpt),
      })
      .first();
    await badge.focus();
    await shoot(page, 'team-badge', { widths: [1512], fullPage: false });
    await page.setViewportSize({ width: 390, height: 844 });
    await badge.click();
    await shoot(page, 'team-badge', { widths: [390], fullPage: false });
  });
  await step('NanoGPT profile without a plan meter', async () => {
    await page.goto(`${instance.webUrl}/p/AC/team/${member.handle}`);
    await page.getByText(hu.profile.noPlanUsage.nanogpt).waitFor({ state: 'attached' });
    const summary = page
      .locator('details')
      .filter({ has: page.getByText(hu.profile.settings, { exact: true }) })
      .locator('summary');
    if (!(await summary.evaluate((element) => element.parentElement.open))) await summary.click();
    await shoot(page, 'nanogpt-profile', { widths: [1512, 390] });
  });
};
