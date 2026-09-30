import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n/t';
import { setFetchImplementation } from '../../api/client';
import { mockProject } from '../../test/mockProject';
import { TeamPage } from './TeamPage';

afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

describe('TeamPage role catalogue', () => {
  it.each([true, false])(
    'shows disabled AI to every member, with an admin settings link (%s)',
    async (manageTeam) => {
      const project = mockProject();
      project.backend.config.team.limits.aiEnabled = false;
      project.render(<TeamPage />, '/', { can: { manageTeam, createTasks: true, workInSessions: true } });
      expect(await screen.findByText(t('team.aiDisabled'))).toBeTruthy();
      const link = screen.queryByRole('link', { name: t('team.aiDisabledSettings') });
      if (manageTeam) expect(link?.getAttribute('href')).toBe('/p/AC/settings');
      else expect(link).toBeNull();
    },
  );

  it('adds a colleague without an invitation, including handle, access and responsibilities', async () => {
    const project = mockProject();
    project.render(<TeamPage />);
    fireEvent.click(await screen.findByRole('button', { name: t('addHuman.title') }));
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.change(dialog.getByLabelText(t('hire.displayName')), {
      target: { value: 'Fictional Colleague' },
    });
    fireEvent.change(dialog.getByLabelText(new RegExp(t('hire.handle'))), { target: { value: 'colleague' } });
    fireEvent.change(dialog.getByLabelText(t('invites.access')), { target: { value: 'viewer' } });
    fireEvent.click(await dialog.findByRole('checkbox', { name: 'QA' }));
    fireEvent.click(dialog.getByRole('button', { name: t('addHuman.submit') }));
    await screen.findByText('Fictional Colleague');
    expect(
      project.requests.find((request) => request.method === 'POST' && request.path.endsWith('/members/human'))
        ?.body,
    ).toEqual({ displayName: 'Fictional Colleague', handle: 'colleague', access: 'viewer', roles: ['qa'] });
    expect(
      project.requests.some((request) => request.method === 'POST' && request.path.endsWith('/invites')),
    ).toBe(false);
    expect(screen.getAllByText(t('memberStatus.no_account')).length).toBeGreaterThan(0);
  });

  it.each([false, true])(
    'creates an invitation for an unclaimed colleague from the roster (mobile: %s)',
    async (mobile) => {
      vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
        matches: mobile,
        media: query,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent: () => false,
      }));
      const project = mockProject();
      project.backend.handle('POST', '/api/projects/AC/members/human', {
        displayName: 'Fictional Colleague',
        handle: 'colleague',
        access: 'developer',
        roles: ['qa'],
      });
      project.render(<TeamPage />);
      const row = (await screen.findByText('Fictional Colleague')).closest(mobile ? 'li' : 'tr')!;
      fireEvent.click(within(row).getByRole('button', { name: t('invites.create') }));
      const dialog = within(screen.getByRole('dialog'));
      fireEvent.change(dialog.getByLabelText(t('invites.email')), {
        target: { value: 'colleague@acme.test' },
      });
      fireEvent.click(await dialog.findByRole('button', { name: t('invites.create') }));
      const link = await dialog.findByLabelText(t('invites.link'));
      expect((link as HTMLInputElement).value).toContain('/invite/');
      expect(
        project.requests.find((request) => request.method === 'POST' && request.path.endsWith('/invites'))
          ?.body,
      ).toEqual({
        email: 'colleague@acme.test',
        memberHandle: 'colleague',
        access: 'developer',
        roles: ['qa'],
      });
    },
  );

  it('shows every human responsibility next to access and one role for AI members', async () => {
    const project = mockProject();
    project.render(<TeamPage />);
    const owner = (await screen.findByText('Te')).closest('tr')!;
    expect(within(owner).getByText('Tulajdonos')).toBeTruthy();
    await waitFor(() => expect(within(owner).getByText('Operátor')).toBeTruthy());
    expect(within(owner).getByText('Terméktulajdonos')).toBeTruthy();
    const frontend = screen.getByText('Frontend fejlesztő').closest('tr')!;
    expect(within(frontend).getByText('Fejlesztő')).toBeTruthy();
    expect(within(owner).getByRole('button', { name: 'Tag szerkesztése: Te' })).toBeTruthy();
  });
  it('allows non-admins to see the catalogue without offering configuration changes', async () => {
    const project = mockProject();
    project.render(<TeamPage />, '/', {
      can: { createTasks: true, manageTeam: false, workInSessions: false },
    });
    await screen.findByRole('heading', { name: 'Szerepek' });
    await waitFor(() => expect(screen.getAllByText('Operátor').length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: 'Új szerep' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Tag szerkesztése/ })).toBeNull();
    expect(screen.queryByRole('button', { name: t('addHuman.title') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('invites.create') })).toBeNull();
    expect(project.requests.some((request) => request.path.endsWith('/config'))).toBe(false);
  });
  it.each([false, true])('shows provider badges in roster rows and cards (mobile: %s)', async (mobile) => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      matches: mobile,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    }));
    const project = mockProject();
    project.render(<TeamPage />);
    const claude = (await screen.findByText(project.backend.findMember('fe-1')!.displayName)).closest(
      mobile ? 'li' : 'tr',
    )!;
    const codex = screen
      .getByText(project.backend.findMember('be-1')!.displayName)
      .closest(mobile ? 'li' : 'tr')!;
    expect(within(claude).getByText(t('providers.claude'))).toBeTruthy();
    expect(within(codex).getByText(t('providers.codex'))).toBeTruthy();
    const human = screen.getByText(t('common.you')).closest(mobile ? 'li' : 'tr')!;
    expect(within(human).queryByText(t('providers.claude'))).toBeNull();
  });
});
