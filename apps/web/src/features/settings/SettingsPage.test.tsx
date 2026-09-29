import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { SettingsPage } from './SettingsPage';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

async function editSection(section: 'project' | 'limits' | 'pipeline') {
  const region = await screen.findByRole('region', { name: t(`settings.sections.${section}`) });
  fireEvent.click(within(region).getByRole('button', { name: t('memberEdit.edit') }));
  return within(region);
}
function selectMembers(select: HTMLElement, handles: string[]) {
  for (const option of (select as HTMLSelectElement).options)
    option.selected = handles.includes(option.value);
  fireEvent.change(select);
}

describe('settings section editors', () => {
  it('edits project fields, cancels drafts and permits one active section', async () => {
    const project = mockProject();
    project.render(<SettingsPage />);
    const initial = structuredClone(project.backend.config);
    let section = await editSection('project');
    fireEvent.change(section.getByLabelText(t('settings.project.name')), {
      target: { value: 'Cancelled edit' },
    });
    expect(
      screen
        .getAllByRole('button', { name: t('memberEdit.edit') })
        .every((button) => (button as HTMLButtonElement).disabled),
    ).toBe(true);
    fireEvent.click(section.getByRole('button', { name: t('common.cancel') }));
    expect(project.backend.config).toEqual(initial);
    expect(project.requests.some((request) => request.method === 'PATCH')).toBe(false);
    section = await editSection('project');
    expect((section.getByLabelText(t('settings.project.name')) as HTMLInputElement).value).toBe(
      initial.project.name,
    );
    fireEvent.change(section.getByLabelText(t('settings.project.name')), {
      target: { value: 'Acme webshop' },
    });
    fireEvent.change(section.getByLabelText(t('settings.project.language')), { target: { value: 'en' } });
    fireEvent.change(section.getByLabelText(t('settings.project.timezone')), { target: { value: 'UTC' } });
    fireEvent.click(section.getByRole('button', { name: t('memberEdit.save') }));
    await waitFor(() => expect(section.queryByRole('button', { name: t('memberEdit.save') })).toBeNull());
    expect(project.backend.config.project).toEqual({
      ...initial.project,
      name: 'Acme webshop',
      language: 'en',
      timezone: 'UTC',
    });
    expect(project.requests.find((request) => request.method === 'PATCH')?.body).toEqual({
      baseVersion: 'c3f9a21',
      project: { name: 'Acme webshop', language: 'en', timezone: 'UTC' },
    });
    expect(project.backend.history[0]?.message).toBe('Update project');
  });

  it('edits limits with a 10–100 slider and AI-capable role choices', async () => {
    const project = mockProject();
    project.render(<SettingsPage />);
    const section = await editSection('limits');
    await waitFor(() =>
      expect(
        section.getByLabelText(t('settings.team.role')).querySelectorAll('option').length,
      ).toBeGreaterThan(0),
    );
    const role = section.getByLabelText(t('settings.team.role')) as HTMLSelectElement;
    expect(Array.from(role.options, (option) => option.value)).not.toContain('operator');
    expect(Array.from(role.options, (option) => option.value)).not.toContain('product_owner');
    const slider = section.getByRole('slider') as HTMLInputElement;
    expect([slider.min, slider.max]).toEqual(['10', '100']);
    fireEvent.change(section.getByLabelText(t('settings.limits.maxConcurrentAi')), {
      target: { value: '2' },
    });
    fireEvent.change(slider, { target: { value: '60' } });
    fireEvent.click(section.getByRole('checkbox', { name: t('settings.limits.tempWorkers') }));
    fireEvent.change(section.getByLabelText(t('settings.edit.tempMax')), { target: { value: '3' } });
    fireEvent.change(role, { target: { value: 'qa' } });
    fireEvent.click(section.getByRole('button', { name: t('memberEdit.save') }));
    await waitFor(() => expect(section.queryByRole('button', { name: t('memberEdit.save') })).toBeNull());
    expect(project.backend.config.team.limits).toEqual({
      maxConcurrentAi: 2,
      pauseAbovePlanUsagePercent: 60,
      tempWorkers: { enabled: true, max: 3, role: 'qa' },
    });
  });

  it('renames, describes, reorders stages and edits owners and all gate condition types', async () => {
    const project = mockProject();
    project.render(<SettingsPage />);
    const initialStageCount = project.backend.config.pipeline.stages.length;
    const section = await editSection('pipeline');
    const stage = within(section.getAllByRole('listitem')[1]!);
    fireEvent.change(stage.getByLabelText(t('settings.project.name')), { target: { value: 'Acme build' } });
    fireEvent.change(stage.getByLabelText(t('settings.edit.description')), {
      target: { value: 'Implement Acme checkout.' },
    });
    selectMembers(stage.getByLabelText(t('settings.pipeline.owners')), ['owner', 'qa']);
    fireEvent.click(stage.getByRole('button', { name: t('settings.edit.addCondition') }));
    fireEvent.change(stage.getByLabelText(t('settings.edit.check')), { target: { value: 'qa' } });
    fireEvent.click(stage.getByRole('button', { name: t('settings.edit.addCondition') }));
    fireEvent.change(stage.getAllByLabelText(t('settings.edit.condition'))[1]!, {
      target: { value: 'pr_merged' },
    });
    fireEvent.click(stage.getByRole('button', { name: t('settings.edit.addCondition') }));
    fireEvent.change(stage.getAllByLabelText(t('settings.edit.condition'))[2]!, {
      target: { value: 'human_approval' },
    });
    const approvers = stage.getByLabelText(t('settings.edit.approvers')) as HTMLSelectElement;
    expect(Array.from(approvers.options, (option) => option.value)).toEqual(['owner', 'kata', 'bence']);
    selectMembers(approvers, ['owner', 'kata']);
    fireEvent.click(stage.getByRole('button', { name: t('settings.edit.moveDown') }));
    fireEvent.click(section.getByRole('button', { name: t('memberEdit.save') }));
    await waitFor(() => expect(section.queryByRole('button', { name: t('memberEdit.save') })).toBeNull());
    expect(project.backend.config.pipeline.stages).toHaveLength(initialStageCount);
    expect(project.backend.config.pipeline.stages[2]).toMatchObject({
      id: 'dev',
      kind: 'work',
      name: 'Acme build',
      description: 'Implement Acme checkout.',
      owners: ['owner', 'qa'],
      gate: {
        conditions: [
          { type: 'check_passed', check: 'qa' },
          { type: 'pr_merged' },
          { type: 'human_approval', approvers: ['owner', 'kata'] },
        ],
      },
    });
    expect(section.getByText('Implement Acme checkout.')).toBeTruthy();
  });

  it('locks human approval fields and removal for admins while allowing other gate edits', async () => {
    const project = mockProject();
    const admin = project.backend.config.team.members.find((member) => member.handle === 'kata')!;
    if (admin.kind === 'human') admin.access = 'admin';
    project.backend.viewerHandle = 'kata';
    project.render(<SettingsPage />, '/', { isOwner: false, myHandle: 'kata' });
    const section = await editSection('pipeline');
    const approvers = section.getByLabelText(t('settings.edit.approvers')) as HTMLSelectElement;
    expect(approvers.disabled).toBe(true);
    const condition = within(approvers.closest('div')!);
    expect((condition.getByLabelText(t('settings.edit.condition')) as HTMLSelectElement).disabled).toBe(true);
    expect(
      (condition.getByRole('button', { name: t('settings.edit.removeCondition') }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(section.getByText(t('settings.edit.approversOwnerOnly'))).toBeTruthy();
    const checks = section.getAllByLabelText(t('settings.edit.check'));
    fireEvent.change(checks[0]!, { target: { value: 'security_review' } });
    fireEvent.click(section.getByRole('button', { name: t('memberEdit.save') }));
    await waitFor(() => expect(section.queryByRole('button', { name: t('memberEdit.save') })).toBeNull());
    expect(
      project.backend.config.pipeline.stages.find((stage) => stage.id === 'integration')?.gate?.conditions[0],
    ).toEqual({ type: 'check_passed', check: 'security_review' });
  });

  it('shows a conflict and reloads the latest version before retrying', async () => {
    const project = mockProject();
    project.render(<SettingsPage />);
    const section = await editSection('project');
    fireEvent.change(section.getByLabelText(t('settings.project.name')), {
      target: { value: 'Stale draft' },
    });
    project.backend.handle('PATCH', '/api/projects/AC/config', {
      baseVersion: project.backend.configVersion,
      project: { name: 'Latest Acme' },
    });
    const latestVersion = project.backend.configVersion;
    fireEvent.click(section.getByRole('button', { name: t('memberEdit.save') }));
    expect((await section.findByRole('alert')).textContent).toContain(t('settings.edit.conflict'));
    expect(project.backend.config.project.name).toBe('Latest Acme');
    fireEvent.click(section.getByRole('button', { name: t('settings.edit.reload') }));
    await waitFor(() =>
      expect((section.getByLabelText(t('settings.project.name')) as HTMLInputElement).value).toBe(
        'Latest Acme',
      ),
    );
    expect(section.queryByRole('alert')).toBeNull();
    fireEvent.change(section.getByLabelText(t('settings.project.name')), {
      target: { value: 'Updated Acme' },
    });
    fireEvent.click(section.getByRole('button', { name: t('memberEdit.save') }));
    await waitFor(() => expect(section.queryByRole('button', { name: t('memberEdit.save') })).toBeNull());
    expect(project.requests.filter((request) => request.method === 'PATCH')[1]?.body).toMatchObject({
      baseVersion: latestVersion,
    });
  });

  it('shows translated invariant issues beside the edited section', async () => {
    const project = mockProject();
    project.render(<SettingsPage />);
    const section = await editSection('pipeline');
    fireEvent.click(
      within(section.getAllByRole('listitem')[0]!).getByRole('button', { name: t('settings.edit.moveDown') }),
    );
    fireEvent.click(section.getByRole('button', { name: t('memberEdit.save') }));
    expect((await section.findByRole('alert')).textContent).toContain(
      t('settings.issues.first_stage_not_queue'),
    );
    expect(project.backend.config.pipeline.stages[0]?.kind).toBe('queue');
  });

  it.each(['client', 'viewer'] as const)('hides edit buttons for %s access', async (access) => {
    const project = mockProject();
    const member = project.backend.config.team.members.find((member) => member.handle === 'owner')!;
    if (member.kind === 'human') member.access = access;
    project.render(<SettingsPage />, '/', {
      isOwner: false,
      can: { manageTeam: false, createTasks: false, workInSessions: false },
    });
    await screen.findByRole('region', { name: t('settings.sections.project') });
    expect(screen.queryByRole('button', { name: t('memberEdit.edit') })).toBeNull();
  });
});
