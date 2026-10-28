import { fireEvent, screen } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { MockBackend } from '../../mocks/backend';
import { createMockFetch } from '../../test/mockProject';
import { renderUi } from '../../test/render';
import { LoginPage } from './LoginPage';

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

function renderLogin(backend: MockBackend, route = '/login') {
  setFetchImplementation(createMockFetch(backend, []));
  renderUi(
    <>
      <Where />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/invite/:token" element={<p>invite</p>} />
        <Route path="/" element={<p>home</p>} />
      </Routes>
    </>,
    { route },
  );
}

async function submitPassword(backend: MockBackend, password = 'correct horse battery') {
  fireEvent.change(await screen.findByLabelText(t('auth.login.email')), {
    target: { value: backend.user.email },
  });
  fireEvent.change(screen.getByLabelText(t('auth.login.password')), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: t('auth.login.submit') }));
}

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

describe('LoginPage', () => {
  it('logs in with an e-mail and a password', async () => {
    const backend = new MockBackend('login');
    renderLogin(backend);
    await submitPassword(backend);
    await screen.findByText('home');
    expect(backend.auth).toBe('ready');
  });

  it.each([true, false])(
    'offers no e-mail code login, whether the server has it (%s) or not',
    async (enabled) => {
      const backend = new MockBackend('login');
      backend.emailLogin.enabled = enabled;
      renderLogin(backend);
      expect(await screen.findByLabelText(t('auth.login.password'))).toBeTruthy();
      expect(screen.queryByRole('button', { name: t('auth.emailLogin.sendCode') })).toBeNull();
      expect(screen.queryByRole('button', { name: t('auth.emailLogin.usePassword') })).toBeNull();
    },
  );

  it('goes on to a safe next after the login', async () => {
    const backend = new MockBackend('login');
    renderLogin(backend, `/login?next=${encodeURIComponent('/invite/abc')}`);
    await submitPassword(backend);
    await screen.findByText('invite');
    expect(screen.getByTestId('where').textContent).toBe('/invite/abc');
  });
});
