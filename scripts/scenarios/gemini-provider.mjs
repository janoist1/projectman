/** PM-327: provider states, accessible badge and a Gemini profile, on desktop and phone. */
export default async ({ instance, open, shoot, step, log }) => {
  const members = await instance.api('/api/projects/AC/members');
  const member = members.find((entry) => entry.kind === 'ai');
  await instance.api(`/api/projects/AC/members/${member.handle}`, {
    method: 'PATCH',
    body: { provider: 'gemini', model: 'gemini-3.8-flash', effort: 'medium' },
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
      loggedIn: entry.provider !== 'claude' && entry.provider !== 'gemini',
      problem:
        entry.provider === 'claude'
          ? 'not_logged_in'
          : entry.provider === 'gemini'
            ? 'not_logged_in'
            : undefined,
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
    await box.getByText('agy', { exact: true }).waitFor();
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
    await page.setViewportSize({ width: 1512, height: 982 });
    await page.goto(`${instance.webUrl}/p/AC/team`);
    const badge = page
      .getByRole('group', {
        name: hu.providerSettings.badgeNotReady.replace('{provider}', hu.providers.gemini),
      })
      .first();
    await badge.focus();
    await shoot(page, 'team-badge', { widths: [1512], fullPage: false });
    await page.setViewportSize({ width: 390, height: 844 });
    await badge.click();
    await shoot(page, 'team-badge', { widths: [390], fullPage: false });
  });
  await step('hire Gemini without login', async () => {
    await page.goto(`${instance.webUrl}/p/AC/team`);
    await page.getByRole('button', { name: hu.team.hire }).click();
    await page.getByLabel(hu.providerSettings.provider, { exact: true }).selectOption('gemini');
    await page.getByRole('alert').getByText('agy', { exact: true }).waitFor();
    await shoot(page, 'gemini-hire', { widths: [1512, 390], fullPage: false });
    await page.getByRole('alert').scrollIntoViewIfNeeded();
    await shoot(page, 'gemini-hire-warning', { widths: [390], fullPage: false });
    await page.getByLabel(hu.hire.model, { exact: true }).selectOption('gemini-3.1-pro');
    await page.getByText(hu.providerSettings.geminiProEffortHint, { exact: true }).scrollIntoViewIfNeeded();
    await shoot(page, 'gemini-pro-effort', { widths: [1512, 390], fullPage: false });
    await page.getByText(hu.hire.details, { exact: true }).click();
    await page
      .getByText(hu.permissionControls.providerNotes.gemini.auto, { exact: true })
      .scrollIntoViewIfNeeded();
    await shoot(page, 'gemini-hire-mode', { widths: [1512, 390], fullPage: false });
    await page.getByRole('button', { name: hu.common.cancel, exact: true }).click();
  });
  await step('Gemini profile without a plan meter', async () => {
    await page.goto(`${instance.webUrl}/p/AC/team/${member.handle}`);
    await page.getByText(hu.profile.noPlanUsage.gemini).waitFor({ state: 'attached' });
    const summary = page
      .locator('details')
      .filter({ has: page.getByText(hu.profile.settings, { exact: true }) })
      .locator('summary');
    if (!(await summary.evaluate((element) => element.parentElement.open))) await summary.click();
    await shoot(page, 'gemini-profile', { widths: [1512, 390], fullPage: true });
  });
};
