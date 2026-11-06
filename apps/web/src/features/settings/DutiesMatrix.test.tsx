import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { teamSettingOf } from '@projectman/shared';
import type { PatchConfigRequest } from '@projectman/shared';
import { getLocale } from '@projectman/templates';
import { setFetchImplementation } from '../../api/client';
import { ToastProvider } from '../../components/Toast';
import { mockProject } from '../../test/mockProject';
import { t } from '../../i18n/t';
import { SettingsTestRoutes } from './testRoutes';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

const nonOwnerAdmin = { isOwner: false, myHandle: 'kata' };
const member = { can: { manageTeam: false, createTasks: false, workInSessions: false }, isOwner: false };

function renderMatrix(overrides: Parameters<ReturnType<typeof mockProject>['render']>[2] = {}) {
  const project = mockProject();
  project.render(
    <ToastProvider>
      <SettingsTestRoutes initialSection="duties" />
    </ToastProvider>,
    '/',
    overrides,
  );
  return project;
}

/** The project's admin who is not an owner. */
function asAdmin(project: ReturnType<typeof mockProject>) {
  project.backend.viewerHandle = 'kata';
  const admin = project.backend.config.team.members.find((m) => m.handle === 'kata')!;
  if (admin.kind === 'human') admin.access = 'admin';
}

async function matrix() {
  return within(await screen.findByRole('region', { name: t('duties.title') }));
}

function patches(project: ReturnType<typeof mockProject>) {
  return project.requests.filter((request) => request.method === 'PATCH' && request.path.endsWith('/config'));
}

function box(region: ReturnType<typeof within>, duty: string, role: string) {
  const locale = getLocale('hu');
  return region.getByLabelText(
    `${locale.duties[duty as 'research'].name}: ${locale.roles[role as 'developer'].name}`,
  ) as HTMLInputElement;
}

describe('duty matrix', () => {
  it('saves a cell at once with one request, undoes it from the toast, and resets a role at once', async () => {
    const project = renderMatrix();
    const region = await matrix();
    fireEvent.click(box(region, 'research', 'developer'));
    await waitFor(() =>
      expect(project.backend.config.team.roleOverrides?.developer?.duties).toContain('research'),
    );
    expect(patches(project)).toHaveLength(1);
    expect(patches(project)[0]!.body).toMatchObject({
      baseVersion: expect.any(String),
      roleOverrides: expect.anything(),
      roles: expect.anything(),
      releaseFourEyes: expect.any(Boolean),
    });
    // There is no save bar: nothing waits to be saved.
    expect(region.queryByRole('button', { name: t('memberEdit.save') })).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: t('settings.pipeline.edit.undo') }));
    await waitFor(() => expect(project.backend.config.team.roleOverrides?.developer).toBeUndefined());
    // The toast button is gone; the focus goes back to the cell that was saved.
    await waitFor(() => expect(document.activeElement).toBe(box(region, 'research', 'developer')));

    fireEvent.click(box(region, 'research', 'developer'));
    await waitFor(() =>
      expect(project.backend.config.team.roleOverrides?.developer?.duties).toContain('research'),
    );
    fireEvent.click(await region.findByRole('button', { name: t('duties.reset') }));
    await waitFor(() => expect(project.backend.config.team.roleOverrides?.developer).toBeUndefined());
  });

  it('saves the four-eyes switch at once, for an owner only', async () => {
    const project = renderMatrix();
    const region = await matrix();
    const before = teamSettingOf(project.backend.config, 'releaseFourEyes');
    fireEvent.click(region.getByLabelText(t('duties.fourEyes')));
    await waitFor(() => expect(patches(project)).toHaveLength(1));
    expect((patches(project)[0]!.body as PatchConfigRequest).releaseFourEyes).toBe(!before);
  });

  it('sends rapid clicks one after the other, each on the version the one before made', async () => {
    const project = renderMatrix();
    const region = await matrix();
    fireEvent.click(box(region, 'research', 'developer'));
    fireEvent.click(box(region, 'docs', 'developer'));
    await waitFor(() => expect(patches(project)).toHaveLength(2));
    const [first, second] = patches(project).map((request) => request.body as PatchConfigRequest);
    expect(second!.baseVersion).not.toBe(first!.baseVersion);
    expect(project.backend.config.team.roleOverrides?.developer?.duties).toEqual(
      expect.arrayContaining(['research', 'docs']),
    );
  });

  it('puts the matrix back and says who saved first on a conflict, replaying nothing', async () => {
    const project = renderMatrix();
    const region = await matrix();
    project.backend.handle('PATCH', '/api/projects/AC/config', {
      baseVersion: project.backend.configVersion,
      project: { name: 'Saved elsewhere' },
    });
    const cell = box(region, 'research', 'developer');
    fireEvent.click(cell);
    fireEvent.click(box(region, 'docs', 'developer'));
    await region.findByRole('status');
    await waitFor(() => expect(box(region, 'research', 'developer').checked).toBe(false));
    expect(project.backend.config.team.roleOverrides?.developer).toBeUndefined();
    expect(patches(project)).toHaveLength(1);
  });

  it('does not save a cell that would add an error, and says why at the cell', async () => {
    const project = renderMatrix();
    const region = await matrix();
    const approval = box(region, 'release_approval', 'operator');
    expect(approval.checked).toBe(true);
    fireEvent.click(approval);
    const alert = await region.findByRole('alert');
    expect(approval.getAttribute('aria-describedby')).toBe(alert.id);
    expect(patches(project)).toHaveLength(0);
    expect(box(region, 'release_approval', 'operator').checked).toBe(true);
    // The next successful save takes the sentence away.
    fireEvent.click(box(region, 'research', 'developer'));
    await waitFor(() => expect(region.queryByRole('alert')).toBeNull());
  });

  it('locks what only an owner may change for an admin, and the duties only a human can hold', async () => {
    const project = mockProject();
    asAdmin(project);
    project.render(<SettingsTestRoutes initialSection="duties" />, '/', nonOwnerAdmin);
    const region = await matrix();
    const locale = getLocale(project.backend.config.project.language);
    const locked = region.getByLabelText(
      t('duties.lockedLabel', {
        duty: locale.duties.release_approval.name,
        role: locale.roles.operator.name,
      }),
    ) as HTMLInputElement;
    expect(locked.disabled).toBe(true);
    expect(locked.closest('span')?.getAttribute('title')).toBe(t('duties.ownerOnly'));
    // The sentence is said once in the row header, not in every locked cell.
    expect(locked.closest('td')?.textContent).not.toContain(t('duties.ownerOnly'));
    expect(locked.closest('tr')?.querySelector('th')?.textContent).toContain(t('duties.ownerOnly'));
    // The four-eyes switch is the owner's: locked, and it says so beside the switch.
    expect((region.getByLabelText(t('duties.fourEyes')) as HTMLInputElement).disabled).toBe(true);
    expect(region.getByText(t('duties.fourEyesOwnerOnly'))).toBeTruthy();
    // A duty only a human can hold is locked for a role an AI member has, without the owner-only lock.
    const human = box(region, 'final_decision', 'developer');
    expect(human.disabled).toBe(true);
    expect(region.getAllByText(t('duties.humanOnly')).length).toBeGreaterThan(0);
    expect(region.getAllByText(t('duties.missing')).length).toBeGreaterThan(0);
    fireEvent.click(locked);
    expect(patches(project)).toHaveLength(0);
  });

  it('shows a member the matrix read-only', async () => {
    const project = renderMatrix(member);
    const region = await matrix();
    expect(region.getByText(t('duties.readOnly'))).toBeTruthy();
    const boxes = Array.from(
      screen.getByRole('region', { name: t('duties.title') }).querySelectorAll('input[type="checkbox"]'),
    ) as HTMLInputElement[];
    expect(boxes.every((input) => input.disabled)).toBe(true);
    expect(region.queryByRole('button', { name: t('duties.add') })).toBeNull();
    expect(region.queryByRole('button', { name: t('duties.reset') })).toBeNull();
    expect(patches(project)).toHaveLength(0);
  });

  it('shows coverage by people, where only the four-eyes switch can be changed', async () => {
    renderMatrix();
    const region = await matrix();
    fireEvent.click(region.getByRole('button', { name: t('duties.people') }));
    // A plain DOM query: getAllByRole('checkbox') computes the accessible tree of all ~270
    // checkboxes, which took about half a second and several times that under load.
    const enabled = Array.from(
      screen.getByRole('region', { name: t('duties.title') }).querySelectorAll('input[type="checkbox"]'),
    ).filter((input) => !(input as HTMLInputElement).disabled);
    expect(enabled).toEqual([region.getByLabelText(t('duties.fourEyes'))]);
  });

  describe('the texts of a role', () => {
    const field = (region: ReturnType<typeof within>, key: string, role: string) =>
      region.getByLabelText(
        `${key === 'instructions' ? t('duties.extra') : t(`roleCatalogue.${key as 'summary'}`)}: ${role}`,
      ) as HTMLTextAreaElement;

    it('saves one text on its own while another stays unsaved, and writes only what differs from the default', async () => {
      const project = renderMatrix();
      const region = await matrix();
      const locale = getLocale(project.backend.config.project.language);
      const developer = locale.roles.developer.name;
      expect(field(region, 'whenToAsk', developer).value).toBe(locale.roles.developer.whenToAsk);
      fireEvent.change(field(region, 'whenToAsk', developer), { target: { value: 'Ha kész a kártya.' } });
      fireEvent.change(field(region, 'notTheirJob', developer), { target: { value: 'Nem dönt.' } });
      // Typing the default text back is no change.
      fireEvent.change(field(region, 'summary', developer), {
        target: { value: locale.roles.developer.summary },
      });
      expect(patches(project)).toHaveLength(0);
      const saves = region.getAllByRole('button', { name: t('settings.pipeline.edit.save') });
      expect(saves).toHaveLength(2);
      // The rows are in the order notTheirJob, whenToAsk: the first Save belongs to notTheirJob.
      fireEvent.click(saves[0]!);
      await waitFor(() =>
        expect(project.backend.config.team.roleOverrides?.developer).toMatchObject({
          notTheirJob: 'Nem dönt.',
        }),
      );
      expect(project.backend.config.team.roleOverrides?.developer?.whenToAsk).toBeUndefined();
      expect(field(region, 'whenToAsk', developer).value).toBe('Ha kész a kártya.');
      fireEvent.click(region.getByRole('button', { name: t('settings.pipeline.edit.cancel') }));
      expect(field(region, 'whenToAsk', developer).value).toBe(locale.roles.developer.whenToAsk);
    });

    it('saves a custom role text with Ctrl+Enter and drops a change with Esc', async () => {
      const project = mockProject();
      project.backend.config.team.roles.push({
        id: 'data_steward',
        name: 'Data steward',
        summary: 'Keeps the reference data clean.',
        notTheirJob: '',
        holders: 'both',
        duties: ['docs'],
        instructions: '',
      });
      project.render(<SettingsTestRoutes initialSection="duties" />);
      const region = await matrix();
      const steward = field(region, 'whenToAsk', 'Data steward');
      fireEvent.change(steward, { target: { value: 'When data looks wrong.' } });
      fireEvent.keyDown(steward, { key: 'Enter', ctrlKey: true });
      await waitFor(() =>
        expect(project.backend.config.team.roles[0]).toMatchObject({ whenToAsk: 'When data looks wrong.' }),
      );
      const note = field(region, 'notTheirJob', 'Data steward');
      fireEvent.change(note, { target: { value: 'Not the schema.' } });
      fireEvent.keyDown(note, { key: 'Escape' });
      expect(note.value).toBe('');
      expect(patches(project)).toHaveLength(1);
    });
  });

  it('opens custom role creation from the matrix', async () => {
    const project = renderMatrix();
    const region = await matrix();
    fireEvent.click(region.getByRole('button', { name: t('duties.add') }));
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.change(dialog.getByLabelText(t('roleCatalogue.id')), { target: { value: 'example_role' } });
    fireEvent.change(dialog.getByLabelText(t('roleCatalogue.name')), { target: { value: 'Example role' } });
    fireEvent.change(dialog.getByLabelText(t('roleCatalogue.summary')), {
      target: { value: 'Researches examples.' },
    });
    fireEvent.click(dialog.getByRole('button', { name: t('memberEdit.save') }));
    await waitFor(() =>
      expect(project.backend.config.team.roles.some((r) => r.id === 'example_role')).toBe(true),
    );
    await screen.findByRole('columnheader', { name: /Example role/ });
  });
});

describe('duty matrix on a phone', () => {
  afterEach(() => vi.restoreAllMocks());
  function onAPhone() {
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }));
  }

  it('shows one folding card per role and saves a checked duty at once like the table', async () => {
    onAPhone();
    const project = renderMatrix();
    const region = await matrix();
    expect(region.queryByRole('table')).toBeNull();
    const locale = getLocale(project.backend.config.project.language);
    const card = region
      .getByText(locale.roles.developer.name, { selector: 'summary span' })
      .closest('details') as HTMLDetailsElement;
    // Folded until opened.
    expect(card.open).toBe(false);
    card.open = true;
    const cell = within(card).getByLabelText(
      `${locale.duties.research.name}: ${locale.roles.developer.name}`,
    ) as HTMLInputElement;
    expect(cell.checked).toBe(false);
    fireEvent.click(cell);
    await waitFor(() =>
      expect(project.backend.config.team.roleOverrides?.developer?.duties).toContain('research'),
    );
    expect(region.queryByRole('button', { name: t('memberEdit.save') })).toBeNull();
    // The role's texts are fields of the card.
    expect(card.querySelectorAll('textarea')).toHaveLength(4);
  });

  it('lists the duties of each person in the people view', async () => {
    onAPhone();
    const project = renderMatrix();
    const region = await matrix();
    fireEvent.click(region.getByRole('button', { name: t('duties.people') }));
    const owner = project.backend.config.team.members.find((m) => m.handle === 'owner')!;
    const card = region.getByText(owner.displayName, { selector: 'summary span' }).closest('details')!;
    expect(within(card).getAllByRole('listitem').length).toBeGreaterThan(0);
  });
});
