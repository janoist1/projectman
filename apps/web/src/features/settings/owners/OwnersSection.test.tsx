import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostRequestView, OwnerAccountView } from '@projectman/shared';
import { setFetchImplementation } from '../../../api/client';
import { queryKeys } from '../../../api/queryKeys';
import { createMockFetch, mockProject } from '../../../test/mockProject';
import { t } from '../../../i18n/t';
import { OwnersSection } from './OwnersSection';
import { RevokeOwnerDialog } from './RevokeOwnerDialog';
import { SettingsTestRoutes } from '../testRoutes';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));
const account: OwnerAccountView = {
  userId: 'usr_guest',
  name: 'Guest Owner',
  email: 'guest@example.test',
  grantedAt: '2026-10-01T10:00:00Z',
  revokedAt: null,
  projectCount: 3,
  pausedProjectCount: 0,
  engines: { total: 2, online: 1 },
};
const request: HostRequestView = {
  id: 'hr_1',
  projectKey: 'OTHER',
  projectName: 'Other project',
  openedBy: 'pm',
  owners: ['Guest Owner'],
  title: 'Need access',
  body: 'Plain text https://example.test ![image](https://example.test/a.png)',
  state: 'open',
  answer: null,
  answeredVia: null,
  createdAt: '2026-10-01T10:00:00Z',
  updatedAt: '2026-10-01T10:00:00Z',
};
function fixture() {
  const project = mockProject();
  project.backend.owners.accounts.push(structuredClone(account));
  project.backend.owners.requests.push(structuredClone(request));
  return project;
}

describe('host owner settings', () => {
  it('refreshes the visible request list when the navigation count reloads', async () => {
    const project = fixture();
    project.context.me.hostOwner = true;
    const view = project.render(<SettingsTestRoutes />, '/p/AC/settings/owners');
    await screen.findByText(request.title);
    project.backend.owners.requests.push({ ...request, id: 'hr_new', title: 'New request' });
    await act(async () => {
      await view.client.invalidateQueries({ queryKey: queryKeys.hostRequests('open') });
    });
    expect(await screen.findByText('New request')).toBeTruthy();
  });

  it('locks the answer and cancellation until sending finishes', async () => {
    const project = fixture();
    const fetch = createMockFetch(project.backend, project.requests);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setFetchImplementation(async (path, init) => {
      if (path.endsWith('/answer')) await gate;
      return fetch(path, init);
    });
    project.render(<OwnersSection />);
    fireEvent.click(await screen.findByRole('button', { name: t('hostRequests.answer') }));
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Sending this response' } });
    fireEvent.click(screen.getByRole('button', { name: t('hostRequests.sendAnswer') }));
    await waitFor(() => expect(input.disabled).toBe(true));
    expect((screen.getByRole('button', { name: t('common.cancel') }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.getByRole('textbox')).toBe(input);
    release();
    await screen.findByText(t('hostRequests.closedFold', { n: 1 }));
  });
  it('creates an invitation and shows the link only in the dialog', async () => {
    const project = mockProject();
    const view = project.render(<OwnersSection />);
    await screen.findByText(t('owners.emptyTitle'));
    expect(screen.queryByRole('heading', { name: t('hostRequests.title') })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('owners.invite') }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(t('owners.email')), {
      target: { value: 'new@example.test' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: t('owners.create') }));
    const link = await screen.findByLabelText(t('owners.link'));
    const url = link.textContent!;
    expect(url).toMatch(/^https?:\/\/.*\/owner-invite\/mock_/);
    expect(
      project.requests.find((r) => r.method === 'POST' && r.path === '/api/owner-invitations')?.body,
    ).toEqual({ email: 'new@example.test' });
    expect(
      JSON.stringify(
        view.client
          .getMutationCache()
          .getAll()
          .map((m) => m.state.data),
      ),
    ).not.toContain('/owner-invite/');
    fireEvent.click(screen.getByRole('button', { name: t('owners.done') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByText(url)).toBeNull();
    expect(await screen.findByText('new@example.test')).toBeTruthy();
  });

  it('revokes a pending invitation', async () => {
    const project = mockProject();
    project.backend.owners.invitations.push({
      id: 'inv_1',
      email: 'pending@example.test',
      invitedBy: 'Host',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      acceptedAt: null,
      revokedAt: null,
    });
    project.render(<OwnersSection />);
    fireEvent.click(
      await screen.findByRole('button', {
        name: t('owners.revokeInvite', { email: 'pending@example.test' }),
      }),
    );
    await waitFor(() => expect(screen.queryByText('pending@example.test')).toBeNull());
    expect(
      project.requests.some((r) => r.method === 'DELETE' && r.path === '/api/owner-invitations/inv_1'),
    ).toBe(true);
  });

  it('explains revocation when the owner has no projects', async () => {
    mockProject().render(<RevokeOwnerDialog account={{ ...account, projectCount: 0 }} onClose={() => {}} />);
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(t('owners.revokeNoProjects'))).toBeTruthy();
    expect(within(dialog).queryByText(t('owners.revokeProjects', { n: 0 }))).toBeNull();
  });

  it('confirms account revocation with cancel focused and moves it into the revoked fold', async () => {
    const project = fixture();
    project.render(<OwnersSection />);
    fireEvent.click(await screen.findByRole('button', { name: t('owners.actions', { name: account.name }) }));
    fireEvent.click(await screen.findByRole('button', { name: t('owners.revoke') }));
    const dialog = await screen.findByRole('alertdialog');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: t('common.cancel') }));
    expect(within(dialog).getByText(t('owners.revokeProjects', { n: 3 }))).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: t('owners.revokeConfirm') }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(await screen.findByText(t('owners.revokedFold', { n: 1 }))).toBeTruthy();
    expect(
      project.requests.some((r) => r.method === 'POST' && r.path === '/api/owner-accounts/usr_guest/revoke'),
    ).toBe(true);
  });

  it.each(['answered', 'declined'] as const)(
    'closes a request as %s and renders external text without links',
    async (outcome) => {
      const project = fixture();
      project.render(<OwnersSection />);
      const title = await screen.findByText(request.title);
      expect(title.closest('li')?.querySelector('a, img')).toBeNull();
      fireEvent.click(
        screen.getByRole('button', {
          name: t(outcome === 'answered' ? 'hostRequests.answer' : 'hostRequests.decline'),
        }),
      );
      const input = screen.getByRole('textbox');
      expect(document.activeElement).toBe(input);
      const send = screen.getByRole('button', {
        name: t(outcome === 'answered' ? 'hostRequests.sendAnswer' : 'hostRequests.sendDecline'),
      });
      expect((send as HTMLButtonElement).disabled).toBe(true);
      fireEvent.change(input, { target: { value: '  A useful response  ' } });
      fireEvent.click(send);
      await screen.findByText(t('hostRequests.closedFold', { n: 1 }));
      expect(
        project.requests.find((r) => r.method === 'POST' && r.path === '/api/host-requests/hr_1/answer')
          ?.body,
      ).toEqual({ outcome, answer: 'A useful response' });
      fireEvent.click(screen.getByText(t('hostRequests.closedFold', { n: 1 })));
      expect(await screen.findByText(t(`hostRequests.${outcome}`))).toBeTruthy();
      expect(screen.getByText('A useful response')).toBeTruthy();
    },
  );

  it('explains a concurrently closed request and refreshes the list', async () => {
    const project = fixture();
    project.backend.owners.requests.push({ ...request, id: 'hr_2', title: 'Another request' });
    project.render(<OwnersSection />);
    const first = (await screen.findByText(request.title)).closest('li')!;
    fireEvent.click(within(first).getByRole('button', { name: t('hostRequests.answer') }));
    project.backend.owners.requests[0]!.state = 'withdrawn';
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Answer' } });
    fireEvent.click(screen.getByRole('button', { name: t('hostRequests.sendAnswer') }));
    expect(await screen.findByText(t('hostRequests.stale'))).toBeTruthy();
    await screen.findByText(t('hostRequests.closedFold', { n: 1 }));
    expect(
      project.requests.filter((r) => r.path === '/api/host-requests' && r.method === 'GET').length,
    ).toBeGreaterThan(1);
    fireEvent.click(screen.getByRole('button', { name: t('hostRequests.answer') }));
    expect(screen.queryByText(t('hostRequests.stale'))).toBeNull();
  });

  it('preserves the answer when sending fails', async () => {
    const project = fixture();
    const fetch = createMockFetch(project.backend, project.requests);
    setFetchImplementation((path, init) =>
      path.endsWith('/answer')
        ? Promise.resolve(
            new Response(JSON.stringify({ error: { code: 'internal_error', message: 'Failed' } }), {
              status: 500,
            }),
          )
        : fetch(path, init),
    );
    project.render(<OwnersSection />);
    fireEvent.click(await screen.findByRole('button', { name: t('hostRequests.answer') }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep this draft' } });
    fireEvent.click(screen.getByRole('button', { name: t('hostRequests.sendAnswer') }));
    await screen.findByRole('alert');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Keep this draft');
  });
});
