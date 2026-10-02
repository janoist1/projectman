import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { PatchConfigRequest } from '@projectman/shared';
import { getLocale } from '@projectman/templates';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import type { MockRequest } from '../../test/mockProject';
import { SettingsPage } from './SettingsPage';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

async function editSection(section: 'project' | 'pipeline' | 'labels') {
  const region = await screen.findByRole('region', { name: t(`settings.sections.${section}`) });
  fireEvent.click(within(region).getByRole('button', { name: t('memberEdit.edit') }));
  return within(region);
}
/** The limits are controls that save at once: there is nothing to open. */
async function limitsSection() {
  return within(await screen.findByRole('region', { name: t('settings.sections.limits') }));
}
/** Every change made so far has been sent and answered. */
async function saved(section: ReturnType<typeof within>) {
  await waitFor(() => expect(section.getByRole('group').getAttribute('aria-busy')).not.toBe('true'), {
    timeout: 4000,
  });
}
/** The body of the last configuration PATCH the page sent. */
function lastConfigPatch(requests: readonly MockRequest[]): PatchConfigRequest {
  const patch = requests.filter((r) => r.method === 'PATCH' && r.path === '/api/projects/AC/config').at(-1);
  if (!patch) throw new Error('No configuration PATCH was sent');
  return patch.body as PatchConfigRequest;
}
function selectMembers(select: HTMLElement, handles: string[]) {
  for (const option of (select as HTMLSelectElement).options)
    option.selected = handles.includes(option.value);
  fireEvent.change(select);
}

describe('settings history', () => {
  it('explains saved settings changes below the history heading', async () => {
    const project = mockProject();
    project.render(<SettingsPage />);
    const section = within(await screen.findByRole('region', { name: t('settings.sections.history') }));
    const heading = section.getByRole('heading', { name: t('settings.sections.history'), level: 2 });
    expect(heading.nextElementSibling).toBe(section.getByText(t('settings.history.intro')));
  });
});

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
    expect(project.requests.find((request) => request.method === 'PATCH')?.body).toEqual({
      baseVersion: 'c3f9a21',
      project: { name: 'Acme webshop', language: 'en', timezone: 'UTC' },
    });
    const history = await screen.findByRole('region', { name: t('settings.sections.history') });
    expect(await within(history).findByText('Update project')).toBeTruthy();
  });

  it('offers the language and the time zone as choices, keeping a value the project already has', async () => {
    const project = mockProject();
    project.backend.config.project.timezone = 'Mars/Olympus';
    project.render(<SettingsPage />);
    const section = await editSection('project');
    const language = section.getByLabelText(t('settings.project.language')) as HTMLSelectElement;
    const timezone = section.getByLabelText(t('settings.project.timezone')) as HTMLSelectElement;
    expect([language.tagName, timezone.tagName]).toEqual(['SELECT', 'SELECT']);
    expect(Array.from(language.options, (option) => option.value)).toEqual(
      expect.arrayContaining(['hu', 'en']),
    );
    const zones = Array.from(timezone.options, (option) => option.value);
    expect(zones).toEqual(expect.arrayContaining(['UTC', 'Europe/Budapest', 'Mars/Olympus']));
    expect(timezone.value).toBe('Mars/Olympus');
  });

  it('lists the team in short with a link to the Team page', async () => {
    const project = mockProject();
    project.render(<SettingsPage />);
    const section = within(await screen.findByRole('region', { name: t('settings.sections.team') }));
    expect(section.queryByRole('table')).toBeNull();
    const owner = project.backend.config.team.members.find((m) => m.handle === 'owner')!;
    expect(section.getByText(owner.displayName)).toBeTruthy();
    expect(section.getByRole('link', { name: t('settings.team.manage') }).getAttribute('href')).toBe(
      '/p/AC/team',
    );
  });

  it('lists each repository as a row with its path below the name', async () => {
    const project = mockProject();
    project.render(<SettingsPage />);
    const section = within(await screen.findByRole('region', { name: t('settings.sections.repos') }));
    expect(section.queryByRole('table')).toBeNull();
    const repo = project.backend.config.project.repos[0]!;
    const row = section.getAllByRole('listitem')[0]!;
    expect(row.firstElementChild?.textContent).toBe(repo.name);
    expect(row.children[1]?.textContent).toBe(repo.path);
    expect(section.getAllByRole('listitem')).toHaveLength(project.backend.config.project.repos.length);
  });

  it('saves the AI switch the moment it is flipped, with no edit mode', async () => {
    const project = mockProject();
    project.render(<SettingsPage />);
    const section = await limitsSection();
    const toggle = section.getByRole('checkbox', {
      name: t('settings.limits.aiEnabled'),
    }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(section.getByText(t('settings.limits.aiEnabledHelp'))).toBeTruthy();
    expect(section.queryByRole('button', { name: t('memberEdit.edit') })).toBeNull();
    expect(section.queryByRole('button', { name: t('memberEdit.save') })).toBeNull();
    fireEvent.click(toggle);
    // Shown at once, saved right after.
    expect(toggle.checked).toBe(false);
    await waitFor(() => expect(project.backend.config.team.limits.aiEnabled).toBe(false));
    expect(project.requests.find((request) => request.method === 'PATCH')?.body).toMatchObject({
      limits: { aiEnabled: false },
    });
    await saved(section);
    expect(toggle.checked).toBe(false);
  });

  it('puts the AI switch first and shows a dependent field only while its switch is on', async () => {
    const project = mockProject();
    project.render(<SettingsPage />);
    const section = await limitsSection();
    expect(section.getAllByRole('checkbox')[0]).toBe(
      section.getByRole('checkbox', { name: t('settings.limits.aiEnabled') }),
    );
    expect(section.queryByLabelText(t('settings.limits.boundaryTimeout'))).toBeNull();
    expect(section.queryByLabelText(t('settings.edit.tempMax'))).toBeNull();
    fireEvent.click(section.getByRole('checkbox', { name: t('settings.limits.boundaryEnabled') }));
    await section.findByLabelText(t('settings.limits.boundaryTimeout'));
    await saved(section);
  });

  it('locks the limits while another section is being edited, so the open editor keeps its version', async () => {
    const project = mockProject();
    project.render(<SettingsPage />);
    const limits = await limitsSection();
    const toggle = limits.getByRole('checkbox', { name: t('settings.limits.aiEnabled') }) as HTMLInputElement;
    // Disabled by the fieldset around the controls, which only the :disabled selector sees.
    expect(toggle.matches(':disabled')).toBe(false);
    expect(limits.queryByText(t('settings.limits.locked'))).toBeNull();
    const editor = await editSection('project');
    expect(toggle.matches(':disabled')).toBe(true);
    expect(limits.getByText(t('settings.limits.locked'))).toBeTruthy();
    fireEvent.click(editor.getByRole('button', { name: t('common.cancel') }));
    await waitFor(() => expect(toggle.matches(':disabled')).toBe(false));
    expect(limits.queryByText(t('settings.limits.locked'))).toBeNull();
  });

  it('locks the limits while the duty matrix holds unsaved changes, so its draft is not lost', async () => {
    const project = mockProject();
    project.render(<SettingsPage />);
    const limits = await limitsSection();
    const toggle = limits.getByRole('checkbox', { name: t('settings.limits.aiEnabled') }) as HTMLInputElement;
    const matrix = within(await screen.findByRole('region', { name: t('duties.title') }));
    const locale = getLocale(project.backend.config.project.language);
    fireEvent.click(matrix.getByLabelText(`${locale.duties.research.name}: ${locale.roles.developer.name}`));
    await waitFor(() => expect(toggle.matches(':disabled')).toBe(true));
    fireEvent.click(matrix.getByRole('button', { name: t('memberEdit.save') }));
    await waitFor(() =>
      expect(project.backend.config.team.roleOverrides?.developer?.duties).toContain('research'),
    );
    await waitFor(() => expect(toggle.matches(':disabled')).toBe(false));
  });

  it('turns the cap on concurrent AI sessions off and on (decision 23)', async () => {
    const project = mockProject();
    project.render(<SettingsPage />);
    const section = await limitsSection();
    const noLimit = section.getByRole('checkbox', {
      name: t('settings.limits.noAiLimit'),
    }) as HTMLInputElement;
    // The mock project names a cap of its own: the number is shown, "no limit" is not ticked.
    expect(noLimit.checked).toBe(false);
    expect(section.getByLabelText(t('settings.limits.maxConcurrentAi'))).toBeTruthy();
    fireEvent.click(noLimit);
    expect(section.queryByLabelText(t('settings.limits.maxConcurrentAi'))).toBeNull();
    await saved(section);
    expect(project.backend.config.team.limits).not.toHaveProperty('maxConcurrentAi');
    expect(lastConfigPatch(project.requests).limits).toMatchObject({ maxConcurrentAi: null });

    // A number can be given again; it is saved when the field is left.
    fireEvent.click(section.getByRole('checkbox', { name: t('settings.limits.noAiLimit') }));
    const field = section.getByLabelText(t('settings.limits.maxConcurrentAi'));
    await saved(section);
    expect(project.backend.config.team.limits.maxConcurrentAi).toBe(3);
    fireEvent.change(field, { target: { value: '4' } });
    expect(lastConfigPatch(project.requests).limits).toMatchObject({ maxConcurrentAi: 3 });
    fireEvent.blur(field);
    await saved(section);
    expect(project.backend.config.team.limits.maxConcurrentAi).toBe(4);
  });

  it('does not save a number outside its range and says so', async () => {
    const project = mockProject();
    project.render(<SettingsPage />);
    const section = await limitsSection();
    const field = section.getByLabelText(t('settings.limits.maxConcurrentAi'));
    fireEvent.change(field, { target: { value: '99' } });
    fireEvent.blur(field);
    expect(section.getByText(t('settings.limits.range', { min: 1, max: 20 }))).toBeTruthy();
    expect(project.requests.some((request) => request.method === 'PATCH')).toBe(false);
    fireEvent.change(field, { target: { value: '5' } });
    expect(section.queryByText(t('settings.limits.range', { min: 1, max: 20 }))).toBeNull();
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(project.backend.config.team.limits.maxConcurrentAi).toBe(5));
  });

  it('shows the refusal and the latest values when the settings changed meanwhile', async () => {
    const project = mockProject();
    project.render(<SettingsPage />);
    const section = await limitsSection();
    project.backend.configVersion = 'changed-elsewhere';
    const toggle = section.getByRole('checkbox', {
      name: t('settings.limits.aiEnabled'),
    }) as HTMLInputElement;
    fireEvent.click(toggle);
    expect((await section.findByRole('alert')).textContent).toBe(t('settings.limits.conflict'));
    await waitFor(() => expect(toggle.checked).toBe(true));
    expect(project.backend.config.team.limits.aiEnabled).toBe(true);
  });

  it('sets the compaction window of conversations and removes it again (PM-212)', async () => {
    const project = mockProject();
    project.render(<SettingsPage />);
    const section = await limitsSection();
    const field = () => section.getByLabelText(t('settings.limits.autoCompactWindow')) as HTMLInputElement;
    // Not set in the mock project: the field is empty and names the default.
    expect(field().value).toBe('');
    expect(field().placeholder).toBe('200000');
    expect(section.getByText(t('settings.limits.autoCompactWindowHelp'))).toBeTruthy();
    fireEvent.change(field(), { target: { value: '300000' } });
    fireEvent.blur(field());
    await waitFor(() => expect(project.backend.config.team.limits.autoCompactWindowTokens).toBe(300_000));
    expect(lastConfigPatch(project.requests).limits).toMatchObject({ autoCompactWindowTokens: 300_000 });

    fireEvent.change(field(), { target: { value: '' } });
    fireEvent.blur(field());
    await waitFor(() =>
      expect(project.backend.config.team.limits).not.toHaveProperty('autoCompactWindowTokens'),
    );
    expect(lastConfigPatch(project.requests).limits).toMatchObject({ autoCompactWindowTokens: null });
  });

  it('sets the free disk space limit, and 0 turns it off (PM-243)', async () => {
    const project = mockProject();
    project.render(<SettingsPage />);
    const section = await limitsSection();
    const field = section.getByLabelText(t('settings.limits.minFreeDisk')) as HTMLInputElement;
    expect(field.value).toBe('10');
    fireEvent.change(field, { target: { value: '25' } });
    fireEvent.blur(field);
    await saved(section);
    expect(project.backend.config.team.limits.minFreeDiskGb).toBe(25);
    expect(lastConfigPatch(project.requests).limits).toMatchObject({ minFreeDiskGb: 25 });

    fireEvent.change(field, { target: { value: '0' } });
    fireEvent.blur(field);
    await waitFor(() => expect(project.backend.config.team.limits.minFreeDiskGb).toBe(0));
  });

  it("sets and removes the warning limit of a session's tokens (PM-187)", async () => {
    const project = mockProject();
    project.render(<SettingsPage />);
    const section = await limitsSection();
    const noWarning = section.getByRole('checkbox', {
      name: t('settings.limits.noTokenWarning'),
    }) as HTMLInputElement;
    // A configuration without it: no warning, no number.
    expect(noWarning.checked).toBe(true);
    expect(section.queryByLabelText(t('settings.limits.warnAboveSessionTokens'))).toBeNull();
    fireEvent.click(noWarning);
    const field = section.getByLabelText(t('settings.limits.warnAboveSessionTokens'));
    await saved(section);
    expect(project.backend.config.team.limits.warnAboveSessionTokens).toBe(5_000_000);
    fireEvent.change(field, { target: { value: '2000000' } });
    fireEvent.blur(field);
    await saved(section);
    expect(project.backend.config.team.limits.warnAboveSessionTokens).toBe(2_000_000);
    expect(lastConfigPatch(project.requests).limits).toMatchObject({ warnAboveSessionTokens: 2_000_000 });

    // Removed again: sent as null.
    fireEvent.click(section.getByRole('checkbox', { name: t('settings.limits.noTokenWarning') }));
    await waitFor(() =>
      expect(lastConfigPatch(project.requests).limits).toMatchObject({ warnAboveSessionTokens: null }),
    );
    await waitFor(() =>
      expect(project.backend.config.team.limits).not.toHaveProperty('warnAboveSessionTokens'),
    );
  });

  it('sets the message storm threshold, 10 in 15 minutes until then (PM-186)', async () => {
    const project = mockProject();
    project.render(<SettingsPage />);
    const section = await limitsSection();
    const count = section.getByLabelText(t('settings.limits.messageBurstCount')) as HTMLInputElement;
    const minutes = section.getByLabelText(t('settings.limits.messageBurstMinutes')) as HTMLInputElement;
    expect([count.value, minutes.value]).toEqual(['10', '15']);
    // Two quick changes in a row are saved one after the other and keep each other's value.
    fireEvent.change(count, { target: { value: '6' } });
    fireEvent.blur(count);
    fireEvent.change(minutes, { target: { value: '30' } });
    fireEvent.blur(minutes);
    await waitFor(() =>
      expect(project.backend.config.team.limits.messageBurst).toEqual({ count: 6, minutes: 30 }),
    );
    expect(lastConfigPatch(project.requests).limits).toMatchObject({
      messageBurst: { count: 6, minutes: 30 },
    });

    // One field changed keeps the other.
    fireEvent.change(section.getByLabelText(t('settings.limits.messageBurstCount')), {
      target: { value: '4' },
    });
    fireEvent.blur(section.getByLabelText(t('settings.limits.messageBurstCount')));
    await waitFor(() =>
      expect(project.backend.config.team.limits.messageBurst).toEqual({ count: 4, minutes: 30 }),
    );
  });

  it('edits limits with a 10–100 slider and AI-capable role choices', async () => {
    const project = mockProject();
    project.render(<SettingsPage />);
    const section = await limitsSection();
    // The temp worker fields appear once the temp workers are on.
    expect(section.queryByLabelText(t('settings.edit.tempMax'))).toBeNull();
    fireEvent.click(section.getByRole('checkbox', { name: t('settings.limits.tempWorkers') }));
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
    // Dragging the slider saves nothing until it is released.
    const patches = () => project.requests.filter((request) => request.method === 'PATCH').length;
    await saved(section);
    const before = patches();
    fireEvent.change(slider, { target: { value: '60' } });
    expect(patches()).toBe(before);
    fireEvent.pointerUp(slider);
    fireEvent.change(section.getByLabelText(t('settings.limits.maxConcurrentAi')), {
      target: { value: '2' },
    });
    fireEvent.keyDown(section.getByLabelText(t('settings.limits.maxConcurrentAi')), { key: 'Enter' });
    fireEvent.change(section.getByLabelText(t('settings.edit.tempMax')), { target: { value: '3' } });
    fireEvent.blur(section.getByLabelText(t('settings.edit.tempMax')));
    fireEvent.change(role, { target: { value: 'qa' } });
    await waitFor(() =>
      expect(project.backend.config.team.limits).toMatchObject({
        maxConcurrentAi: 2,
        pauseAbovePlanUsagePercent: 60,
        tempWorkers: { enabled: true, max: 3, role: 'qa' },
      }),
    );
    expect(lastConfigPatch(project.requests).limits).toMatchObject({
      maxConcurrentAi: 2,
      pauseAbovePlanUsagePercent: 60,
      tempWorkers: { enabled: true, max: 3, role: 'qa' },
    });
  });

  it('shows the limits as plain values to those who cannot change them', async () => {
    const project = mockProject();
    project.render(<SettingsPage />, '/', {
      can: { manageTeam: false, createTasks: false, workInSessions: false },
    });
    const section = await limitsSection();
    expect(section.getByText(t('settings.limits.aiEnabledOn'))).toBeTruthy();
    expect(section.queryByRole('checkbox')).toBeNull();
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
    const stages = lastConfigPatch(project.requests).pipeline!.stages;
    expect(stages).toHaveLength(initialStageCount);
    expect(stages[2]).toMatchObject({
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

  it('saves and reloads a condition that binds only the cards with a label (when)', async () => {
    const project = mockProject();
    project.render(<SettingsPage />);
    const section = await editSection('pipeline');
    const stage = within(section.getAllByRole('listitem')[1]!);
    fireEvent.click(stage.getByRole('button', { name: t('settings.edit.addCondition') }));
    fireEvent.change(stage.getByLabelText(t('settings.edit.label')), { target: { value: 'qa-ok' } });
    fireEvent.change(stage.getByLabelText(t('settings.edit.when')), { target: { value: 'code-review-ok' } });
    fireEvent.click(section.getByRole('button', { name: t('memberEdit.save') }));
    await waitFor(() => expect(section.queryByRole('button', { name: t('memberEdit.save') })).toBeNull());
    const gate = lastConfigPatch(project.requests).pipeline!.stages[1]!.gate;
    expect(gate?.conditions).toEqual([{ type: 'has_label', label: 'qa-ok', when: 'code-review-ok' }]);
    expect(
      section.getByText(
        t('settings.pipeline.gateHasLabelWhen', { label: 'QA rendben', when: 'Code review rendben' }),
      ),
    ).toBeTruthy();

    // Reopened, the editor shows the label; "every card" takes it away again.
    fireEvent.click(section.getByRole('button', { name: t('memberEdit.edit') }));
    const reopened = within(section.getAllByRole('listitem')[1]!);
    const when = reopened.getByLabelText(t('settings.edit.when')) as HTMLSelectElement;
    expect(when.value).toBe('code-review-ok');
    fireEvent.change(when, { target: { value: '' } });
    fireEvent.click(section.getByRole('button', { name: t('memberEdit.save') }));
    await waitFor(() => expect(section.queryByRole('button', { name: t('memberEdit.save') })).toBeNull());
    expect(lastConfigPatch(project.requests).pipeline!.stages[1]!.gate?.conditions).toEqual([
      { type: 'has_label', label: 'qa-ok' },
    ]);
  });

  it('offers no label to bind a release gate condition to (a release approval holds for every card)', async () => {
    const project = mockProject();
    project.render(<SettingsPage />);
    const section = await editSection('pipeline');
    const release = within(section.getByRole('listitem', { name: 'Élesítés' }));
    const when = release.getAllByLabelText(t('settings.edit.when'))[0]!;
    for (const option of within(when).getAllByRole('option') as HTMLOptionElement[])
      expect(option.disabled, option.textContent ?? '').toBe(option.value !== '');
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
    expect(lastConfigPatch(project.requests).pipeline!.labels.find((label) => label.id === 'Sürgős')).toEqual(
      {
        id: 'Sürgős',
        name: 'Sürgős',
        color: 'red',
        meaning: 'Ma kell.',
        setBy: 'anyone',
        blocks: true,
      },
    );
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
      lastConfigPatch(project.requests).pipeline!.stages.find((stage) => stage.id === 'integration')?.gate
        ?.conditions[0],
    ).toEqual({ type: 'has_label', label: 'qa-ok' });
  });

  it('offers a release gate only the release approval as approval, and any label to other gates (decision 19)', async () => {
    const project = mockProject();
    // A merge approval other duty holders may give: it passes a merge gate, not a release gate.
    const approval = { id: 'merge-approved', name: 'Merge jóváhagyva' };
    project.backend.config.pipeline.labels.unshift({
      ...approval,
      setBy: { duties: ['final_decision'], humansOnly: true },
    });
    project.render(<SettingsPage />);
    const section = await editSection('pipeline');
    const release = within(section.getByRole('listitem', { name: 'Élesítés' }));
    const integration = within(section.getByRole('listitem', { name: 'Integration' }));
    const choice = (stage: typeof release) =>
      within(stage.getAllByLabelText(t('settings.edit.label'))[0]!).getByRole('option', {
        name: approval.name,
      }) as HTMLOptionElement;

    expect(choice(release).disabled).toBe(true);
    expect(release.getByText(t('settings.edit.releaseApprovalOnly'))).toBeTruthy();
    // The rule is about the release gate: the integration gate takes the same label.
    expect(choice(integration).disabled).toBe(false);
    expect(integration.queryByText(t('settings.edit.releaseApprovalOnly'))).toBeNull();

    // A new condition starts on a label the gate accepts: the first of the project's labels elsewhere.
    fireEvent.click(release.getByRole('button', { name: t('settings.edit.addCondition') }));
    fireEvent.click(integration.getByRole('button', { name: t('settings.edit.addCondition') }));
    const added = (stage: typeof release) =>
      (stage.getAllByLabelText(t('settings.edit.label')).at(-1) as HTMLSelectElement).value;
    expect(added(release)).not.toBe(approval.id);
    expect(added(integration)).toBe(approval.id);
  });

  it('tells the owner which rules the stored configuration breaks, and nothing when it breaks none', async () => {
    const valid = mockProject();
    valid.render(<SettingsPage />);
    await screen.findByRole('region', { name: t('settings.sections.project') });
    expect(screen.queryByRole('region', { name: t('settings.problems.title') })).toBeNull();

    const project = mockProject();
    const { columns } = project.backend.config.pipeline;
    columns.push({ ...columns[0]! });
    project.backend.config.pipeline.labels.find((label) => label.id === 'release-approved')!.setBy = 'humans';
    project.render(<SettingsPage />);
    const notice = within(await screen.findByRole('region', { name: t('settings.problems.title') }));
    expect(notice.getByText(t('settings.problems.intro'))).toBeTruthy();
    const items = notice.getAllByRole('listitem').map((item) => item.textContent);
    expect(items).toEqual([
      `pipeline.columns[${columns.length - 1}].id ${t('settings.issues.duplicate_column')}`,
      `pipeline.stages[7].gate.conditions[1] ${t('settings.issues.release_approval_needs_duty')}`,
    ]);
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
    expect(section.getByRole('button', { name: t('memberEdit.save') })).toBeTruthy();
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
    fireEvent.change(form.getByLabelText(t('settings.pipeline.kindLabel')), { target: { value: 'step' } });
    expect(form.getByText(t('settings.pipeline.kindHelp.step'), { selector: 'p' })).toBeTruthy();
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
    const added = lastConfigPatch(project.requests).pipeline!.stages[2];
    expect(added).toEqual({
      id: 'acme_review',
      name: 'Acme review',
      kind: 'step',
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
    const added = lastConfigPatch(project.requests).pipeline!.stages.filter((stage) => stage.name === name);
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
    expect(project.requests.some((request) => request.method === 'PATCH')).toBe(false);
    fireEvent.click(section.getByRole('button', { name: t('memberEdit.save') }));
    await waitFor(() => expect(section.queryByRole('button', { name: t('memberEdit.save') })).toBeNull());
    expect(lastConfigPatch(project.requests).pipeline!.stages.some((stage) => stage.id === 'dev')).toBe(
      false,
    );
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
    fireEvent.click(section.getByRole('button', { name: t('settings.pipeline.undoRemove') }));
    expect(section.getByRole('listitem', { name })).toBeTruthy();
    fireEvent.click(section.getByRole('button', { name: t('memberEdit.save') }));
    await waitFor(() => expect(section.queryByRole('button', { name: t('memberEdit.save') })).toBeNull());
    expect(lastConfigPatch(project.requests).pipeline).toEqual(current.pipeline);
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
    expect(lastConfigPatch(project.requests).pipeline!.columns[0]!.color).toBe('teal');
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
    const saved = lastConfigPatch(project.requests).pipeline!;
    expect(saved.columns).toContainEqual({ id: columnId, name: 'Acme checks' });
    expect(saved.columns.some((column) => column.id === 'acme_unused')).toBe(false);
    expect(saved.stages[1]?.columnId).toBe(columnId);
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
    expect(lastConfigPatch(project.requests).pipeline!.columns.some((column) => column.id === columnId)).toBe(
      false,
    );
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
