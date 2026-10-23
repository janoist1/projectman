import { hu } from '../../apps/web/src/i18n/hu.ts';

/** PM-974: the single-page starter form, provider states and validation at desktop and phone widths. */
export default async ({ open, shoot, step }) => {
  const page = await open({ path: '/projects/new' });
  const text = hu.projects.create;
  const widths = [1512, 390];
  let readyProviders = ['claude'];
  let failed = false;
  let pending;
  const view = () => ({
    providers: ['claude', 'codex', 'gemini', 'nanogpt'].map((provider) => ({
      provider,
      loggedIn: readyProviders.includes(provider),
      method: null,
      checkedAt: '2026-10-23T08:42:00.000Z',
      ...(!readyProviders.includes(provider)
        ? { problem: provider === 'nanogpt' ? 'no_key' : 'not_logged_in' }
        : {}),
    })),
    keys: { nanogpt: { set: readyProviders.includes('nanogpt'), setAt: null } },
    canManageKeys: true,
  });
  await page.route('**/api/providers', async (route) => {
    if (pending) await pending;
    await route.fulfill({
      status: failed ? 503 : 200,
      json: failed ? { error: { code: 'internal_error', message: 'Unavailable' } } : view(),
    });
  });
  const reload = async () => {
    await page.reload();
    await page.locator('fieldset[aria-busy="false"]').waitFor();
  };
  const shootProviders = async (name) => {
    for (const width of widths) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 982 });
      await page
        .locator('#providers-title')
        .evaluate((element) => element.scrollIntoView({ block: 'start' }));
      await shoot(page, name, { widths: [width] });
    }
  };
  await step('a. Claude ready', async () => {
    await reload();
    await shoot(page, 'a-claude', { widths });
    await shootProviders('a-providers');
  });
  await step('b. no provider ready', async () => {
    readyProviders = [];
    await reload();
    await shootProviders('b-none-ready');
  });
  await step('c. Codex ready by default', async () => {
    readyProviders = ['codex'];
    await reload();
    if (!(await page.getByRole('radio', { name: 'Codex', exact: true }).isChecked()))
      throw new Error('Expected Codex default');
    await shootProviders('c-codex');
  });
  await step('d. NanoGPT key and saved state', async () => {
    await page.getByRole('radio', { name: 'NanoGPT', exact: true }).check();
    await shootProviders('d1-nanogpt-missing');
    await page.getByRole('button', { name: hu.nanogptKey.add, exact: true }).click();
    await shoot(page, 'd2-key-dialog', { widths });
    await page.route('**/api/providers/nanogpt/key', async (route) => {
      readyProviders.push('nanogpt');
      await route.fulfill({ json: view() });
    });
    await page.getByLabel(hu.nanogptKey.field, { exact: true }).fill('disposable-test-key');
    await page.getByRole('button', { name: hu.nanogptKey.save, exact: true }).click();
    await page.getByText(hu.providerSettings.nanogptSet, { exact: true }).waitFor();
    await shootProviders('d3-key-saved');
  });
  await step('e. first check pending', async () => {
    let release;
    pending = new Promise((resolve) => {
      release = resolve;
    });
    await page.reload();
    await page.locator('fieldset[aria-busy="true"]').waitFor();
    await shootProviders('e-pending');
    release();
    pending = undefined;
    await page.locator('fieldset[aria-busy="false"]').waitFor();
  });
  await step('f. provider query failed', async () => {
    failed = true;
    await reload();
    await shootProviders('f-query-error');
  });
  await step('g. validation errors', async () => {
    failed = false;
    await reload();
    await page.getByRole('button', { name: text.submit, exact: true }).click();
    await page.getByText(hu.projects.validation.nameRequired, { exact: true }).waitFor();
    await shoot(page, 'g-validation', { widths });
  });
  await step('h. workspace not found', async () => {
    await page.getByLabel(text.name, { exact: true }).fill('Sample project');
    await page.getByLabel(text.workspace, { exact: true }).fill('/work/missing');
    await page.route('**/api/projects', async (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({
            status: 400,
            json: { error: { code: 'workspace_not_found', message: 'Missing directory' } },
          })
        : route.fallback(),
    );
    await page.getByRole('button', { name: text.submit, exact: true }).click();
    await page.getByText(hu.errors.codes.workspace_not_found, { exact: true }).waitFor();
    await shoot(page, 'h-workspace', { widths });
  });
};
