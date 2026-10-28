import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { maskEmail } from '@projectman/shared';
import type { CreatedInvitation } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { MockBackend } from '../../mocks/backend';
import { mockProject } from '../../test/mockProject';
import { LoginPage } from '../auth/LoginPage';
import { AcceptInvitePage } from './AcceptInvitePage';

const input = { email: 'colleague@acme.test', displayName: 'Kata', access: 'client', roles: ['qa'] };
function create(backend: MockBackend) {
  return (backend.handle('POST', '/api/projects/AC/invites', input).body as CreatedInvitation).path;
}
function renderInvite(backend: MockBackend, path: string) {
  const project = mockProject(backend);
  project.render(
    <Routes>
      <Route path="/invite/:token" element={<AcceptInvitePage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/p/AC" element={<p>{t('team.title')}</p>} />
    </Routes>,
    path,
  );
  return project;
}
afterEach(() => {
  vi.useRealTimers();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

describe('AcceptInvitePage', () => {
  it('shows the project, offered access and roles, creates a new account and enters the project', async () => {
    const backend = new MockBackend();
    const path = create(backend);
    backend.auth = 'login';
    renderInvite(backend, path);
    expect(
      await screen.findByText(t('invites.offered', { name: 'Te', project: 'Acme webshop' })),
    ).toBeTruthy();
    expect(screen.getByText(t('invites.accessHint.client'), { exact: false })).toBeTruthy();
    const name = (await screen.findByLabelText(t('invites.name'))) as HTMLInputElement;
    expect(name.value).toBe('Kata');
    fireEvent.change(screen.getByLabelText(t('invites.password')), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('invites.accept') }));
    await screen.findByText(t('team.title'));
    expect(backend.user.email).toBe(input.email);
    expect(backend.auth).toBe('ready');
    expect(backend.config.team.members.at(-1)).toMatchObject({
      kind: 'human',
      access: 'client',
      roles: ['qa'],
      displayName: 'Kata',
    });
  });

  it('asks an existing user to log in and returns to the invite to accept without a new password', async () => {
    const backend = new MockBackend();
    backend.accounts.set(input.email, {
      userId: 'usr_kata',
      name: 'Kata',
      email: input.email,
      password: 'correct horse battery',
    });
    const path = create(backend);
    backend.auth = 'login';
    const project = renderInvite(backend, path);
    const loginLink = await screen.findByRole('link', { name: t('invites.login') });
    expect(loginLink.getAttribute('href')).toBe(`/login?next=${encodeURIComponent(path)}`);
    expect(screen.queryByLabelText(t('invites.password'))).toBeNull();
    fireEvent.click(loginLink);
    fireEvent.change(await screen.findByLabelText(t('auth.login.email')), { target: { value: input.email } });
    fireEvent.change(screen.getByLabelText(t('auth.login.password')), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('auth.login.submit') }));
    const accept = await screen.findByRole('button', { name: t('invites.accept') });
    expect(screen.queryByLabelText(t('invites.password'))).toBeNull();
    fireEvent.click(accept);
    await screen.findByText(t('team.title'));
    expect(project.requests.find((request) => request.path.endsWith('/accept'))?.body).toEqual({});
    expect(backend.user.userId).toBe('usr_kata');
  });

  it('prompts for the correct login when another account is logged in', async () => {
    const backend = new MockBackend();
    backend.accounts.set(input.email, {
      userId: 'usr_kata',
      name: 'Kata',
      email: input.email,
      password: 'correct horse battery',
    });
    renderInvite(backend, create(backend));
    fireEvent.click(await screen.findByRole('button', { name: t('invites.accept') }));
    expect(await screen.findByText(t('invites.loginRequired'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('invites.accept') })).toBeNull();
  });

  it.each(['unknown', 'expired', 'revoked', 'used'])(
    'shows a friendly page for an %s invite',
    async (state) => {
      const backend = new MockBackend();
      const path = state === 'unknown' ? '/invite/unknown' : create(backend);
      if (state === 'expired') backend.invitations[0]!.expiresAt = new Date(Date.now() - 1).toISOString();
      if (state === 'revoked') backend.invitations[0]!.revokedAt = new Date().toISOString();
      if (state === 'used') backend.invitations[0]!.acceptedAt = new Date().toISOString();
      renderInvite(backend, path);
      expect(await screen.findByText(t('invites.invalid'))).toBeTruthy();
      expect(screen.queryByRole('button', { name: t('invites.accept') })).toBeNull();
    },
  );

  it('handles a link revoked while the page is open', async () => {
    const backend = new MockBackend();
    const path = create(backend);
    backend.auth = 'login';
    renderInvite(backend, path);
    await screen.findByLabelText(t('invites.password'));
    backend.invitations[0]!.revokedAt = new Date().toISOString();
    fireEvent.change(screen.getByLabelText(t('invites.password')), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('invites.accept') }));
    await waitFor(() => expect(screen.getByText(t('invites.invalid'))).toBeTruthy());
    expect(screen.queryByRole('button', { name: t('invites.accept') })).toBeNull();
  });
});

describe('AcceptInvitePage with the e-mail code login', () => {
  const hint = maskEmail(input.email);

  function enabled() {
    const backend = new MockBackend();
    backend.emailLogin.enabled = true;
    return backend;
  }

  it('lets a new client name themselves and accept with a code instead of a password', async () => {
    const backend = enabled();
    const path = create(backend);
    backend.auth = 'login';
    const project = renderInvite(backend, path);
    const name = (await screen.findByLabelText(t('auth.emailLogin.nameLabel'))) as HTMLInputElement;
    expect(name.value).toBe('Kata');
    expect(document.activeElement).toBe(name);
    expect(screen.queryByLabelText(t('invites.password'))).toBeNull();
    expect(screen.queryByRole('link', { name: t('auth.emailLogin.usePassword') })).toBeNull();
    expect(screen.getByText(t('invites.codeIntro', { hint }))).toBeTruthy();
    expect(screen.getByText(t('invites.accessHint.client'), { exact: false })).toBeTruthy();

    fireEvent.change(name, { target: { value: 'Kata Kovács' } });
    fireEvent.click(screen.getByRole('button', { name: t('auth.emailLogin.sendCode') }));
    const codeInput = await screen.findByLabelText(t('auth.emailLogin.codeLabel'));
    expect(document.activeElement).toBe(codeInput);
    expect(screen.getByText(hint)).toBeTruthy();
    // The invited address is not the person's to change.
    expect(screen.queryByRole('button', { name: t('auth.emailLogin.otherAddress') })).toBeNull();
    expect(screen.getByText(t('invites.codeSentInvite', { digits: 6, minutes: 10 }))).toBeTruthy();
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe(
      t('auth.emailLogin.announceSentInvite'),
    );
    const token = path.replace('/invite/', '');
    expect(project.requests.find((request) => request.path.endsWith('/email/request'))?.body).toEqual({
      inviteToken: token,
    });

    const code = backend.emailLogin.lastCodeTo(input.email)!;
    fireEvent.change(codeInput, { target: { value: code } });
    fireEvent.click(screen.getByRole('button', { name: t('auth.emailLogin.verify') }));
    await screen.findByText(t('team.title'));
    expect(project.requests.find((request) => request.path.endsWith('/email/verify'))?.body).toEqual({
      inviteToken: token,
      code,
      name: 'Kata Kovács',
    });
    expect(backend.user.email).toBe(input.email);
    expect(backend.config.team.members.at(-1)).toMatchObject({
      access: 'client',
      displayName: 'Kata Kovács',
    });
    expect(backend.accounts.get(input.email)?.password).toBeNull();
  });

  it('asks an existing client only for the code, and offers the password as a link', async () => {
    const backend = enabled();
    backend.accounts.set(input.email, {
      userId: 'usr_kata',
      name: 'Kata',
      email: input.email,
      password: null,
    });
    const path = create(backend);
    backend.auth = 'login';
    const project = renderInvite(backend, path);
    fireEvent.click(await screen.findByRole('button', { name: t('auth.emailLogin.sendCode') }));
    expect(screen.queryByLabelText(t('auth.emailLogin.nameLabel'))).toBeNull();
    const link = screen.getByRole('link', { name: t('auth.emailLogin.usePassword') });
    expect(link.getAttribute('href')).toBe(`/login?next=${encodeURIComponent(path)}`);
    const codeInput = await screen.findByLabelText(t('auth.emailLogin.codeLabel'));
    fireEvent.change(codeInput, { target: { value: backend.emailLogin.lastCodeTo(input.email)! } });
    fireEvent.click(screen.getByRole('button', { name: t('auth.emailLogin.verify') }));
    await screen.findByText(t('team.title'));
    expect(
      (project.requests.find((request) => request.path.endsWith('/email/verify'))?.body as object) ?? {},
    ).not.toHaveProperty('name');
    expect(backend.user.userId).toBe('usr_kata');
  });

  it('keeps the password form for an invitation that is not a client one', async () => {
    const backend = enabled();
    const created = backend.handle('POST', '/api/projects/AC/invites', {
      email: input.email,
      displayName: 'Kata',
      access: 'developer',
      roles: [],
    }).body as CreatedInvitation;
    backend.auth = 'login';
    renderInvite(backend, created.path);
    expect(await screen.findByLabelText(t('invites.password'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('auth.emailLogin.sendCode') })).toBeNull();
  });

  it("keeps today's page for a person who is logged in already", async () => {
    const backend = enabled();
    const path = create(backend);
    renderInvite(backend, path);
    expect(await screen.findByRole('button', { name: t('invites.accept') })).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('auth.emailLogin.sendCode') })).toBeNull();
  });

  it('keeps the focus on a wrong code, selects it and offers a new code after the wait', async () => {
    const backend = enabled();
    const path = create(backend);
    backend.auth = 'login';
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    renderInvite(backend, path);
    fireEvent.click(await screen.findByRole('button', { name: t('auth.emailLogin.sendCode') }));
    const codeInput = (await screen.findByLabelText(t('auth.emailLogin.codeLabel'))) as HTMLInputElement;
    const first = backend.emailLogin.lastCodeTo(input.email)!;
    const wrong = first === '000000' ? '111111' : '000000';
    fireEvent.change(codeInput, { target: { value: wrong } });
    fireEvent.click(screen.getByRole('button', { name: t('auth.emailLogin.verify') }));
    expect(await screen.findByText(t('auth.emailLogin.codeInvalid'))).toBeTruthy();
    expect(document.activeElement).toBe(codeInput);
    expect(codeInput.selectionEnd).toBe(wrong.length);
    expect(screen.queryByRole('button', { name: t('auth.emailLogin.resend') })).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    fireEvent.click(await screen.findByRole('button', { name: t('auth.emailLogin.resend') }));
    await waitFor(() => expect(backend.emailLogin.outbox).toHaveLength(2));
    const second = backend.emailLogin.lastCodeTo(input.email)!;
    fireEvent.change(screen.getByLabelText(t('auth.emailLogin.codeLabel')), { target: { value: second } });
    fireEvent.click(screen.getByRole('button', { name: t('auth.emailLogin.verify') }));
    await screen.findByText(t('team.title'));
  });

  it('says so when the invitation was revoked while the code was on its way', async () => {
    const backend = enabled();
    const path = create(backend);
    backend.auth = 'login';
    renderInvite(backend, path);
    fireEvent.click(await screen.findByRole('button', { name: t('auth.emailLogin.sendCode') }));
    const codeInput = await screen.findByLabelText(t('auth.emailLogin.codeLabel'));
    const code = backend.emailLogin.lastCodeTo(input.email)!;
    backend.invitations[0]!.revokedAt = new Date().toISOString();
    fireEvent.change(codeInput, { target: { value: code } });
    fireEvent.click(screen.getByRole('button', { name: t('auth.emailLogin.verify') }));
    expect(await screen.findByText(t('invites.invalid'))).toBeTruthy();
  });
});
