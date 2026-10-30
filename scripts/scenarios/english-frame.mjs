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
    // The first shot can come before the first paint: wait for the app frame.
    await accountButton().waitFor();
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
    // Open the menu from the keyboard and put focus on a radio; the menu may still be closing from the
    // step before, so a vanished menu is opened again.
    const openAndFocus = async (name) => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await page
          .getByRole('radio')
          .first()
          .waitFor({ state: 'hidden', timeout: 2000 })
          .catch(() => {});
        await accountButton().focus();
        await page.keyboard.press('Enter');
        try {
          await page.getByRole('radio', { name }).focus({ timeout: 3000 });
          return;
        } catch {
          await page.keyboard.press('Escape');
        }
      }
      throw new Error(`could not focus the ${name} radio`);
    };
    await openAndFocus('English');
    await page.keyboard.press('ArrowRight');
    await language('hu');
    await shoot(page, 'keyboard-switch-hu', { widths: [1512] });
    await openAndFocus('Magyar');
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
      const toast = page.getByText("Couldn't save the language", { exact: false });
      await toast.first().waitFor();
      await shoot(page, `save-failed-en-${width}`, { widths: [width] });
      await language('en');
      // Let this width's toast go, so the next width shows one toast.
      await toast
        .first()
        .waitFor({ state: 'hidden', timeout: 15000 })
        .catch(() => {});
    }
    await page.unroute('**/api/auth/language');
  });

  await step('card with an en-GB date', async () => {
    await visit('/p/AC/tasks/AC-1');
    // The timeline tab lists the card's events with their dates (en-GB: day first, 24-hour time).
    // The drawer's tabs are a segmented control of plain buttons.
    await page.getByRole('button', { name: /^(Folyamat|Timeline)$/ }).click();
    await page
      .getByText(/\d{2}\/\d{2}\/\d{4}|\b\d{2}:\d{2}\b/)
      .first()
      .waitFor({ timeout: 5000 })
      .catch(() => log('no date or time on the card'));
    await shoot(page, 'card-en', { widths: WIDTHS });
  });

  await step('connection bar', async () => {
    // The bar follows the live (websocket) connection, not the browser's online state: refuse the socket
    // and reload, so the client never connects and shows the bar after its short grace time.
    try {
      // The board, not the card: on a phone the open card covers the bar.
      await visit('/p/AC');
      await page.routeWebSocket('**/ws', (socket) => void socket.close());
      await page.reload();
      await language('en');
      await page
        .getByRole('status')
        .filter({ hasText: /connect/i })
        .first()
        .waitFor({ timeout: 10000 });
      await shoot(page, 'connection-en', { widths: WIDTHS });
    } catch (error) {
      log(`connection bar not captured: ${error.message}`);
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
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
