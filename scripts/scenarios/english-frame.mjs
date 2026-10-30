/**
 * PM-1178: the frame of the UI in English (header, avatar menu with the language switch, not-found page, login).
 *
 *   npm run shots -- scripts/scenarios/english-frame.mjs --widths 1512,390
 *
 * The browser is Hungarian (`hu-HU`) and holds no stored language, so a page before login opens in English;
 * the owner's language is set through the API so the logged-in pages read English too. The login page
 * comes last: it needs the session cookie gone, and the browser context cannot be logged in again.
 */
const WIDTHS = [1512, 390];

export default async ({ instance, open, shoot, step }) => {
  await instance.api('/api/auth/language', { method: 'PUT', body: { language: 'en' } });

  const page = await open({ path: '/' });
  const visit = async (path) => {
    await page.goto(new URL(path, page.url()).href);
    await page.waitForFunction(() => document.documentElement.lang === 'en');
  };
  await page.waitForFunction(() => document.documentElement.lang === 'en');

  await step('header and avatar menu', async () => {
    await shoot(page, 'header-en', { widths: WIDTHS });
    // The shot resizes the window, which closes the menu: open it again at each width.
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width > 800 ? 982 : 844 });
      await page
        .getByRole('button', { name: /^Account/ })
        .first()
        .click();
      await page.getByRole('radio', { name: 'English' }).waitFor();
      await shoot(page, `avatar-menu-en-${width}`, { widths: [width] });
      await page.keyboard.press('Escape');
    }
  });

  await step('error page', async () => {
    await visit('/p/AC/this-page-does-not-exist');
    await shoot(page, 'not-found-en', { widths: WIDTHS });
  });

  await step('login page before sign-in', async () => {
    await page.context().clearCookies();
    await page.evaluate(() => window.localStorage.removeItem('pm:language'));
    await visit('/login');
    await page.waitForSelector('form');
    await shoot(page, 'login-en', { widths: WIDTHS });
  });
};
