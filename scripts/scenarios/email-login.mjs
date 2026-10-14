/**
 * PM-671: the client login with an e-mail code and the invitation accepted with a code.
 *
 * The disposable instance has no mailer, so the browser is given the server's side of the contract of PM-670
 * (`page.route`): the setup status says the login is on, a code request is always 202, and the check answers
 * what each image needs. The pages themselves are the real ones. The page is logged out by dropping the
 * cookie. Images, in the order of the designer's list:
 *   1 address step (1512, 390)        2 code step with the countdown (390)    3 wrong code, new-code button (390)
 *   4 "new code sent" bar (390)       5 name step (390)                       6 rate limit (1512)
 *   7 password mode (1512)            8 invitation: new (390), existing (1512)  9 feature off (1512)
 */
const json = (route, status, body) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const failure = (code, message, details) => ({
  error: { code, message, ...(details === undefined ? {} : { details }) },
});

const INVITE_TOKEN = 'demo-invite-token';
const invitation = (requiresLogin) => ({
  projectKey: 'AC',
  projectName: 'Acme webshop',
  inviterName: 'Te',
  displayName: requiresLogin ? 'Kata' : 'Kata Kovács',
  access: 'client',
  roles: [],
  roleNames: [],
  expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
  requiresLogin,
  emailHint: 'k***@c***.test',
});

export default async ({ open, shoot, step, log }) => {
  /** The server's side of the e-mail login, as far as the image needs it. */
  const serverSide = async (page, behaviour = {}) => {
    const requests = [];
    await page.route(
      (url) => url.pathname === '/api/setup',
      (route) => json(route, 200, { needsSetup: false, emailLoginEnabled: true }),
    );
    await page.route(
      (url) => url.pathname === '/api/auth/email/request',
      (route) => {
        requests.push('request');
        if (behaviour.rateLimited)
          return json(
            route,
            429,
            failure('email_login_rate_limited', 'Too many attempts', { retryAfterSeconds: 42 }),
          );
        return json(route, 202, { expiresInSeconds: 600, resendAfterSeconds: 60 });
      },
    );
    await page.route(
      (url) => url.pathname === '/api/auth/email/verify',
      (route) => {
        if (behaviour.nameRequired && !route.request().postDataJSON().name)
          return json(route, 400, failure('email_login_name_required', 'A name is needed'));
        return json(route, 400, failure('email_code_invalid', 'The code is not valid'));
      },
    );
    await page.route(
      (url) => url.pathname === `/api/invites/${INVITE_TOKEN}`,
      (route) => json(route, 200, invitation(behaviour.existingClient === true)),
    );
    return requests;
  };

  /** A logged-out page: the instance is the owner's, so the cookie goes and the page loads again. */
  const loggedOut = async (path, width, behaviour) => {
    const page = await open({ path, width });
    await page.context().clearCookies();
    if (behaviour) await serverSide(page, behaviour);
    await page.reload();
    return page;
  };

  const focused = (page) =>
    page.evaluate(() => {
      const el = document.activeElement;
      return el
        ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''} ${el.getAttribute('autocomplete') ?? ''}`
        : 'none';
    });
  const overflows = (page) =>
    page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

  const sendAddress = async (page, address = 'kata@client.test') => {
    await page.getByLabel('E-mail cím').fill(address);
    await page.getByRole('button', { name: 'Kód küldése' }).click();
  };

  await step('1: address step', async () => {
    const page = await loggedOut('/login', 1512, {});
    await page.getByRole('button', { name: 'Kód küldése' }).waitFor();
    log(`focus: ${await focused(page)}`);
    await shoot(page, 'email-login-1-address', { widths: [1512, 390] });
    log(`overflow at 390: ${await overflows(page)}`);
  });

  await step('2: code step with the countdown', async () => {
    const page = await loggedOut('/login', 390, {});
    await sendAddress(page);
    await page.getByLabel('Belépőkód').waitFor();
    log(`focus: ${await focused(page)}`);
    await shoot(page, 'email-login-2-code', { widths: [390] });
  });

  await step('3: wrong code, then the new-code button', async () => {
    const page = await open({ path: '/login', width: 390 });
    await page.clock.install();
    await page.context().clearCookies();
    await serverSide(page, {});
    await page.reload();
    await sendAddress(page);
    await page.getByLabel('Belépőkód').fill('000000');
    await page.getByRole('button', { name: 'Belépés', exact: true }).click();
    await page.getByText('Ez a kód nem jó').waitFor();
    log(`focus after a wrong code: ${await focused(page)}`);
    await page.clock.fastForward(61_000);
    await page.getByRole('button', { name: 'Új kód küldése' }).waitFor();
    await shoot(page, 'email-login-3-wrong-code', { widths: [390] });

    await page.getByRole('button', { name: 'Új kód küldése' }).click();
    await page.getByText('Új kódot küldtünk').first().waitFor();
    await shoot(page, 'email-login-4-new-code-sent', { widths: [390] });
  });

  await step('5: name step', async () => {
    const page = await loggedOut('/login', 390, { nameRequired: true });
    await sendAddress(page);
    await page.getByLabel('Belépőkód').fill('123456');
    await page.getByRole('button', { name: 'Belépés', exact: true }).click();
    await page.getByLabel('Neved').waitFor();
    log(`focus: ${await focused(page)}`);
    await shoot(page, 'email-login-5-name', { widths: [390] });
  });

  await step('6: rate limit', async () => {
    const page = await loggedOut('/login', 1512, { rateLimited: true });
    await sendAddress(page);
    await page.getByRole('button', { name: /Kód küldése \(/ }).waitFor();
    await shoot(page, 'email-login-6-rate-limit', { widths: [1512] });
  });

  await step('7: password mode', async () => {
    const page = await loggedOut('/login', 1512, {});
    await page.getByLabel('E-mail cím').fill('kata@client.test');
    await page.getByRole('button', { name: 'Belépés jelszóval' }).click();
    await page.getByLabel('Jelszó', { exact: true }).waitFor();
    log(`focus: ${await focused(page)}`);
    await shoot(page, 'email-login-7-password', { widths: [1512] });
  });

  await step('8: invitation, new client and existing client', async () => {
    const fresh = await loggedOut(`/invite/${INVITE_TOKEN}`, 390, {});
    await fresh.getByRole('button', { name: 'Kód küldése' }).waitFor();
    log(`focus: ${await focused(fresh)}`);
    await shoot(fresh, 'email-login-8-invite-new', { widths: [390] });
    log(`overflow at 390: ${await overflows(fresh)}`);

    const existing = await loggedOut(`/invite/${INVITE_TOKEN}`, 1512, { existingClient: true });
    await existing.getByRole('link', { name: 'Belépés jelszóval' }).waitFor();
    await shoot(existing, 'email-login-8-invite-existing', { widths: [1512] });
  });

  await step('9: the feature off', async () => {
    const page = await loggedOut('/login', 1512);
    await page.getByLabel('Jelszó', { exact: true }).waitFor();
    log(
      `e-mail code button present: ${(await page.getByRole('button', { name: 'Kód küldése' }).count()) > 0}`,
    );
    await shoot(page, 'email-login-9-feature-off', { widths: [1512] });
  });
};
