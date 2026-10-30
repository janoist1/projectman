import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CreatedInvitation } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { ToastContext } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { MockBackend } from '../../mocks/backend';
import { createMockFetch } from '../../test/mockProject';
import type { MockRequest } from '../../test/mockProject';
import { renderUi } from '../../test/render';
import type { RenderRoute } from '../../test/render';
import { formatCountdown } from './emailLogin';
import { PasswordResetPage } from './PasswordResetPage';

const address = 'kata@client.test';
const newPassword = 'a brand new password';

/** A client with a client seat and an account that has no password, logged out. */
function clientBackend(): MockBackend {
  const backend = new MockBackend();
  backend.emailLogin.enabled = true;
  const created = backend.handle('POST', '/api/projects/AC/invites', {
    email: address,
    displayName: 'Kata',
    access: 'client',
    roles: [],
  }).body as CreatedInvitation;
  const inviteToken = created.path.replace('/invite/', '');
  backend.handle('POST', '/api/auth/email/request', { inviteToken });
  backend.handle('POST', '/api/auth/email/verify', {
    inviteToken,
    code: backend.emailLogin.lastCodeTo(address)!,
  });
  backend.handle('POST', '/api/auth/logout', undefined);
  return backend;
}

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

function renderReset(
  backend: MockBackend,
  route: RenderRoute = { pathname: '/login/password', state: { email: address } },
) {
  const requests: MockRequest[] = [];
  const show = vi.fn();
  setFetchImplementation(createMockFetch(backend, requests));
  renderUi(
    <ToastContext.Provider value={{ show }}>
      <Where />
      <Routes>
        <Route path="/login/password" element={<PasswordResetPage />} />
        <Route path="/login" element={<p>login</p>} />
        <Route path="/" element={<p>home</p>} />
        <Route path="/p/AC" element={<p>board</p>} />
      </Routes>
    </ToastContext.Provider>,
    { route },
  );
  return { requests, show };
}

async function toCodeStep() {
  fireEvent.click(await screen.findByRole('button', { name: t('auth.emailLogin.sendCode') }));
  return screen.findByLabelText(t('auth.emailLogin.codeLabel'));
}

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

describe('PasswordResetPage', () => {
  it('sets the password with the code, logs in, and goes on to a safe next', async () => {
    const backend = clientBackend();
    const { requests, show } = renderReset(backend, '/login/password?next=%2Fp%2FAC');
    fireEvent.change(await screen.findByLabelText(t('auth.login.email')), { target: { value: address } });
    const codeInput = await toCodeStep();
    expect(screen.getByText(address)).toBeTruthy();
    const code = backend.emailLogin.lastCodeTo(address)!;
    fireEvent.change(codeInput, { target: { value: code } });
    fireEvent.change(screen.getByLabelText(t('auth.passwordReset.newPassword')), {
      target: { value: newPassword },
    });
    fireEvent.click(screen.getByRole('button', { name: t('auth.passwordReset.save') }));
    await screen.findByText('board');
    expect(requests.find((request) => request.path.endsWith('/password/reset'))?.body).toEqual({
      email: address,
      code,
      password: newPassword,
    });
    expect(show).toHaveBeenCalledWith(t('auth.passwordReset.saved'), 'ok');
    expect(backend.auth).toBe('ready');
    expect(backend.handle('POST', '/api/auth/login', { email: address, password: newPassword }).status).toBe(
      200,
    );
  });

  it('takes the address from the login page and sends no request until asked', async () => {
    const backend = clientBackend();
    const { requests } = renderReset(backend);
    expect(((await screen.findByLabelText(t('auth.login.email'))) as HTMLInputElement).value).toBe(address);
    expect(requests.some((request) => request.path.includes('/password/'))).toBe(false);
  });

  it('moves on to the code step for an address with no client account, as it does for a client', async () => {
    const backend = clientBackend();
    renderReset(backend, { pathname: '/login/password', state: { email: 'nobody@client.test' } });
    expect(await toCodeStep()).toBeTruthy();
    expect(backend.emailLogin.outbox.filter((mail) => mail.purpose === 'password')).toHaveLength(0);
  });

  it('refuses a short password without a request, and keeps the code', async () => {
    const backend = clientBackend();
    const { requests } = renderReset(backend);
    const codeInput = await toCodeStep();
    fireEvent.change(codeInput, { target: { value: backend.emailLogin.lastCodeTo(address)! } });
    fireEvent.change(screen.getByLabelText(t('auth.passwordReset.newPassword')), {
      target: { value: 'short' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('auth.passwordReset.save') }));
    expect(await screen.findByText(t('auth.validation.passwordShort'))).toBeTruthy();
    expect(requests.some((request) => request.path.endsWith('/password/reset'))).toBe(false);
  });

  it('keeps the password after a wrong code and puts the focus back on the code', async () => {
    const backend = clientBackend();
    renderReset(backend);
    const codeInput = await toCodeStep();
    fireEvent.change(codeInput, { target: { value: '000000' } });
    const password = screen.getByLabelText(t('auth.passwordReset.newPassword')) as HTMLInputElement;
    fireEvent.change(password, { target: { value: newPassword } });
    fireEvent.click(screen.getByRole('button', { name: t('auth.passwordReset.save') }));
    expect(await screen.findByText(t('auth.emailLogin.codeInvalid'))).toBeTruthy();
    expect(password.value).toBe(newPassword);
    await waitFor(() => expect(document.activeElement).toBe(codeInput));
  });

  it('shows the wait of a rate limit on the button of the step that was limited', async () => {
    const backend = clientBackend();
    backend.emailLogin.rateLimitedFor = 42;
    renderReset(backend);
    fireEvent.click(await screen.findByRole('button', { name: t('auth.emailLogin.sendCode') }));
    expect(await screen.findByText(t('auth.emailLogin.tooMany'))).toBeTruthy();
    const wait = screen.getByRole('button', {
      name: t('auth.emailLogin.sendCodeWait', { time: formatCountdown(42) }),
    });
    expect((wait as HTMLButtonElement).disabled).toBe(true);
  });

  it('goes back to the login page when the server has no e-mail codes', async () => {
    const backend = clientBackend();
    backend.emailLogin.enabled = false;
    renderReset(backend);
    await screen.findByText('login');
  });
});
