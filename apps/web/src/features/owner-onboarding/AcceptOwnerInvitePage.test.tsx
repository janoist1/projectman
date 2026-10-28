import { fireEvent, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { MockBackend } from '../../mocks/backend';
import { mockProject } from '../../test/mockProject';
import { AcceptOwnerInvitePage } from './AcceptOwnerInvitePage';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

function renderInvite(backend: MockBackend, token: string) {
  backend.auth = 'login';
  const project = mockProject(backend);
  project.render(
    <Routes>
      <Route path="/owner-invite/:token" element={<AcceptOwnerInvitePage />} />
      <Route path="/welcome" element={<p>welcome page</p>} />
    </Routes>,
    `/owner-invite/${token}`,
  );
  return project;
}

it('creates the account from a name and a password and lands on the first steps', async () => {
  const backend = new MockBackend();
  backend.ownerInvites.push({ token: 'tok1', email: 'new@owner.test', inviterName: 'Ist1', used: false });
  const project = renderInvite(backend, 'tok1');
  fireEvent.change(await screen.findByLabelText(t('invites.name')), { target: { value: 'Eszter' } });
  fireEvent.change(screen.getByLabelText(t('invites.password')), {
    target: { value: 'correct horse battery' },
  });
  fireEvent.click(screen.getByRole('button', { name: t('ownerOnboarding.invite.accept') }));
  await screen.findByText('welcome page');
  expect(project.requests.find((request) => request.path === '/api/owner-invites/tok1/accept')?.body).toEqual(
    {
      name: 'Eszter',
      password: 'correct horse battery',
    },
  );
  expect(backend.ownerAccountIds.has(backend.user.userId)).toBe(true);
});

it('shows an invitation that does not exist as invalid, without a form', async () => {
  renderInvite(new MockBackend(), 'nope');
  expect(await screen.findByText(t('ownerOnboarding.invite.invalidTitle'))).toBeTruthy();
  expect(screen.queryByLabelText(t('invites.password'))).toBeNull();
});

it('sends an existing account to log in, back to the invitation', async () => {
  const backend = new MockBackend();
  backend.accounts.set('known@owner.test', {
    userId: 'usr_known',
    name: 'Known',
    email: 'known@owner.test',
    password: 'correct horse battery',
  });
  backend.ownerInvites.push({ token: 'tok2', email: 'known@owner.test', inviterName: 'Ist1', used: false });
  renderInvite(backend, 'tok2');
  const link = await screen.findByRole('link', { name: t('ownerOnboarding.invite.login') });
  expect(link.getAttribute('href')).toBe(`/login?next=${encodeURIComponent('/owner-invite/tok2')}`);
});
