import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { SettingsPage } from './SettingsPage';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

async function editSection(section: 'project' | 'limits' | 'pipeline' | 'labels') {
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
    fireEvent.change(stage.getByLabelText(t('settings.edit.label')), { target: { value: 'qa-ok' } });
    fireEvent.click(stage.getByRole('button', { name: t('settings.edit.addCondition') }));
    fireEvent.change(stage.getAllByLabelText(t('settings.edit.condition'))[1]!, {
      target: { value: 'lacks_label' },
    });
    fireEvent.change(stage.getAllByLabelText(t('settings.edit.label'))[1]!, {
      target: { value: 'waiting-answer' },
    });
    fireEvent.click(stage.getByRole('button', { name: t('settings.edit.addCondition') }));
    fireEvent.change(stage.getAllByLabelText(t('settings.edit.label'))[2]!, {
      target: { value: 'release-approved' },
    });
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
          { type: 'has_label', label: 'qa-ok' },
          { type: 'lacks_label', label: 'waiting-answer' },
          { type: 'has_label', label: 'release-approved' },
        ],
      },
    });
    expect(section.getByText('Implement Acme checkout.')).toBeTruthy();
  });

  it('gives a tag in use a meaning and rules, and keeps approvals for the owner', async () => {
    const project = mockProject();
    project.backend.findTask('AC-20')!.labels.push('Sürgős');
    project.render(<SettingsPage />);
    const section = await editSection('labels');
    const row = within(section.getByText('Sürgős').closest('div')!);
    fireEvent.click(row.getByRole('button', { name: t('settings.labels.define') }));
    fireEvent.change(section.getByLabelText(t('settings.labels.meaning')), { target: { value: 'Ma kell.' } });
    fireEvent.change(section.getByLabelText(t('settings.labels.color')), { target: { value: 'red' } });
    fireEvent.click(section.getByLabelText(t('settings.labels.blocks')));
    fireEvent.click(section.getByRole('button', { name: t('memberEdit.save') }));
    await waitFor(() => expect(section.queryByRole('button', { name: t('memberEdit.save') })).toBeNull());
    expect(project.backend.config.pipeline.labels.find((label) => label.id === 'Sürgős')).toEqual({
      id: 'Sürgős',
      name: 'Sürgős',
      color: 'red',
      meaning: 'Ma kell.',
      setBy: 'anyone',
      blocks: true,
    });
  });

  it('locks human approval fields and removal for admins while allowing other gate edits', async () => {
    const project = mockProject();
    const admin = project.backend.config.team.members.find((member) => member.handle === 'kata')!;
    if (admin.kind === 'human') admin.access = 'admin';
    project.backend.viewerHandle = 'kata';
    project.render(<SettingsPage />, '/', { isOwner: false, myHandle: 'kata' });
    const section = await editSection('pipeline');
    // The release approval is a label only humans may set: locked for an admin.
    const condition = within(section.getByText(t('settings.edit.approvalOwnerOnly')).closest('div')!);
    expect((condition.getByLabelText(t('settings.edit.condition')) as HTMLSelectElement).disabled).toBe(true);
    expect((condition.getByLabelText(t('settings.edit.label')) as HTMLSelectElement).disabled).toBe(true);
    expect(
      (condition.getByRole('button', { name: t('settings.edit.removeCondition') }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    const labels = section.getAllByLabelText(t('settings.edit.label'));
    fireEvent.change(labels[0]!, { target: { value: 'qa-ok' } });
    fireEvent.click(section.getByRole('button', { name: t('memberEdit.save') }));
    await waitFor(() => expect(section.queryByRole('button', { name: t('memberEdit.save') })).toBeNull());
    expect(
      project.backend.config.pipeline.stages.find((stage) => stage.id === 'integration')?.gate?.conditions[0],
    ).toEqual({ type: 'has_label', label: 'qa-ok' });
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
    expect((await within(section.getAllByRole('listitem')[0]!).findByRole('alert')).textContent).toContain(
      t('settings.issues.first_stage_not_queue'),
    );
    expect(project.backend.config.pipeline.stages[0]?.kind).toBe('queue');
  });

  it('adds a stage after the chosen stage with a duty, a column and no gate', async () => {
    const project = mockProject();
    project.render(<SettingsPage />);
    const section = await editSection('pipeline');
    const initial = structuredClone(project.backend.config.pipeline);
    fireEvent.click(section.getByRole('button', { name: t('settings.pipeline.addStage') }));
    const form = within(section.getByRole('group', { name: t('settings.pipeline.addStage') }));
    expect(
      (form.getByRole('button', { name: t('settings.pipeline.createStage') }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(form.getByLabelText(t('settings.project.name')), { target: { value: 'Acme review' } });
    fireEvent.change(form.getByLabelText(t('settings.pipeline.kindLabel')), { target: { value: 'review' } });
    expect(form.getByText(t('settings.pipeline.kindHelp.review'), { selector: 'p' })).toBeTruthy();
    fireEvent.change(form.getByLabelText(t('settings.pipeline.afterStage')), { target: { value: 'dev' } });
    fireEvent.change(form.getByLabelText(t('settings.pipeline.column')), { target: { value: 'review' } });
    fireEvent.change(form.getByLabelText(t('duties.duty')), { target: { value: 'code_review' } });
    fireEvent.change(form.getByLabelText(t('settings.edit.description')), {
      target: { value: 'Review the Acme checkout.' },
    });
    fireEvent.click(form.getByRole('button', { name: t('settings.pipeline.createStage') }));
    expect(section.queryByRole('group', { name: t('settings.pipeline.addStage') })).toBeNull();
    const stage = within(section.getByRole('listitem', { name: 'Acme review' }));
    expect(stage.queryByLabelText(t('settings.edit.condition'))).toBeNull();
    fireEvent.click(section.getByRole('button', { name: t('memberEdit.save') }));
    await waitFor(() => expect(section.queryByRole('button', { name: t('memberEdit.save') })).toBeNull());
    const added = project.backend.config.pipeline.stages[2];
    expect(added).toEqual({
      id: 'acme_review',
      name: 'Acme review',
      kind: 'review',
      columnId: 'review',
      duty: 'code_review',
      description: 'Review the Acme checkout.',
    });
    expect(project.requests.find((request) => request.method === 'PATCH')?.body).toMatchObject({
      baseVersion: 'c3f9a21',
      pipeline: { columns: initial.columns },
    });
  });

  it('generates unique bounded stage IDs and supports explicit owners and gates on new stages', async () => {
    const project = mockProject();
    project.render(<SettingsPage />);
    const section = await editSection('pipeline');
    const name = 'Acme quality verification with an exceptionally long name';
    for (let index = 0; index < 2; index++) {
      fireEvent.click(section.getByRole('button', { name: t('settings.pipeline.addStage') }));
      const form = within(section.getByRole('group', { name: t('settings.pipeline.addStage') }));
      fireEvent.change(form.getByLabelText(t('settings.project.name')), { target: { value: name } });
      fireEvent.change(form.getByLabelText(t('duties.duty')), { target: { value: '' } });
      selectMembers(form.getByLabelText(t('settings.pipeline.owners')), ['owner', 'qa']);
      if (index === 0) fireEvent.keyDown(form.getByLabelText(t('settings.project.name')), { key: 'Enter' });
      else fireEvent.click(form.getByRole('button', { name: t('settings.pipeline.createStage') }));
    }
    expect(project.requests.some((request) => request.method === 'PATCH')).toBe(false);
    const stage = within(section.getAllByRole('listitem', { name })[0]!);
    fireEvent.click(stage.getByRole('button', { name: t('settings.edit.addCondition') }));
    fireEvent.change(stage.getByLabelText(t('settings.edit.label')), { target: { value: 'qa-ok' } });
    fireEvent.click(section.getByRole('button', { name: t('memberEdit.save') }));
    await waitFor(() => expect(section.queryByRole('button', { name: t('memberEdit.save') })).toBeNull());
    const added = project.backend.config.pipeline.stages.filter((stage) => stage.name === name);
    expect(new Set(added.map((stage) => stage.id)).size).toBe(2);
    for (const stage of added) {
      expect(stage.id).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
      expect(stage.owners).toEqual(['owner', 'qa']);
      expect(stage.duty).toBeUndefined();
    }
    expect(added[0]?.gate).toEqual({ conditions: [{ type: 'has_label', label: 'qa-ok' }] });
  });

  it('confirms stage removal and cancels it before saving an unoccupied stage removal', async () => {
    const project = mockProject();
    project.backend.tasks = [];
    project.render(<SettingsPage />);
    const section = await editSection('pipeline');
    const name = project.backend.config.pipeline.stages[1]!.name;
    const stage = within(section.getByRole('listitem', { name }));
    fireEvent.click(stage.getByRole('button', { name: t('settings.pipeline.removeStage') }));
    let dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText(t('settings.pipeline.removeTitle', { stage: name }))).toBeTruthy();
    fireEvent.click(dialog.getByRole('button', { name: t('common.cancel') }));
    expect(section.getByRole('listitem', { name })).toBeTruthy();
    fireEvent.click(stage.getByRole('button', { name: t('settings.pipeline.removeStage') }));
    dialog = within(screen.getByRole('dialog'));
    fireEvent.click(dialog.getByRole('button', { name: t('settings.pipeline.removeStage') }));
    expect(section.queryByRole('listitem', { name })).toBeNull();
    expect(project.backend.config.pipeline.stages.some((stage) => stage.id === 'dev')).toBe(true);
    fireEvent.click(section.getByRole('button', { name: t('memberEdit.save') }));
    await waitFor(() => expect(section.queryByRole('button', { name: t('memberEdit.save') })).toBeNull());
    expect(project.backend.config.pipeline.stages.some((stage) => stage.id === 'dev')).toBe(false);
  });

  it('shows the server task count and moving advice for an occupied stage, and can undo removal', async () => {
    const project = mockProject();
    const current = structuredClone(project.backend.config);
    const task = project.backend.tasks[0]!;
    task.stageId = 'dev';
    task.status = 'done';
    task.closedAt = new Date().toISOString();
    project.backend.tasks = [task];
    project.render(<SettingsPage />);
    const section = await editSection('pipeline');
    const name = current.pipeline.stages[1]!.name;
    fireEvent.click(
      within(section.getByRole('listitem', { name })).getByRole('button', {
        name: t('settings.pipeline.removeStage'),
      }),
    );
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: t('settings.pipeline.removeStage') }),
    );
    fireEvent.click(section.getByRole('button', { name: t('memberEdit.save') }));
    expect((await section.findByRole('alert')).textContent).toContain(
      t('settings.pipeline.stageInUse', { stage: 'dev', count: 1 }),
    );
    expect(project.backend.config).toEqual(current);
    fireEvent.click(section.getByRole('button', { name: t('settings.pipeline.undoRemove') }));
    expect(section.getByRole('listitem', { name })).toBeTruthy();
    fireEvent.click(section.getByRole('button', { name: t('memberEdit.save') }));
    await waitFor(() => expect(section.queryByRole('button', { name: t('memberEdit.save') })).toBeNull());
    expect(project.backend.config).toEqual(current);
  });

  it('saves a column colour through config PATCH and retains it when reopened', async () => {
    const project = mockProject();
    project.render(<SettingsPage />);
    const section = await editSection('pipeline');
    const name = project.backend.config.pipeline.columns[0]!.name;
    const columns = within(section.getByRole('group', { name: t('settings.pipeline.columns') }));
    const column = within(columns.getByDisplayValue(name).closest('div')!);
    fireEvent.click(column.getByRole('button', { name: t('columnColors.teal') }));
    expect(column.getByRole('button', { name: t('columnColors.teal') }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    fireEvent.click(section.getByRole('button', { name: t('memberEdit.save') }));
    await waitFor(() => expect(section.queryByRole('button', { name: t('memberEdit.save') })).toBeNull());
    expect(project.backend.config.pipeline.columns[0]!.color).toBe('teal');
    expect(
      project.requests.some((request) => request.method === 'PATCH' && request.path.endsWith('/config')),
    ).toBe(true);
    const reopened = await editSection('pipeline');
    expect(
      within(
        within(reopened.getByRole('group', { name: t('settings.pipeline.columns') }))
          .getByDisplayValue(name)
          .closest('div')!,
      )
        .getByRole('button', { name: t('columnColors.teal') })
        .getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('adds, renames and removes columns, refusing removal until their stages move away', async () => {
    const project = mockProject();
    project.render(<SettingsPage />);
    const section = await editSection('pipeline');
    const columns = within(section.getByRole('group', { name: t('settings.pipeline.columns') }));
    const names = columns.getAllByLabelText(t('settings.pipeline.columnName'));
    fireEvent.change(names[names.length - 1]!, { target: { value: 'Acme verification' } });
    fireEvent.click(columns.getByRole('button', { name: t('settings.pipeline.addColumn') }));
    const columnId = 'acme_verification';
    const renamed = columns.getByDisplayValue('Acme verification');
    fireEvent.change(renamed, { target: { value: 'Acme checks' } });
    const movedStage = within(section.getAllByRole('listitem')[1]!);
    fireEvent.change(movedStage.getByLabelText(t('settings.pipeline.column')), {
      target: { value: columnId },
    });
    const newColumn = within(columns.getByDisplayValue('Acme checks').closest('div')!);
    fireEvent.click(newColumn.getByRole('button', { name: t('settings.pipeline.removeColumn') }));
    expect(columns.getByRole('alert').textContent).toContain(
      t('settings.pipeline.columnInUse', { count: 1 }),
    );
    expect(columns.getByDisplayValue('Acme checks')).toBeTruthy();
    // An unrelated empty column can be removed in the same save.
    fireEvent.change(columns.getAllByLabelText(t('settings.pipeline.columnName')).at(-1)!, {
      target: { value: 'Acme unused' },
    });
    fireEvent.click(columns.getByRole('button', { name: t('settings.pipeline.addColumn') }));
    fireEvent.click(
      within(columns.getByDisplayValue('Acme unused').closest('div')!).getByRole('button', {
        name: t('settings.pipeline.removeColumn'),
      }),
    );
    expect(columns.queryByDisplayValue('Acme unused')).toBeNull();
    fireEvent.click(section.getByRole('button', { name: t('memberEdit.save') }));
    await waitFor(() => expect(section.queryByRole('button', { name: t('memberEdit.save') })).toBeNull());
    expect(project.backend.config.pipeline.columns).toContainEqual({ id: columnId, name: 'Acme checks' });
    expect(project.backend.config.pipeline.columns.some((column) => column.id === 'acme_unused')).toBe(false);
    expect(project.backend.config.pipeline.stages[1]?.columnId).toBe(columnId);
    const reopened = await editSection('pipeline');
    fireEvent.change(
      within(reopened.getAllByRole('listitem')[1]!).getByLabelText(t('settings.pipeline.column')),
      { target: { value: 'dev' } },
    );
    fireEvent.click(
      within(reopened.getByDisplayValue('Acme checks').closest('div')!).getByRole('button', {
        name: t('settings.pipeline.removeColumn'),
      }),
    );
    fireEvent.click(reopened.getByRole('button', { name: t('memberEdit.save') }));
    await waitFor(() => expect(reopened.queryByRole('button', { name: t('memberEdit.save') })).toBeNull());
    expect(project.backend.config.pipeline.columns.some((column) => column.id === columnId)).toBe(false);
  });

  it('shows release approval and orphan duty issues on their stage, retaining them after reordering', async () => {
    const project = mockProject();
    project.render(<SettingsPage />);
    const section = await editSection('pipeline');
    const initial = structuredClone(project.backend.config.pipeline);
    const name = initial.stages[1]!.name;
    const stage = within(section.getByRole('listitem', { name }));
    fireEvent.change(stage.getByLabelText(t('settings.pipeline.kindLabel')), {
      target: { value: 'release' },
    });
    fireEvent.change(stage.getByLabelText(t('duties.duty')), { target: { value: 'translation' } });
    fireEvent.click(section.getByRole('button', { name: t('memberEdit.save') }));
    await waitFor(() => expect(stage.getAllByRole('alert')).toHaveLength(2));
    expect(stage.getByText(t('settings.issues.release_without_human_approval'))).toBeTruthy();
    expect(stage.getByText(t('errors.codes.missing_duty_holder'))).toBeTruthy();
    expect(project.backend.config.pipeline).toEqual(initial);
    fireEvent.click(stage.getByRole('button', { name: t('settings.edit.moveDown') }));
    const reordered = within(section.getByRole('listitem', { name }));
    expect(reordered.getByText(t('settings.issues.release_without_human_approval'))).toBeTruthy();
    expect(reordered.getAllByRole('alert')).toHaveLength(2);
  });

  it('places translated schema issues beside the stage named by a dot-indexed path', async () => {
    const project = mockProject();
    project.render(<SettingsPage />);
    const section = await editSection('pipeline');
    const stage = within(section.getAllByRole('listitem')[1]!);
    fireEvent.change(stage.getByLabelText(t('settings.project.name')), { target: { value: '' } });
    fireEvent.click(section.getByRole('button', { name: t('memberEdit.save') }));
    expect((await stage.findByRole('alert')).textContent).toBe(t('settings.issues.too_small'));
    expect(project.backend.config.pipeline.stages[1]?.name).not.toBe('');
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
