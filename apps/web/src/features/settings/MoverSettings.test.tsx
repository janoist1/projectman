import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { PatchConfigRequest } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import type { MockRequest } from '../../test/mockProject';
import { SettingsTestRoutes } from './testRoutes';

/** "Who moves the cards on" in the settings: saves as it changes, and says why a choice is refused (PM-439). */

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

function lastConfigPatch(requests: readonly MockRequest[]): PatchConfigRequest {
  const patch = requests.filter((r) => r.method === 'PATCH' && r.path === '/api/projects/AC/config').at(-1);
  if (!patch) throw new Error('No configuration PATCH was sent');
  return patch.body as PatchConfigRequest;
}

const moverGroup = async () => {
  const section = within(await screen.findByRole('region', { name: t('settings.sections.team') }));
  return within(await section.findByRole('region', { name: t('settings.team.mover.label') }));
};

const choice = (group: ReturnType<typeof within>, kind: 'worker' | 'project_manager' | 'human') =>
  group.getByRole('radio', { name: new RegExp(t(`settings.team.mover.${kind}.title`)) }) as HTMLInputElement;

describe('the card mover in the settings (PM-439)', () => {
  it('shows the default PM queue moves and saves the start-only choice', async () => {
    const project = mockProject();
    project.render(<SettingsTestRoutes initialSection="team" />);
    const select = await screen.findByRole('combobox', {
      name: t('settings.team.projectManagerMoves.label'),
    });
    expect((select as HTMLSelectElement).value).toBe('queues_and_start');
    fireEvent.change(select, { target: { value: 'start_only' } });
    await waitFor(() => expect(project.backend.config.team.projectManagerMoves).toBe('start_only'));
    expect(lastConfigPatch(project.requests).projectManagerMoves).toBe('start_only');
  });

  it('shows PM moves without editing controls to members who cannot manage the team', async () => {
    const project = mockProject();
    project.backend.config.team.projectManagerMoves = 'start_only';
    project.render(<SettingsTestRoutes initialSection="team" />, '/', { can: { manageTeam: false } });
    const group = within(
      await screen.findByRole('region', { name: t('settings.team.projectManagerMoves.title') }),
    );
    expect(group.queryByRole('combobox')).toBeNull();
    expect(group.getByText(t('settings.team.projectManagerMoves.start_only'))).toBeTruthy();
  });

  it('shows the project manager as the default priority setter, and saves a ticked duty at once (PM-1096)', async () => {
    const project = mockProject();
    project.render(<SettingsTestRoutes initialSection="team" />);
    const group = within(await screen.findByRole('region', { name: t('settings.team.priority.label') }));
    const manager = group.getByRole('checkbox', {
      name: t('settings.team.priority.project_manager'),
    }) as HTMLInputElement;
    const duty = group.getByRole('checkbox', {
      name: new RegExp(t('dutyNames.prioritization')),
    }) as HTMLInputElement;
    expect(manager.checked).toBe(true);
    expect(duty.checked).toBe(false);
    fireEvent.click(duty);
    await waitFor(() =>
      expect(project.backend.config.team.prioritySetters).toEqual(['project_manager', 'prioritization_duty']),
    );
    expect(lastConfigPatch(project.requests).prioritySetters).toEqual([
      'project_manager',
      'prioritization_duty',
    ]);
    // The ticks wait while a save runs; an unticked pair is the humans-only setting, saved as [].
    await waitFor(() => expect(manager.closest('fieldset')!.disabled).toBe(false));
    fireEvent.click(manager);
    await waitFor(() => expect(project.backend.config.team.prioritySetters).toEqual(['prioritization_duty']));
    await waitFor(() => expect(manager.closest('fieldset')!.disabled).toBe(false));
    fireEvent.click(duty);
    await waitFor(() => expect(project.backend.config.team.prioritySetters).toEqual([]));
    expect(await group.findByText(t('settings.team.priority.humansOnly'))).toBeTruthy();
  });

  it('only tells a member who may not manage the team who may set priorities (PM-1096)', async () => {
    const project = mockProject();
    project.render(<SettingsTestRoutes initialSection="team" />, '/', { can: { manageTeam: false } });
    const group = within(await screen.findByRole('region', { name: t('settings.team.priority.label') }));
    expect(group.queryByRole('checkbox')).toBeNull();
    expect(
      group.getByText(new RegExp(t('settings.team.priority.value.with', { names: '' }).trim())),
    ).toBeTruthy();
  });

  it('shows the worker as the default, and saves another choice at once', async () => {
    const project = mockProject();
    project.render(<SettingsTestRoutes initialSection="team" />);
    const group = await moverGroup();
    expect(choice(group, 'worker').checked).toBe(true);
    expect(group.queryByLabelText(t('settings.team.mover.who'))).toBeNull();
    fireEvent.click(choice(group, 'project_manager'));
    await waitFor(() => expect(project.backend.config.team.cardMover).toEqual({ kind: 'project_manager' }));
    expect(lastConfigPatch(project.requests).cardMover).toEqual({ kind: 'project_manager' });
  });

  it('asks who the one person is, and saves the handle', async () => {
    const project = mockProject();
    project.render(<SettingsTestRoutes initialSection="team" />);
    const group = await moverGroup();
    fireEvent.click(choice(group, 'human'));
    const who = (await group.findByLabelText(t('settings.team.mover.who'))) as HTMLSelectElement;
    expect(who.value).toBe('owner');
    await waitFor(() =>
      expect(project.backend.config.team.cardMover).toEqual({ kind: 'human', handle: 'owner' }),
    );
  });

  it('shows a saved person who cannot move cards as an error under the field', async () => {
    const project = mockProject();
    project.backend.config.team.cardMover = { kind: 'human', handle: 'kata' };
    project.render(<SettingsTestRoutes initialSection="team" />);
    const group = await moverGroup();
    expect(await group.findByText(t('settings.team.mover.cannotMove', { name: 'Kata' }))).toBeTruthy();
  });

  it('says why a refused choice was refused, and keeps the saved one', async () => {
    const project = mockProject();
    const config = project.backend.config;
    config.team.members = config.team.members.filter((member) => member.handle !== 'pm');
    project.render(<SettingsTestRoutes initialSection="team" />);
    const group = await moverGroup();
    fireEvent.click(choice(group, 'project_manager'));
    const refusal = await group.findByRole('alert');
    expect(refusal.textContent).toBe(
      t('settings.team.mover.cannotMove', { name: t('settings.team.mover.project_manager.title') }),
    );
    expect(project.backend.config.team.cardMover).toBeUndefined();
    await waitFor(() => expect(choice(group, 'worker').checked).toBe(true));
  });

  it('only tells a member who may not manage the team who moves the cards', async () => {
    const project = mockProject();
    project.render(<SettingsTestRoutes initialSection="team" />, '/', { can: { manageTeam: false } });
    const group = await moverGroup();
    expect(group.queryByRole('radio')).toBeNull();
    expect(group.getByText(t('settings.team.mover.value.worker'))).toBeTruthy();
  });
});
