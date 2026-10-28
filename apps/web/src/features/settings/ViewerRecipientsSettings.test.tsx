import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { PatchConfigRequest } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { SettingsTestRoutes } from './testRoutes';

/** "Whom may the viewer write to" in the settings: saves as it changes, and says when no one is left (PM-1102). */

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

const contactsGroup = async () =>
  within(await screen.findByRole('region', { name: t('settings.team.contacts.label') }));

describe('whom the viewer may write to, in the settings (PM-1102)', () => {
  it('shows the project manager only by default, and saves the contacts choice at once', async () => {
    const project = mockProject();
    project.render(<SettingsTestRoutes initialSection="team" />);
    const select = (await (
      await contactsGroup()
    ).findByRole('combobox', {
      name: t('settings.team.viewerRecipients.label'),
    })) as HTMLSelectElement;
    expect(select.value).toBe('project_manager');
    fireEvent.change(select, { target: { value: 'contacts' } });
    await waitFor(() => expect(project.backend.config.team.viewerRecipients).toBe('contacts'));
    const patch = project.requests.filter(
      (r) => r.method === 'PATCH' && r.path === '/api/projects/AC/config',
    );
    expect((patch.at(-1)!.body as PatchConfigRequest).viewerRecipients).toBe('contacts');
  });

  it('warns that the viewer can write to no one when the contacts mode has no contact', async () => {
    const project = mockProject();
    project.backend.config.team.viewerRecipients = 'contacts';
    project.backend.config.team.contacts = [];
    project.render(<SettingsTestRoutes initialSection="team" />);
    const group = await contactsGroup();
    expect((await group.findByRole('status')).textContent).toBe(
      t('settings.team.viewerRecipients.noContacts'),
    );
  });

  it('shows the setting as a fact, without a selector, to a member who cannot manage the team', async () => {
    const project = mockProject();
    project.backend.config.team.viewerRecipients = 'contacts';
    project.render(<SettingsTestRoutes initialSection="team" />, '/', { can: { manageTeam: false } });
    const group = await contactsGroup();
    expect(await group.findByText(t('settings.team.viewerRecipients.contacts'))).toBeTruthy();
    expect(group.queryByRole('combobox')).toBeNull();
  });
});
