import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
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
afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

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
