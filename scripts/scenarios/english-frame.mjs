/**
 * PM-1178: the frame of the UI in English (header, avatar menu with the language switch, keyboard switch,
 * failed save, card with an en-GB date, connection bar, not-found page, invite pages and login).
 *
 *   npm run shots -- scripts/scenarios/english-frame.mjs --widths 1512,390
 *
 * The browser is Hungarian (`hu-HU`) and holds no stored language, so a page before login opens in English;
 * the owner's language is set through the API so the logged-in pages read English too. The pages before
 * login come last: they need the session cookie gone, and the browser context cannot be logged in again.
 */
const WIDTHS = [1512, 390];

export default async ({ instance, open, shoot, step, log }) => {
  await instance.api('/api/auth/language', { method: 'PUT', body: { language: 'en' } });
  const invite = await instance.api('/api/projects/AC/invites', {
    method: 'POST',
    body: { email: 'dana@acme.test', displayName: 'Dana Dev', access: 'developer', roles: [] },
  });

  const page = await open({ path: '/' });
  const language = (value) => page.waitForFunction((lang) => document.documentElement.lang === lang, value);
  const visit = async (path) => {
    await page.goto(new URL(path, page.url()).href);
    await language('en');
  };
  const accountButton = () => page.getByRole('button', { name: /^(Account|Fiók)/ }).first();
  await language('en');

  await step('header and avatar menu', async () => {
    await shoot(page, 'header-en', { widths: WIDTHS });
    // The shot resizes the window, which closes the menu: open it again at each width.
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width > 800 ? 982 : 844 });
      await accountButton().click();
      await page.getByRole('radio', { name: 'English' }).waitFor();
      await shoot(page, `avatar-menu-en-${width}`, { widths: [width] });
      await page.keyboard.press('Escape');
    }
  });

  await step('switch with the keyboard, focus back on the avatar button', async () => {
    await page.setViewportSize({ width: 1512, height: 982 });
    await accountButton().focus();
    await page.keyboard.press('Enter');
    await page.getByRole('radio', { name: 'English' }).focus();
    await page.keyboard.press('ArrowRight');
    await language('hu');
    await shoot(page, 'keyboard-switch-hu', { widths: [1512] });
    await accountButton().focus();
    await page.keyboard.press('Enter');
    await page.getByRole('radio', { name: 'Magyar' }).focus();
    await page.keyboard.press('ArrowLeft');
    await language('en');
    await shoot(page, 'keyboard-switch-en', { widths: [1512] });
  });

  await step('failed save', async () => {
    await page.route('**/api/auth/language', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'internal_error', message: 'Failed' } }),
      }),
    );
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width > 800 ? 982 : 844 });
      await accountButton().click();
      await page.getByRole('radio', { name: 'Magyar' }).click();
      await page.getByText("Couldn't save the language", { exact: false }).waitFor();
      await shoot(page, `save-failed-en-${width}`, { widths: [width] });
      await language('en');
    }
    await page.unroute('**/api/auth/language');
  });

  await step('card with an en-GB date', async () => {
    await visit('/p/AC/tasks/AC-1');
    await shoot(page, 'card-en', { widths: WIDTHS });
  });

  await step('connection bar', async () => {
    try {
      await page.context().setOffline(true);
      await page.evaluate(() => window.dispatchEvent(new Event('offline')));
      await page.waitForTimeout(1500);
      await shoot(page, 'connection-en', { widths: WIDTHS });
    } catch (error) {
      log(`connection bar not captured: ${error.message}`);
    } finally {
      await page.context().setOffline(false);
    }
  });

  await step('error page', async () => {
    await visit('/p/AC/this-page-does-not-exist');
    await shoot(page, 'not-found-en', { widths: WIDTHS });
  });

  await step('pages before sign-in', async () => {
    await page.context().clearCookies();
    await page.evaluate(() => window.localStorage.removeItem('pm:language'));
    await visit(`/invite/${invite.path.split('/').pop()}`);
    await shoot(page, 'invite-en', { widths: WIDTHS });
    await visit('/owner-invite/not-a-real-token');
    await shoot(page, 'owner-invite-en', { widths: WIDTHS });
    await visit('/login');
    await page.waitForSelector('form');
    await shoot(page, 'login-en', { widths: WIDTHS });
    await page.getByRole('radio', { name: 'Magyar' }).click();
    await language('hu');
    await shoot(page, 'login-hu', { widths: WIDTHS });
  });
};
