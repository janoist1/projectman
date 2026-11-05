import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PatchConfigRequest } from '@projectman/shared';
import { getLocale } from '@projectman/templates';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import type { MockRequest } from '../../test/mockProject';
import { SettingsTestRoutes, SettingsEditingFixture } from './testRoutes';

async function goTo(section: string) {
  if (
    screen.queryByRole('region', {
      name: section === 'duties' ? t('duties.title') : t(`settings.sections.${section as 'project'}`),
    })
  )
    return;
  const back = screen.queryByRole('link', { name: t('settings.backLabel') });
  if (!back && !screen.queryByRole('navigation')) return;
  if (back) fireEvent.click(back);
  const nav = screen.getByRole('navigation', { name: t('settings.nav.label') });
  fireEvent.click(
    within(nav).getByRole('link', { name: new RegExp(t(`settings.nav.${section as 'project'}`)) }),
  );
}

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

async function editSection(section: 'project' | 'labels') {
  await goTo(section);
  const region = await screen.findByRole('region', { name: t(`settings.sections.${section}`) });
  fireEvent.click(within(region).getByRole('button', { name: t('memberEdit.edit') }));
  return within(region);
}
/** The limits are controls that save at once: there is nothing to open. */
async function limitsSection() {
  await goTo('limits');
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

describe('settings history', () => {
  it('explains saved settings changes below the history heading', async () => {
    const project = mockProject();
    project.render(<SettingsTestRoutes initialSection="history" />);
    const section = within(await screen.findByRole('region', { name: t('settings.sections.history') }));
    const heading = section.getByRole('heading', { name: t('settings.sections.history'), level: 2 });
    expect(heading.nextElementSibling).toBe(section.getByText(t('settings.history.intro')));
  });
});

describe('settings section editors', () => {
  it('edits project fields, cancels drafts and permits one active section', async () => {
    const project = mockProject();
    project.render(<SettingsTestRoutes />);
    const initial = structuredClone(project.backend.config);
    let section = await editSection('project');
    fireEvent.change(section.getByLabelText(t('settings.project.name')), {
      target: { value: 'Cancelled edit' },
    });
    expect(screen.queryByRole('button', { name: t('memberEdit.edit') })).toBeNull();
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
    await goTo('history');
    const history = await screen.findByRole('region', { name: t('settings.sections.history') });
    expect(await within(history).findByText(t('settings.history.summary.sectionProject'))).toBeTruthy();
  });

  it('offers the language and the time zone as choices, keeping a value the project already has', async () => {
    const project = mockProject();
    project.backend.config.project.timezone = 'Mars/Olympus';
    project.render(<SettingsTestRoutes />);
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
    project.render(<SettingsTestRoutes initialSection="team" />);
    const section = within(await screen.findByRole('region', { name: t('settings.sections.team') }));
    expect(section.queryByRole('table')).toBeNull();
    const owner = project.backend.config.team.members.find((m) => m.handle === 'owner')!;
    // The name is also offered in the contacts list below the team.
    expect(section.getAllByText(owner.displayName).length).toBeGreaterThan(0);
    expect(section.getByRole('link', { name: t('settings.team.manage') }).getAttribute('href')).toBe(
      '/p/AC/team',
    );
  });

  describe('the contacts', () => {
    const teamSection = async () =>
      within(await screen.findByRole('region', { name: t('settings.sections.team') }));
    const contactBox = (section: ReturnType<typeof within>, handle: string) =>
      section.getByRole('checkbox', { name: new RegExp(`${handle}$`) }) as HTMLInputElement;

    it('saves a ticked member as a contact at once, and clears them when unticked (PM-985)', async () => {
      const project = mockProject();
      project.render(<SettingsTestRoutes initialSection="team" />);
      const section = await teamSection();
      fireEvent.click(contactBox(section, 'fe-1'));
      await waitFor(() => expect(project.backend.config.team.contacts).toEqual(['fe-1']));
      expect(lastConfigPatch(project.requests)).toMatchObject({ contacts: ['fe-1'] });
      await waitFor(() => expect(contactBox(section, 'fe-1').matches(':disabled')).toBe(false));
      fireEvent.click(contactBox(section, 'fe-1'));
      await waitFor(() => expect(project.backend.config.team.contacts).toEqual([]));
      expect(lastConfigPatch(project.requests)).toMatchObject({ contacts: [] });
    });

    it('puts the tick back and says why when the server refuses the change', async () => {
      const project = mockProject();
      const original = project.backend.handle.bind(project.backend);
      vi.spyOn(project.backend, 'handle').mockImplementation((method, path, body, query) =>
        method === 'PATCH' && path.endsWith('/config')
          ? { status: 400, body: { error: { code: 'config_invalid', message: 'Refused' } } }
          : original(method, path, body, query),
      );
      project.render(<SettingsTestRoutes initialSection="team" />);
      const section = await teamSection();
      fireEvent.click(contactBox(section, 'fe-1'));
      expect(await section.findByRole('alert')).toBeTruthy();
      await waitFor(() => expect(contactBox(section, 'fe-1').checked).toBe(false));
      expect(project.backend.config.team.contacts).toEqual([]);
    });

    it('only lists the contacts for a member who may not manage the team', async () => {
      const project = mockProject();
      project.backend.config.team.contacts = ['fe-1'];
      project.render(<SettingsTestRoutes initialSection="team" />, '/', {
        isOwner: false,
        can: { createTasks: false, manageTeam: false, workInSessions: false },
      });
      const section = await teamSection();
      expect(section.queryByRole('checkbox')).toBeNull();
      // The heading and the read-only line below it.
      expect(section.getAllByText(t('settings.team.contacts.label'))).toHaveLength(2);
    });
  });

  it('lists each repository as a row with its path below the name', async () => {
    const project = mockProject();
    project.render(<SettingsTestRoutes initialSection="repos" />);
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
    project.render(<SettingsTestRoutes />);
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
    project.render(<SettingsTestRoutes />);
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
    project.render(<SettingsEditingFixture />);
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
    project.render(<SettingsEditingFixture />);
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
    project.render(<SettingsTestRoutes />);
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
    project.render(<SettingsTestRoutes />);
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
    project.render(<SettingsTestRoutes />);
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
    project.render(<SettingsTestRoutes />);
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
    project.render(<SettingsTestRoutes />);
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

  it('sets how long a Senior card waits before the owners are asked, from 5 to 1440 minutes (PM-349)', async () => {
    const project = mockProject();
    project.render(<SettingsTestRoutes initialSection="limits" />);
    const section = await limitsSection();
    const field = section.getByLabelText(t('settings.limits.seniorWait')) as HTMLInputElement;
    // Not set in the mock project: the default of 30 minutes is shown.
    expect(field.value).toBe('30');
    expect(section.getByText(t('settings.limits.seniorWaitHelp'))).toBeTruthy();
    expect(project.backend.config.team.limits).not.toHaveProperty('seniorWaitMinutes');

    fireEvent.change(field, { target: { value: '90' } });
    fireEvent.blur(field);
    await saved(section);
    expect(project.backend.config.team.limits.seniorWaitMinutes).toBe(90);
    expect(lastConfigPatch(project.requests).limits).toMatchObject({ seniorWaitMinutes: 90 });

    // Out of range: not saved, and the range is told.
    const patches = project.requests.filter((request) => request.method === 'PATCH').length;
    fireEvent.change(field, { target: { value: '2' } });
    fireEvent.blur(field);
    expect(section.getByText(t('settings.limits.range', { min: 5, max: 1440 }))).toBeTruthy();
    expect(project.requests.filter((request) => request.method === 'PATCH')).toHaveLength(patches);
    expect(project.backend.config.team.limits.seniorWaitMinutes).toBe(90);
  });

  it('shows a Senior wait that was set before in its field, and in minutes to those who cannot change it (PM-349)', async () => {
    const project = mockProject();
    project.backend.config.team.limits.seniorWaitMinutes = 45;
    project.render(<SettingsTestRoutes initialSection="limits" />);
    const section = await limitsSection();
    expect((section.getByLabelText(t('settings.limits.seniorWait')) as HTMLInputElement).value).toBe('45');
  });

  it('lists the Senior wait to a member who cannot change the limits, with the default when none is set', async () => {
    const project = mockProject();
    project.render(<SettingsTestRoutes initialSection="limits" />, '/p/AC/settings/limits', {
      can: { manageTeam: false, createTasks: true, workInSessions: true, readConfig: true },
    });
    const section = await limitsSection();
    expect(section.getByText(t('settings.limits.seniorWaitSummary')).nextElementSibling?.textContent).toBe(
      t('settings.limits.seniorWaitValue', { minutes: 30 }),
    );
    expect(section.queryByLabelText(t('settings.limits.seniorWait'))).toBeNull();
  });

  it('sets the limit of the fix rounds, from 1 to 10 (PM-262)', async () => {
    const project = mockProject();
    project.render(<SettingsTestRoutes />);
    const section = await limitsSection();
    const field = section.getByLabelText(t('settings.limits.maxFixRounds')) as HTMLInputElement;
    expect(field.value).toBe('3');
    fireEvent.change(field, { target: { value: '5' } });
    fireEvent.blur(field);
    await saved(section);
    expect(project.backend.config.team.limits.maxFixRounds).toBe(5);
    expect(lastConfigPatch(project.requests).limits).toMatchObject({ maxFixRounds: 5 });
  });

  it("sets and removes the warning limit of a session's tokens (PM-187)", async () => {
    const project = mockProject();
    project.render(<SettingsTestRoutes />);
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

  it('sets the loop watch, 6 messages in 30 minutes until then, and says who is told (PM-261)', async () => {
    const project = mockProject();
    // The fake team's project manager holds the scheduling duty; on leave, nobody does.
    project.backend.handle('PATCH', '/api/projects/AC/members/pm', { onLeave: true });
    project.render(<SettingsTestRoutes />);
    const section = await limitsSection();
    const count = section.getByLabelText(t('settings.limits.loopWatchCount')) as HTMLInputElement;
    const minutes = section.getByLabelText(t('settings.limits.loopWatchMinutes')) as HTMLInputElement;
    expect([count.value, minutes.value]).toEqual(['6', '30']);
    // No AI member at work holds the scheduling duty: the line says so, as a warning.
    expect(section.getByText(/Az Ütemezést senki nem tölti be, ezért .* róla\./)).toBeTruthy();
    expect(
      section.getByRole('link', { name: t('settings.limits.loopWatchDuties') }).getAttribute('href'),
    ).toBe('/p/AC/settings/duties');
    // Two quick changes in a row are saved one after the other and keep each other's value.
    fireEvent.change(count, { target: { value: '8' } });
    fireEvent.blur(count);
    fireEvent.change(minutes, { target: { value: '45' } });
    fireEvent.blur(minutes);
    await waitFor(() =>
      expect(project.backend.config.team.limits.loopWatch).toEqual({ enabled: true, count: 8, minutes: 45 }),
    );
    expect(lastConfigPatch(project.requests).limits).toMatchObject({
      loopWatch: { enabled: true, count: 8, minutes: 45 },
    });

    // One field changed keeps the other.
    fireEvent.change(section.getByLabelText(t('settings.limits.loopWatchCount')), {
      target: { value: '4' },
    });
    fireEvent.blur(section.getByLabelText(t('settings.limits.loopWatchCount')));
    await waitFor(() =>
      expect(project.backend.config.team.limits.loopWatch).toEqual({ enabled: true, count: 4, minutes: 45 }),
    );

    // Switched off, the numbers and the line go; the switch keeps the numbers.
    fireEvent.click(section.getByRole('checkbox', { name: t('settings.limits.loopWatch') }));
    await waitFor(() =>
      expect(project.backend.config.team.limits.loopWatch).toEqual({ enabled: false, count: 4, minutes: 45 }),
    );
    expect(section.queryByLabelText(t('settings.limits.loopWatchCount'))).toBeNull();
  });

  it('names the member who is told when a member holds the scheduling duty (PM-261)', async () => {
    const project = mockProject();
    const devops = project.backend.config.team.members.find((member) => member.handle === 'devops');
    if (devops?.kind === 'ai') devops.role = 'project_manager';
    project.render(<SettingsTestRoutes />);
    const section = await limitsSection();
    await waitFor(() =>
      expect(
        section.getByText(t('settings.limits.loopWatchTo', { name: 'Devops' }), { exact: false }),
      ).toBeTruthy(),
    );
  });

  it('edits limits with a 10–100 slider and AI-capable role choices', async () => {
    const project = mockProject();
    project.render(<SettingsTestRoutes />);
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
    fireEvent.change(section.getByLabelText(t('settings.edit.tempMaxPoints')), { target: { value: '8' } });
    await waitFor(() =>
      expect(project.backend.config.team.limits).toMatchObject({
        maxConcurrentAi: 2,
        pauseAbovePlanUsagePercent: 60,
        tempWorkers: { enabled: true, max: 3, role: 'qa', maxPoints: 8 },
      }),
    );
    expect(lastConfigPatch(project.requests).limits).toMatchObject({
      maxConcurrentAi: 2,
      pauseAbovePlanUsagePercent: 60,
      tempWorkers: { enabled: true, max: 3, role: 'qa', maxPoints: 8 },
    });
  });

  it('shows the limits as plain values to those who cannot change them', async () => {
    const project = mockProject();
    project.render(<SettingsTestRoutes />, '/', {
      can: { manageTeam: false, createTasks: false, workInSessions: false },
    });
    const section = await limitsSection();
    expect(section.getByText(t('settings.limits.aiEnabledOn'))).toBeTruthy();
    expect(section.queryByRole('checkbox')).toBeNull();
  });

  it('gives a tag in use a meaning and rules, and keeps approvals for the owner', async () => {
    const project = mockProject();
    project.backend.findTask('AC-20')!.labels.push('Sürgős');
    project.render(<SettingsTestRoutes />);
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

  it('tells the owner which rules the stored configuration breaks, and nothing when it breaks none', async () => {
    const valid = mockProject();
    const validUi = valid.render(<SettingsTestRoutes />);
    await screen.findByRole('region', { name: t('settings.sections.project') });
    expect(screen.queryByRole('region', { name: t('settings.problems.count', { n: 2 }) })).toBeNull();
    validUi.unmount();

    const project = mockProject();
    const { columns } = project.backend.config.pipeline;
    columns.push({ ...columns[0]! });
    project.backend.config.pipeline.labels.find((label) => label.id === 'release-approved')!.setBy = 'humans';
    project.render(<SettingsTestRoutes />);
    const notice = within(
      await screen.findByRole('region', { name: t('settings.problems.count', { n: 2 }) }),
    );
    expect(notice.getByText(t('settings.problems.rule'))).toBeTruthy();
    const items = notice.getAllByRole('listitem').map((item) => item.textContent);
    expect(items).toEqual([
      `${columns[0]!.name}: ${t('settings.issues.duplicate_column')} ${t('settings.problems.open')}`,
      `${project.backend.config.pipeline.stages[7]!.name}: ${t('settings.issues.release_approval_needs_duty')} ${t('settings.problems.open')}`,
    ]);

    const section = await editSection('project');
    fireEvent.change(section.getByLabelText(t('settings.project.name')), {
      target: { value: 'Renamed despite existing errors' },
    });
    fireEvent.click(section.getByRole('button', { name: t('memberEdit.save') }));
    await waitFor(() => expect(section.queryByRole('button', { name: t('memberEdit.save') })).toBeNull());
    expect(project.backend.config.project.name).toBe('Renamed despite existing errors');
  });

  it('shows a conflict and reloads the latest version before retrying', async () => {
    const project = mockProject();
    project.render(<SettingsTestRoutes />);
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

  // A client does not get the configuration at all (it is refused), so only a viewer reaches the sections.
  it.each(['viewer'] as const)('hides edit buttons for %s access', async (access) => {
    const project = mockProject();
    const member = project.backend.config.team.members.find((member) => member.handle === 'owner')!;
    if (member.kind === 'human') member.access = access;
    project.render(<SettingsTestRoutes />, '/', {
      isOwner: false,
      can: { manageTeam: false, createTasks: false, workInSessions: false },
    });
    await screen.findByRole('region', { name: t('settings.sections.project') });
    expect(screen.queryByRole('button', { name: t('memberEdit.edit') })).toBeNull();
  });
});
