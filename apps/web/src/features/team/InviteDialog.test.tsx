import { hu as templateLocale } from '@projectman/templates';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { InviteDialog } from './InviteDialog';
import { PendingInvites } from './PendingInvites';
import { TeamPage } from './TeamPage';

afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

describe('InviteDialog', () => {
  it.each([true, false])(
    'offers the access levels allowed for owner=%s and only human-capable roles',
    async (isOwner) => {
      const project = mockProject();
      project.backend.config.team.roles.push({
        id: 'client_tester',
        name: 'Acme tester',
        summary: 'Tests shared tasks.',
        holders: 'human',
        notTheirJob: '',
        instructions: '',
      });
      project.backend.config.team.roles.push({
        id: 'ai_helper',
        name: 'Acme helper',
        summary: 'Assists AI.',
        holders: 'ai',
        notTheirJob: '',
        instructions: '',
      });
      project.render(<InviteDialog open onClose={() => {}} />, '/', { isOwner });
      const levels = screen.getAllByRole('radio').map((radio) => (radio as HTMLInputElement).value);
      expect(levels).toEqual(
        isOwner ? ['admin', 'developer', 'client', 'viewer'] : ['developer', 'client', 'viewer'],
      );
      expect(screen.queryByRole('radio', { name: /Tulajdonos/ })).toBeNull();
      expect(await screen.findByRole('checkbox', { name: 'Acme tester' })).toBeTruthy();
      expect(screen.queryByRole('checkbox', { name: 'Acme helper' })).toBeNull();
      expect(screen.queryByRole('checkbox', { name: templateLocale.roles.watchdog.name })).toBeTruthy();
      expect(screen.getByText(t('invites.accessHint.client'))).toBeTruthy();
    },
  );

  it('creates an invite, shows the origin-based full link and copies it', async () => {
    const project = mockProject();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    project.render(<InviteDialog open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText(t('invites.email')), { target: { value: 'colleague@acme.test' } });
    fireEvent.change(screen.getByLabelText(t('invites.name'), { exact: false }), {
      target: { value: 'Kata' },
    });
    fireEvent.click(await screen.findByRole('checkbox', { name: 'QA' }));
    fireEvent.click(screen.getByRole('button', { name: t('invites.create') }));
    const link = (await screen.findByLabelText(t('invites.link'))) as HTMLInputElement;
    expect(link.value.startsWith(`${window.location.origin}/invite/`)).toBe(true);
    expect(screen.getByText(t('invites.lifetime'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('invites.copy') }));
    await screen.findByRole('button', { name: t('invites.copied') });
    expect(writeText).toHaveBeenCalledWith(link.value);
    expect(
      project.requests.find((request) => request.method === 'POST' && request.path.endsWith('/invites'))
        ?.body,
    ).toMatchObject({
      email: 'colleague@acme.test',
      displayName: 'Kata',
      access: 'developer',
      roles: ['qa'],
    });
  });

  it('keeps the full link selectable when clipboard access fails', async () => {
    const project = mockProject();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('unavailable')) },
    });
    project.render(<InviteDialog open onClose={() => {}} />);
    await screen.findByRole('checkbox', { name: 'QA' });
    fireEvent.change(screen.getByLabelText(t('invites.email')), { target: { value: 'colleague@acme.test' } });
    fireEvent.click(screen.getByRole('button', { name: t('invites.create') }));
    await screen.findByLabelText(t('invites.link'));
    fireEvent.click(screen.getByRole('button', { name: t('invites.copy') }));
    expect((await screen.findByRole('alert')).textContent).toBe(t('invites.copyFailed'));
  });

  it('lists pending invitations and revokes them', async () => {
    const project = mockProject();
    project.backend.handle('POST', '/api/projects/AC/invites', {
      email: 'colleague@acme.test',
      displayName: 'Kata',
      access: 'viewer',
      roles: [],
    });
    project.render(<PendingInvites />);
    fireEvent.click(
      await screen.findByRole('button', { name: t('invites.revokeFor', { email: 'colleague@acme.test' }) }),
    );
    // With none left the page has no box for them.
    await waitFor(() => expect(screen.queryByRole('heading', { name: t('invites.pending') })).toBeNull());
    expect(project.backend.invitations[0]?.revokedAt).not.toBeNull();
  });

  it('shows no pending invitations box while there are none', async () => {
    const project = mockProject();
    project.render(<PendingInvites />);
    await waitFor(() =>
      expect(project.requests.some((request) => request.path.endsWith('/invites'))).toBe(true),
    );
    expect(screen.queryByRole('heading', { name: t('invites.pending') })).toBeNull();
  });

  it('hides invite management from non-admins', async () => {
    const project = mockProject();
    project.render(<TeamPage />, '/', {
      isOwner: false,
      can: { createTasks: true, manageTeam: false, workInSessions: true },
    });
    await screen.findByRole('heading', { name: t('team.title') });
    expect(screen.queryByRole('button', { name: t('addHuman.title') })).toBeNull();
    expect(screen.queryByRole('heading', { name: t('invites.pending') })).toBeNull();
    expect(project.requests.some((request) => request.path.endsWith('/invites'))).toBe(false);
  });
});
