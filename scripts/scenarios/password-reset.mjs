/**
 * PM-946: the password page of a client (set or reset a password with an e-mailed code).
 *
 *   npm run shots -- scripts/scenarios/password-reset.mjs --widths 1512,390
 *
 * The disposable instance has no mailer, so the browser answers the setup status and the two password
 * routes itself (`page.route`, like the operator scenario); the states that need a limit or an outage
 * (429, 503) are staged the same way. The wording comes from hu.ts through Vite.
 */
const ADDRESS = 'kata@client.test';
const CODE = '123456';
const PASSWORD = 'a brand new password';
const WIDTHS = [1512, 390];

export default async ({ instance, open, shoot, step }) => {
  const me = await instance.api('/api/me');
  const state = { mode: 'ok' };
  const json = (route, status, body, headers = {}) =>
    route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
  const failure = (code, message, details) => ({
    error: { code, message, ...(details ? { details } : {}) },
  });

  const page = await open({ path: '/login' });
  const ui = await page.evaluate(async () => (await import('/src/i18n/hu.ts')).hu);
  const text = ui.auth;
  const visit = (path) => page.goto(new URL(path, page.url()).href);
  const shots = (name) => shoot(page, name, { widths: WIDTHS });

  await page.route('**/api/setup', async (route) => {
    const response = await route.fetch();
    json(route, response.status(), { ...(await response.json()), emailLoginEnabled: true });
  });
  await page.route('**/api/auth/password/request', (route) => {
    if (state.mode === 'limited')
      return json(
        route,
        429,
        failure('email_login_rate_limited', 'Too many attempts', { retryAfterSeconds: 42 }),
        { 'retry-after': '42' },
      );
    if (state.mode === 'unavailable')
      return json(route, 503, failure('email_login_unavailable', 'E-mail login is not available'));
    return json(route, 202, { expiresInSeconds: 600, resendAfterSeconds: 60 });
  });
  await page.route('**/api/auth/password/reset', (route) => {
    const body = route.request().postDataJSON();
    if (body.code !== CODE) return json(route, 400, failure('email_code_invalid', 'The code is not valid'));
    return json(route, 200, me);
  });

  const emailField = () => page.getByLabel(text.login.email, { exact: true });
  const codeField = () => page.getByLabel(text.emailLogin.codeLabel, { exact: true });
  const passwordField = () => page.getByLabel(text.passwordReset.newPassword, { exact: true });
  const button = (name) => page.getByRole('button', { name });
  const toCodeStep = async (path = '/login/password') => {
    await visit(path);
    await emailField().fill(ADDRESS);
    await button(text.emailLogin.sendCode).click();
    await codeField().waitFor();
  };
  const submit = async (code, password) => {
    await codeField().fill(code);
    await passwordField().fill(password);
    await button(text.passwordReset.save).click();
  };

  await step('the login page with the link, and its focus ring', async () => {
    await visit('/login');
    const link = page.getByRole('link', { name: text.passwordReset.link });
    await link.waitFor();
    await shots('login-link');
    // A key press first, so the focus ring (focus-visible) shows.
    await page.keyboard.press('Shift');
    await link.focus();
    await shots('login-link-focus');
  });

  await step('the address step: wrong address and filled', async () => {
    await page.getByRole('link', { name: text.passwordReset.link }).click();
    await emailField().fill('kata@');
    await button(text.emailLogin.sendCode).click();
    await page.getByText(text.validation.emailInvalid).first().waitFor();
    await shots('address-invalid');
    await emailField().fill(ADDRESS);
    await shots('address-filled');
  });

  await step('the code step: default, wrong code, short password', async () => {
    await toCodeStep();
    await shots('code-step');
    await submit('000000', PASSWORD);
    await page.getByText(text.emailLogin.codeInvalid).first().waitFor();
    await shots('code-wrong');
    await submit(CODE, 'short');
    await page.getByText(text.validation.passwordShort).first().waitFor();
    await shots('password-short');
  });

  await step('a new code after a wrong one', async () => {
    await toCodeStep();
    await submit('000000', PASSWORD);
    // The server's wait for a new code is a fixed minute: the button shows after it.
    await button(text.emailLogin.resend).waitFor({ timeout: 70_000 });
    await shots('code-wrong-resend');
    await button(text.emailLogin.resend).click();
    await page.getByText(text.emailLogin.resent).first().waitFor();
    await shots('code-resent');
  });

  await step('the limit and the outage on the address step', async () => {
    state.mode = 'limited';
    await visit('/login/password');
    await emailField().fill(ADDRESS);
    await button(text.emailLogin.sendCode).click();
    await page.getByText(text.emailLogin.tooMany).first().waitFor();
    await shots('limited');
    state.mode = 'unavailable';
    await visit('/login/password');
    await emailField().fill(ADDRESS);
    await button(text.emailLogin.sendCode).click();
    await page.getByText(text.emailLogin.unavailable).first().waitFor();
    await shots('unavailable');
    state.mode = 'ok';
  });

  await step('the toast after the login', async () => {
    await toCodeStep('/login/password?next=%2Fp%2FAC');
    await submit(CODE, PASSWORD);
    await page.getByText(text.passwordReset.saved).first().waitFor();
    await shots('saved-toast');
  });
};
