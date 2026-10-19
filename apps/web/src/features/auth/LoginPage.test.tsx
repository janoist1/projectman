import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreatedInvitation } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { MockBackend } from '../../mocks/backend';
import { createMockFetch } from '../../test/mockProject';
import type { MockRequest } from '../../test/mockProject';
import { renderUi } from '../../test/render';
import { LoginPage } from './LoginPage';

const address = 'kata@client.test';

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

/** A client invitation for the address, made while the owner is in; the page is then used logged out. */
function invite(backend: MockBackend, displayName: string | undefined = 'Kata'): string {
  const created = backend.handle('POST', '/api/projects/AC/invites', {
    email: address,
    ...(displayName ? { displayName } : {}),
    access: 'client',
    roles: [],
  }).body as CreatedInvitation;
  backend.auth = 'login';
  return created.path.replace('/invite/', '');
}

/** An existing client: a seat in the project and an account without a password. */
function existingClient(backend: MockBackend): void {
  backend.config.team.members.push({
    kind: 'human',
    handle: 'kata',
    displayName: 'Kata',
    email: address,
    access: 'client',
    roles: [],
  });
  backend.accounts.set(address, { userId: 'usr_kata', name: 'Kata', email: address, password: null });
  backend.auth = 'login';
}

function renderLogin(backend: MockBackend, route = '/login') {
  const requests: MockRequest[] = [];
  setFetchImplementation(createMockFetch(backend, requests));
  renderUi(
    <>
      <Where />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/p/:key/*" element={<p>{t('team.title')}</p>} />
        <Route path="/" element={<p>home</p>} />
      </Routes>
    </>,
    { route },
  );
  return requests;
}

function enabledBackend(): MockBackend {
  const backend = new MockBackend();
  backend.emailLogin.enabled = true;
  return backend;
}

async function sendCode(value = address) {
  const input = await screen.findByLabelText(t('auth.login.email'));
  fireEvent.change(input, { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: t('auth.emailLogin.sendCode') }));
}

async function typeCode(code: string) {
  const input = await screen.findByLabelText(t('auth.emailLogin.codeLabel'));
  fireEvent.change(input, { target: { value: code } });
  fireEvent.click(screen.getByRole('button', { name: t('auth.emailLogin.verify') }));
}

const ofPath = (requests: MockRequest[], suffix: string) =>
  requests.filter((request) => request.path.endsWith(suffix));

afterEach(() => {
  vi.useRealTimers();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

describe('LoginPage without the e-mail code login', () => {
  it.each([
    ['missing', undefined],
    ['false', false],
  ])("keeps today's password login when the flag is %s", async (_name, flag) => {
    const backend = new MockBackend('login');
    // A server without the login does not say so, or says false.
    const handle = backend.handle.bind(backend);
    backend.handle = (method, path, body, query) => {
      const response = handle(method, path, body, query);
      return path === '/api/setup' && method === 'GET' && flag === false
        ? { ...response, body: { ...(response.body as object), emailLoginEnabled: false } }
        : response;
    };
    renderLogin(backend);
    expect(await screen.findByLabelText(t('auth.login.password'))).toBeTruthy();
    expect(screen.getByText(t('auth.login.subtitle'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('auth.emailLogin.sendCode') })).toBeNull();
    expect(screen.queryByText(t('auth.emailLogin.useCode'))).toBeNull();
  });

  it('still logs in with a password', async () => {
    const backend = new MockBackend('login');
    renderLogin(backend);
    fireEvent.change(await screen.findByLabelText(t('auth.login.email')), {
      target: { value: backend.user.email },
    });
    fireEvent.change(screen.getByLabelText(t('auth.login.password')), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('auth.login.submit') }));
    await screen.findByText('home');
    expect(backend.auth).toBe('ready');
  });
});

describe('LoginPage with the e-mail code login', () => {
  let backend: MockBackend;
  beforeEach(() => {
    backend = enabledBackend();
  });

  it('asks for the address first, with the focus in the field', async () => {
    invite(backend);
    renderLogin(backend);
    const input = await screen.findByLabelText(t('auth.login.email'));
    expect(screen.getByText(t('auth.emailLogin.subtitle'))).toBeTruthy();
    expect(document.activeElement).toBe(input);
    expect(screen.queryByLabelText(t('auth.login.password'))).toBeNull();
  });

  it('checks the shape of the address before it asks', async () => {
    invite(backend);
    const requests = renderLogin(backend);
    await sendCode('not an address');
    expect(await screen.findByText(t('auth.validation.emailInvalid'))).toBeTruthy();
    expect(ofPath(requests, '/api/auth/email/request')).toHaveLength(0);
  });

  it('logs a new client in with the code, announces the sent mail and keeps the secrets out of the URL', async () => {
    invite(backend);
    const consoleCalls: unknown[][] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const)
      vi.spyOn(console, method).mockImplementation((...args) => void consoleCalls.push(args));
    const requests = renderLogin(backend);
    await sendCode();

    const codeInput = await screen.findByLabelText(t('auth.emailLogin.codeLabel'));
    expect(document.activeElement).toBe(codeInput);
    expect(screen.getByText(address)).toBeTruthy();
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe(
      t('auth.emailLogin.announceSent'),
    );
    expect(screen.getByTestId('where').textContent).toBe('/login');
    expect(ofPath(requests, '/api/auth/email/request')[0]?.body).toEqual({ email: address });

    const code = backend.emailLogin.lastCodeTo(address)!;
    await typeCode(`${code.slice(0, 3)} ${code.slice(3)}`);
    await screen.findByText(t('team.title'));
    expect(ofPath(requests, '/api/auth/email/verify')[0]?.body).toEqual({ email: address, code });
    expect(screen.getByTestId('where').textContent).toBe('/p/AC');
    expect(backend.auth).toBe('ready');

    const kept = JSON.stringify([
      { ...localStorage },
      { ...sessionStorage },
      consoleCalls,
      window.location.href,
    ]);
    expect(kept).not.toContain(code);
    expect(kept).not.toContain(address);
  });

  it('gives the unknown address the same step as a known one', async () => {
    invite(backend);
    renderLogin(backend);
    await sendCode('nobody@client.test');
    expect(await screen.findByLabelText(t('auth.emailLogin.codeLabel'))).toBeTruthy();
    expect(screen.getByText(t('auth.emailLogin.codeSubtitle', { digits: 6, minutes: 10 }))).toBeTruthy();
    expect(backend.emailLogin.outbox).toHaveLength(0);
  });

  it('shows a failed send as a problem on the address step', async () => {
    invite(backend);
    const requests = renderLogin(backend);
    backend.emailLogin.request = () => ({
      status: 500,
      body: { error: { code: 'internal_error', message: 'Boom' } },
    });
    await sendCode();
    await waitFor(() => expect(ofPath(requests, '/api/auth/email/request')).toHaveLength(1));
    expect(await screen.findByRole('button', { name: t('auth.emailLogin.sendCode') })).toBeTruthy();
    expect(screen.queryByLabelText(t('auth.emailLogin.codeLabel'))).toBeNull();
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('says plainly that the login is unavailable', async () => {
    invite(backend);
    renderLogin(backend);
    backend.emailLogin.enabled = false;
    await sendCode();
    expect(await screen.findByText(t('auth.emailLogin.unavailable'))).toBeTruthy();
  });

  it('sends one request for a double click and for Enter', async () => {
    invite(backend);
    const requests = renderLogin(backend);
    const input = await screen.findByLabelText(t('auth.login.email'));
    fireEvent.change(input, { target: { value: address } });
    const button = screen.getByRole('button', { name: t('auth.emailLogin.sendCode') });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.submit(input.closest('form')!);
    await screen.findByLabelText(t('auth.emailLogin.codeLabel'));
    expect(ofPath(requests, '/api/auth/email/request')).toHaveLength(1);
  });

  it('keeps the focus on a wrong code, selects it and offers a new code after the wait', async () => {
    invite(backend);
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    renderLogin(backend);
    await sendCode();
    const input = (await screen.findByLabelText(t('auth.emailLogin.codeLabel'))) as HTMLInputElement;
    const first = backend.emailLogin.lastCodeTo(address)!;
    const wrong = first === '000000' ? '111111' : '000000';
    await typeCode(wrong);
    expect(await screen.findByText(t('auth.emailLogin.codeInvalid'))).toBeTruthy();
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(wrong.length);
    // The wait comes first, the full-width button after it.
    expect(screen.queryByRole('button', { name: t('auth.emailLogin.resend') })).toBeNull();
    expect(screen.getByText(t('auth.emailLogin.resendWait', { time: '1:00' }))).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    fireEvent.click(await screen.findByRole('button', { name: t('auth.emailLogin.resend') }));
    // The green bar and the announcement say it.
    expect(await screen.findAllByText(t('auth.emailLogin.resent'))).toHaveLength(2);
    expect(backend.emailLogin.outbox).toHaveLength(2);
    const second = backend.emailLogin.lastCodeTo(address)!;
    expect(second).not.toBe(first);
    expect((screen.getByLabelText(t('auth.emailLogin.codeLabel')) as HTMLInputElement).value).toBe('');
    await typeCode(second);
    await screen.findByText(t('team.title'));
  });

  it('refuses a code of the wrong shape without asking the server', async () => {
    invite(backend);
    const requests = renderLogin(backend);
    await sendCode();
    await typeCode('12');
    expect(await screen.findByText(t('auth.emailLogin.codeFormat', { digits: 6 }))).toBeTruthy();
    expect(ofPath(requests, '/api/auth/email/verify')).toHaveLength(0);
  });

  it('asks for a name of a new account and sends the same code with it', async () => {
    invite(backend, '');
    const requests = renderLogin(backend);
    await sendCode();
    const code = backend.emailLogin.lastCodeTo(address)!;
    await typeCode(code);
    const name = await screen.findByLabelText(t('auth.emailLogin.nameLabel'));
    expect(screen.getByText(t('auth.emailLogin.nameTitle'))).toBeTruthy();
    expect(document.activeElement).toBe(name);
    fireEvent.change(name, { target: { value: 'Kata Kovács' } });
    fireEvent.click(screen.getByRole('button', { name: t('auth.login.submit') }));
    await screen.findByText(t('team.title'));
    const verifies = ofPath(requests, '/api/auth/email/verify');
    expect(verifies.map((request) => request.body)).toEqual([
      { email: address, code },
      { email: address, code, name: 'Kata Kovács' },
    ]);
    expect(backend.user.name).toBe('Kata Kovács');
  });

  it('returns to the address with a problem when the address lost its access', async () => {
    invite(backend);
    renderLogin(backend);
    await sendCode();
    const code = backend.emailLogin.lastCodeTo(address)!;
    backend.invitations[0]!.revokedAt = new Date().toISOString();
    await typeCode(code);
    expect(await screen.findByText(t('errors.codes.email_login_no_access'))).toBeTruthy();
    expect(await screen.findByRole('button', { name: t('auth.emailLogin.sendCode') })).toBeTruthy();
  });

  it('lets the person change the address from the code step', async () => {
    invite(backend);
    renderLogin(backend);
    await sendCode();
    fireEvent.click(await screen.findByRole('button', { name: t('auth.emailLogin.otherAddress') }));
    const input = (await screen.findByLabelText(t('auth.login.email'))) as HTMLInputElement;
    expect(input.value).toBe(address);
    expect(document.activeElement).toBe(input);
  });

  it('shows a rate limit as a disabled button with the wait, counting down', async () => {
    invite(backend);
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    backend.emailLogin.rateLimitedFor = 30;
    renderLogin(backend);
    await sendCode();
    const waiting = await screen.findByRole('button', {
      name: t('auth.emailLogin.sendCodeWait', { time: '0:30' }),
    });
    expect((waiting as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(t('auth.emailLogin.tooMany'))).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(
      screen.getByRole('button', { name: t('auth.emailLogin.sendCodeWait', { time: '0:25' }) }),
    ).toBeTruthy();
    backend.emailLogin.rateLimitedFor = null;
    await act(async () => {
      vi.advanceTimersByTime(25_000);
    });
    const ready = await screen.findByRole('button', { name: t('auth.emailLogin.sendCode') });
    expect((ready as HTMLButtonElement).disabled).toBe(false);
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe(
      t('auth.emailLogin.announceResendReady'),
    );
  });

  it('switches to the password on the same page, keeps the address and focuses the password', async () => {
    invite(backend);
    renderLogin(backend);
    fireEvent.change(await screen.findByLabelText(t('auth.login.email')), { target: { value: address } });
    fireEvent.click(screen.getByRole('button', { name: t('auth.emailLogin.usePassword') }));
    const password = await screen.findByLabelText(t('auth.login.password'));
    expect((screen.getByLabelText(t('auth.login.email')) as HTMLInputElement).value).toBe(address);
    expect(document.activeElement).toBe(password);
    expect(screen.getByTestId('where').textContent).toBe('/login');

    fireEvent.click(screen.getByRole('button', { name: t('auth.emailLogin.useCode') }));
    const email = (await screen.findByLabelText(t('auth.login.email'))) as HTMLInputElement;
    expect(email.value).toBe(address);
    expect(screen.getByRole('button', { name: t('auth.emailLogin.sendCode') })).toBeTruthy();
  });

  it('focuses the address in the password mode when there is none yet', async () => {
    invite(backend);
    renderLogin(backend);
    fireEvent.click(await screen.findByRole('button', { name: t('auth.emailLogin.usePassword') }));
    const email = await screen.findByLabelText(t('auth.login.email'));
    expect(document.activeElement).toBe(email);
  });

  it('starts in the password mode behind an invitation page', async () => {
    invite(backend);
    renderLogin(backend, `/login?next=${encodeURIComponent('/invite/abc')}`);
    expect(await screen.findByLabelText(t('auth.login.password'))).toBeTruthy();
    expect(screen.getByRole('button', { name: t('auth.emailLogin.useCode') })).toBeTruthy();
  });

  it('lands a client of several projects on the project list', async () => {
    existingClient(backend);
    backend.extraMeProjects = [{ key: 'BD', name: 'Bar', access: 'client', roles: [] }];
    renderLogin(backend);
    await sendCode();
    await typeCode(backend.emailLogin.lastCodeTo(address)!);
    await screen.findByText('home');
    expect(screen.getByTestId('where').textContent).toBe('/');
  });

  it('lands a client of one project in it, and honours a safe next', async () => {
    existingClient(backend);
    renderLogin(backend, `/login?next=${encodeURIComponent('/p/AC/tasks')}`);
    await sendCode();
    await typeCode(backend.emailLogin.lastCodeTo(address)!);
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/p/AC/tasks'));
  });

  it.each(['//evil.test', '/\\evil.test', '/\\\\evil.test', '/\t/evil.test', '/\n/evil.test'])(
    'ignores the unsafe next %j and lands in the client project',
    async (next) => {
      existingClient(backend);
      renderLogin(backend, `/login?next=${encodeURIComponent(next)}`);
      await sendCode();
      await typeCode(backend.emailLogin.lastCodeTo(address)!);
      await screen.findByText(t('team.title'));
      expect(screen.getByTestId('where').textContent).toBe('/p/AC');
    },
  );
});
