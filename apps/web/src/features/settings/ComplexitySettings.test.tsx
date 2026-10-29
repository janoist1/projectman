import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { PatchConfigRequest } from '@projectman/shared';
import { getLocale } from '@projectman/templates';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import type { MockRequest } from '../../test/mockProject';
import { SettingsTestRoutes } from './testRoutes';

/** "Who may set complexity" in the settings: the duties are chosen in a folded list and save at once (PM-1097). */

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

function lastConfigPatch(requests: readonly MockRequest[]): PatchConfigRequest {
  const patch = requests.filter((r) => r.method === 'PATCH' && r.path === '/api/projects/AC/config').at(-1);
  if (!patch) throw new Error('No configuration PATCH was sent');
  return patch.body as PatchConfigRequest;
}

const complexityGroup = async () => {
  const section = within(await screen.findByRole('region', { name: t('settings.sections.team') }));
  return within(await section.findByRole('region', { name: t('settings.team.complexity.label') }));
};

describe('complexity setters in the settings (PM-1097)', () => {
  it('saves a duty ticked in the list at once, in the duty order', async () => {
    const project = mockProject();
    project.render(<SettingsTestRoutes initialSection="team" />);
    const group = await complexityGroup();
    fireEvent.click(group.getByText(t('settings.team.complexity.choose')));
    const name = getLocale(project.backend.config.project.language).duties.implementation.name;
    fireEvent.click(await group.findByRole('checkbox', { name }));
    const expected = ['requirements_analysis', 'task_breakdown', 'implementation'];
    await waitFor(() => expect(project.backend.config.team.complexitySetters).toEqual(expected));
    expect(lastConfigPatch(project.requests).complexitySetters).toEqual(expected);
  });

  it('saves the assignee-fit switch at once, and only tells a member who may not manage the team', async () => {
    const project = mockProject();
    const view = project.render(<SettingsTestRoutes initialSection="team" />);
    const section = within(await screen.findByRole('region', { name: t('settings.sections.team') }));
    const group = within(await section.findByRole('region', { name: t('settings.team.assigneeFit.label') }));
    fireEvent.click(group.getByRole('checkbox'));
    await waitFor(() => expect(project.backend.config.team.assigneeFit).toBe('automatic_and_ai'));
    expect(lastConfigPatch(project.requests).assigneeFit).toBe('automatic_and_ai');
    view.unmount();
    project.render(<SettingsTestRoutes initialSection="team" />, '/', { can: { manageTeam: false } });
    const readOnly = within(
      await within(await screen.findByRole('region', { name: t('settings.sections.team') })).findByRole(
        'region',
        { name: t('settings.team.assigneeFit.label') },
      ),
    );
    expect(readOnly.queryByRole('checkbox')).toBeNull();
    expect(readOnly.getByText(t('settings.team.assigneeFit.value.automaticAndAi'))).toBeTruthy();
  });

  it('only tells a member who may not manage the team who may set complexity', async () => {
    const project = mockProject();
    project.render(<SettingsTestRoutes initialSection="team" />, '/', { can: { manageTeam: false } });
    const group = await complexityGroup();
    expect(group.queryByRole('checkbox')).toBeNull();
    expect(group.getByText(t('settings.team.complexity.readOnlyLabel'))).toBeTruthy();
  });
});
