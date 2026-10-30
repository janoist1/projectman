import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { PatchConfigRequest, TaskCreateAccess } from '@projectman/shared';
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

  it('shows the prerequisite override off by default, and saves the ticked choice at once (PM-1099)', async () => {
    const project = mockProject();
    project.render(<SettingsTestRoutes initialSection="team" />);
    const group = within(
      await screen.findByRole('region', { name: t('settings.team.prerequisiteOverride.title') }),
    );
    const tick = group.getByRole('checkbox', {
      name: t('settings.team.prerequisiteOverride.project_manager'),
    }) as HTMLInputElement;
    expect(tick.checked).toBe(false);
    expect(group.getByText(t('settings.team.prerequisiteOverride.humansOnly'))).toBeTruthy();
    fireEvent.click(tick);
    await waitFor(() =>
      expect(project.backend.config.team.prerequisiteOverride).toBe('people_and_project_manager'),
    );
    expect(lastConfigPatch(project.requests).prerequisiteOverride).toBe('people_and_project_manager');
    await waitFor(() =>
      expect(group.queryByText(t('settings.team.prerequisiteOverride.humansOnly'))).toBeNull(),
    );
  });

  it('only tells a member who may not manage the team who may override a prerequisite (PM-1099)', async () => {
    const project = mockProject();
    project.backend.config.team.prerequisiteOverride = 'people_and_project_manager';
    project.render(<SettingsTestRoutes initialSection="team" />, '/', { can: { manageTeam: false } });
    const group = within(
      await screen.findByRole('region', { name: t('settings.team.prerequisiteOverride.title') }),
    );
    expect(group.queryByRole('checkbox')).toBeNull();
    expect(
      group.getByText(t('settings.team.prerequisiteOverride.value.people_and_project_manager')),
    ).toBeTruthy();
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

  it('shows the developer as the default new card access, and saves the owner’s choice at once (PM-1100)', async () => {
    const project = mockProject();
    project.render(<SettingsTestRoutes initialSection="team" />);
    const group = within(await screen.findByRole('region', { name: t('settings.team.taskCreate.title') }));
    const radio = (access: TaskCreateAccess) =>
      group.getByRole('radio', {
        name: new RegExp(t(`settings.team.taskCreate.options.${access}`)),
      }) as HTMLInputElement;
    expect(radio('developer').checked).toBe(true);
    fireEvent.click(radio('client'));
    await waitFor(() => expect(project.backend.config.team.taskCreateAccess).toBe('client'));
    expect(lastConfigPatch(project.requests).taskCreateAccess).toBe('client');
  });

  it('tells an admin who may open new cards, and that only the owner changes it (PM-1100)', async () => {
    const project = mockProject();
    project.backend.config.team.taskCreateAccess = 'admin';
    project.render(<SettingsTestRoutes initialSection="team" />, '/', {
      isOwner: false,
      can: { manageTeam: true },
    });
    const group = within(await screen.findByRole('region', { name: t('settings.team.taskCreate.title') }));
    expect(group.queryByRole('radio')).toBeNull();
    expect(group.getByText(t('settings.team.taskCreate.options.admin'))).toBeTruthy();
    expect(group.getByText(t('settings.team.taskCreate.ownerOnly'))).toBeTruthy();
  });

  it('shows assigning and cancelling as the default PM lifecycle actions, and saves a ticked reopen at once (PM-1098)', async () => {
    const project = mockProject();
    project.render(<SettingsTestRoutes initialSection="team" />);
    const group = within(
      await screen.findByRole('region', { name: t('settings.team.projectManagerLifecycle.label') }),
    );
    const box = (action: 'assign' | 'cancel' | 'reopen') =>
      group.getByRole('checkbox', {
        name: new RegExp(t(`settings.team.projectManagerLifecycle.${action}`)),
      }) as HTMLInputElement;
    expect([box('assign').checked, box('cancel').checked, box('reopen').checked]).toEqual([
      true,
      true,
      false,
    ]);
    fireEvent.click(box('reopen'));
    await waitFor(() =>
      expect(project.backend.config.team.projectManagerLifecycle).toEqual(['assign', 'cancel', 'reopen']),
    );
    expect(lastConfigPatch(project.requests).projectManagerLifecycle).toEqual(['assign', 'cancel', 'reopen']);
    // Unticking all three is the admins-only setting, saved as [] and not left out of the patch.
    for (const action of ['assign', 'cancel', 'reopen'] as const) {
      await waitFor(() => expect(box(action).closest('fieldset')!.disabled).toBe(false));
      fireEvent.click(box(action));
    }
    await waitFor(() => expect(project.backend.config.team.projectManagerLifecycle).toEqual([]));
    expect(await group.findByText(t('settings.team.projectManagerLifecycle.adminsOnly'))).toBeTruthy();
  });

  it('only tells a member who may not manage the team what the project manager may do with cards (PM-1098)', async () => {
    const project = mockProject();
    project.render(<SettingsTestRoutes initialSection="team" />, '/', { can: { manageTeam: false } });
    const group = within(
      await screen.findByRole('region', { name: t('settings.team.projectManagerLifecycle.label') }),
    );
    expect(group.queryByRole('checkbox')).toBeNull();
    expect(group.getByText(t('settings.team.projectManagerLifecycle.cancel'))).toBeTruthy();
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
