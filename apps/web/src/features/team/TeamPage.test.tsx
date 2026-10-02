import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { getLocale } from '@projectman/templates';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n/t';
import { setFetchImplementation } from '../../api/client';
import { mockProject } from '../../test/mockProject';
import { TeamPage } from './TeamPage';

const roleNames = getLocale('hu').roles;

/** Opens the "⋯" menu of a member's row or card. */
function openMenu(row: HTMLElement, name: string) {
  fireEvent.click(within(row).getByRole('button', { name: t('team.moreFor', { name }) }));
}

function phone(mobile: boolean) {
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
}

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

  it.each([false, true])('says on every member when to turn to them (mobile: %s)', async (mobile) => {
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
    project.backend.config.team.roleOverrides = {
      devops: { duties: ['deployment', 'monitoring'], instructions: '', whenToAsk: 'Ha élesíteni kell.' },
    };
    project.render(<TeamPage />);
    const line = (text: string) => `${t('roleCatalogue.whenToAsk')}: ${text}`;
    const roster = within(await screen.findByRole('region', { name: t('team.roster') }));
    expect(await roster.findByText(line('Ha élesíteni kell.'))).toBeTruthy();
    expect(roster.getByText(line(roleNames.qa.whenToAsk))).toBeTruthy();
    expect(
      roster.getByText(line(`${roleNames.operator.whenToAsk} ${roleNames.product_owner.whenToAsk}`)),
    ).toBeTruthy();
    const holders = project.backend.config.team.members.filter((m) => m.kind === 'ai' || m.roles.length > 0);
    expect(roster.getAllByText(new RegExp(`^${t('roleCatalogue.whenToAsk')}: `))).toHaveLength(
      holders.length,
    );
  });

  it('sends an AI member on leave and calls it back from the roster (decision 23)', async () => {
    const project = mockProject();
    project.render(<TeamPage />);
    const name = project.backend.members.find((member) => member.handle === 'fe-1')!.displayName;
    const row = (await screen.findByRole('link', { name })).closest('tr')!;
    expect(within(row).queryByText(t('leave.onLeave'))).toBeNull();
    expect(within(row).queryByRole('button', { name: t('leave.sendMember', { name }) })).toBeNull();

    openMenu(row, name);
    fireEvent.click(within(row).getByRole('button', { name: t('leave.sendMember', { name }) }));
    await within(row).findByText(t('leave.onLeave'));
    expect(
      project.requests.find((request) => request.method === 'PATCH' && request.path.endsWith('/members/fe-1'))
        ?.body,
    ).toEqual({ onLeave: true });

    openMenu(row, name);
    fireEvent.click(within(row).getByRole('button', { name: t('leave.callBackMember', { name }) }));
    await waitFor(() => expect(within(row).queryByText(t('leave.onLeave'))).toBeNull());
    expect(
      project.requests
        .filter((request) => request.method === 'PATCH' && request.path.endsWith('/members/fe-1'))
        .at(-1)?.body,
    ).toEqual({ onLeave: false });
    openMenu(row, name);
    expect(within(row).getByRole('button', { name: t('leave.sendMember', { name }) })).toBeTruthy();
  });

  it('offers no leave for humans, and not to those who cannot manage the team', async () => {
    const project = mockProject();
    project.render(<TeamPage />, '/', {
      can: { manageTeam: false, createTasks: true, workInSessions: true },
    });
    await screen.findByText(project.backend.members.find((member) => member.handle === 'fe-1')!.displayName);
    expect(screen.queryAllByText(t('leave.send'))).toHaveLength(0);
  });

  it('says there is no cap on concurrent AI sessions when the project names none', async () => {
    const project = mockProject();
    delete project.backend.config.team.limits.maxConcurrentAi;
    project.render(<TeamPage />);
    expect(
      await screen.findByText((text) => text.includes(t('settings.limits.noAiLimit').toLowerCase())),
    ).toBeTruthy();
  });

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
      openMenu(row, 'Fictional Colleague');
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

  it('keeps one main button; adding a colleague, by invitation link too, happens in one dialog', async () => {
    const project = mockProject();
    project.backend.handle('POST', '/api/projects/AC/invites', {
      email: 'colleague@acme.test',
      access: 'developer',
      roles: [],
    });
    project.render(<TeamPage />);
    await screen.findByRole('button', { name: t('team.hire') });
    const page = within(screen.getByRole('banner'));
    expect(page.getAllByRole('button').map((button) => button.textContent)).toEqual([
      t('team.hire'),
      t('addHuman.title'),
    ]);
    expect(screen.queryByRole('button', { name: t('invites.title') })).toBeNull();

    fireEvent.click(page.getByRole('button', { name: t('addHuman.title') }));
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByRole('button', { name: t('addHuman.modeDirect') }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    fireEvent.click(dialog.getByRole('button', { name: t('addHuman.modeInvite') }));
    fireEvent.change(dialog.getByLabelText(t('invites.email')), { target: { value: 'colleague@acme.test' } });
    fireEvent.click(await dialog.findByRole('button', { name: t('invites.create') }));
    expect(((await dialog.findByLabelText(t('invites.link'))) as HTMLInputElement).value).toContain(
      '/invite/',
    );
  });

  it.each([false, true])(
    'names the subscription only where it differs from the others (mobile: %s)',
    async (mobile) => {
      phone(mobile);
      const project = mockProject();
      project.render(<TeamPage />);
      const roster = within(await screen.findByRole('region', { name: t('team.roster') }));
      await roster.findByRole('link', { name: project.backend.findMember('qa')!.displayName });
      expect(roster.queryAllByText(t('team.sponsorYou'))).toHaveLength(0);
      expect(roster.queryByText(t('team.columns.subscription'))).toBeNull();
    },
  );

  it('marks the one member whose subscription differs from the others on a card', async () => {
    phone(true);
    const project = mockProject();
    project.backend.findMember('qa')!.sponsor = 'kata';
    project.render(<TeamPage />);
    const roster = within(await screen.findByRole('region', { name: t('team.roster') }));
    const qa = (
      await roster.findByRole('link', { name: project.backend.findMember('qa')!.displayName })
    ).closest('li')!;
    expect(within(qa).getByText(t('team.sponsorOther', { name: 'Kata' }))).toBeTruthy();
    expect(roster.queryAllByText(t('team.sponsorYou'))).toHaveLength(0);
    expect(roster.getAllByText(/előfizetése$/)).toHaveLength(1);
  });

  it('opens the profile from anywhere on a card, with the controls above the link', async () => {
    phone(true);
    const project = mockProject();
    project.render(<TeamPage />);
    const name = project.backend.findMember('fe-1')!.displayName;
    const card = (await screen.findByRole('link', { name })).closest('li')!;
    expect(within(card).getAllByRole('link', { name })).toHaveLength(1);
    expect(within(card).getByRole('link', { name }).getAttribute('href')).toBe('/p/AC/team/fe-1');
    expect(within(card).queryByRole('button', { name: /^Szerkesztés/ })).toBeNull();
    expect(within(card).getByRole('button', { name: t('team.moreFor', { name }) })).toBeTruthy();
  });

  it('retires an AI member from the menu', async () => {
    const project = mockProject();
    project.render(<TeamPage />);
    const name = project.backend.findMember('fe-1')!.displayName;
    const row = (await screen.findByRole('link', { name })).closest('tr')!;
    openMenu(row, name);
    fireEvent.click(
      within(row).getByRole('button', {
        name: t('team.retireMember', { name, handle: 'fe-1' }),
      }),
    );
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('keeps the role catalogue collapsed until it is opened', async () => {
    const project = mockProject();
    project.render(<TeamPage />);
    const title = await screen.findByRole('heading', { name: t('roleCatalogue.title') });
    const details = title.closest('details')!;
    expect(details.open).toBe(false);
    expect(title.closest('summary')).toBeTruthy();
  });

  it('gives empty scheduled runs and pending invitations no box of their own', async () => {
    const project = mockProject();
    project.render(<TeamPage />);
    await screen.findByRole('region', { name: t('team.roster') });
    await waitFor(() =>
      expect(project.requests.some((request) => request.path.endsWith('/invites'))).toBe(true),
    );
    expect(screen.queryByRole('heading', { name: t('schedules.title') })).toBeNull();
    expect(screen.queryByRole('heading', { name: t('invites.pending') })).toBeNull();
  });

  it('shows who a scheduled run is for by name, not by handle', async () => {
    const project = mockProject();
    const member = project.backend.config.team.members.find((m) => m.handle === 'fe-1')!;
    if (member.kind === 'ai') member.schedule = { cron: '0 9 * * *', prompt: 'Look around.' };
    project.render(<TeamPage />);
    fireEvent.click(await screen.findByRole('button', { name: t('schedules.runNow') }));
    const heading = await screen.findByRole('heading', { name: t('schedules.title') });
    const runs = within(heading.closest('section')!);
    expect(await runs.findByText(project.backend.findMember('fe-1')!.displayName)).toBeTruthy();
    expect(runs.queryByText('fe-1')).toBeNull();
  });

  it('shows every human responsibility next to access and one role for AI members', async () => {
    const project = mockProject();
    project.render(<TeamPage />);
    const owner = (await screen.findByText(t('common.you'))).closest('tr')!;
    expect(within(owner).getByText(t('roles.human.owner'))).toBeTruthy();
    await waitFor(() => expect(within(owner).getByText(roleNames.operator.name)).toBeTruthy());
    expect(within(owner).getByText(roleNames.product_owner.name)).toBeTruthy();
    const roster = within(screen.getByRole('region', { name: t('team.roster') }));
    const frontend = roster.getByText(project.backend.findMember('fe-1')!.displayName).closest('tr')!;
    expect(within(frontend).getByText(roleNames.developer.name)).toBeTruthy();
    const ownerName = project.backend.findMember('owner')!.displayName;
    expect(within(owner).queryByRole('button', { name: /^Szerkesztés/ })).toBeNull();
    openMenu(owner, ownerName);
    expect(
      within(owner).getByRole('button', { name: t('memberEdit.editMember', { name: ownerName }) }),
    ).toBeTruthy();
  });
  it('allows non-admins to see the catalogue without offering configuration changes', async () => {
    const project = mockProject();
    project.render(<TeamPage />, '/', {
      can: { createTasks: true, manageTeam: false, workInSessions: false },
    });
    await screen.findByRole('heading', { name: t('roleCatalogue.title') });
    await waitFor(() => expect(screen.getAllByText(roleNames.operator.name).length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: t('roleCatalogue.create') })).toBeNull();
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
    // The closed cards comparison below names the implementers too: look in the roster.
    const roster = within(await screen.findByRole('region', { name: t('team.roster') }));
    const claude = (await roster.findByText(project.backend.findMember('fe-1')!.displayName)).closest(
      mobile ? 'li' : 'tr',
    )!;
    const codex = roster
      .getByText(project.backend.findMember('be-1')!.displayName)
      .closest(mobile ? 'li' : 'tr')!;
    expect(within(claude).getByText(t('providers.claude'))).toBeTruthy();
    expect(within(codex).getByText(t('providers.codex'))).toBeTruthy();
    const human = screen.getByText(t('common.you')).closest(mobile ? 'li' : 'tr')!;
    expect(within(human).queryByText(t('providers.claude'))).toBeNull();
  });
});
