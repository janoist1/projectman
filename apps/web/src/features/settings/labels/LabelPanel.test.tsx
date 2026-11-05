import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LabelDefinition } from '@projectman/shared';
import { queryKeys } from '../../../api/queryKeys';
import { ToastProvider } from '../../../components/Toast';
import { t } from '../../../i18n/t';
import { labelId } from '../../../lib/ids';
import { mockProject } from '../../../test/mockProject';
import { server } from '../../../test/msw/server';
import { SettingsTestRoutes } from '../testRoutes';

const LABELS = '/p/AC/settings/labels';
const nonOwnerAdmin = { can: { manageTeam: true }, isOwner: false };
const member = { can: { manageTeam: false, createTasks: false, workInSessions: false }, isOwner: false };
const URGENT: LabelDefinition = {
  id: 'urgent',
  name: 'Sürgős',
  meaning: 'Előre kell venni.',
  setBy: 'anyone',
};

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());

/** A project that also has a free label, which no gate uses. */
function renderPanel(
  route = `${LABELS}?show=label:urgent`,
  overrides: Parameters<ReturnType<typeof mockProject>['render']>[2] = {},
) {
  const project = mockProject();
  project.backend.config.pipeline.labels.push({ ...URGENT });
  const view = project.render(
    <ToastProvider>
      <SettingsTestRoutes initialSection="labels" />
    </ToastProvider>,
    route,
    overrides,
  );
  return Object.assign(project, { client: view.client });
}

async function panel() {
  return within(await screen.findByRole('dialog'));
}

function patches(project: ReturnType<typeof mockProject>) {
  return project.requests.filter((request) => request.method === 'PATCH' && request.path.endsWith('/config'));
}

function savedLabel(project: ReturnType<typeof mockProject>, id: string) {
  return project.backend.config.pipeline.labels.find((label) => label.id === id);
}

function row(id: string) {
  return document.querySelector<HTMLElement>(`[data-label-row="${id}"]`);
}

/** Another admin changed the meaning of a label after this panel loaded the settings. */
function saveElsewhere(project: ReturnType<typeof mockProject>, id: string) {
  savedLabel(project, id)!.meaning = 'Changed elsewhere';
  project.backend.configVersion = 'other-save';
  project.backend.history.unshift({
    version: 'other-save',
    message: 'Changed elsewhere',
    author: 'kata',
    at: new Date().toISOString(),
  });
}

describe('label list', () => {
  it('lists the labels with who sets them and where they gate, and searches name, meaning and id', async () => {
    renderPanel(LABELS);
    await screen.findByRole('searchbox', { name: t('settings.labels.edit.searchLabel') });
    expect(row('urgent')).not.toBeNull();
    expect(row('qa-ok')!.textContent).toContain(t('settings.labels.edit.rowGate', { stages: 'Ügyfélteszt' }));

    const search = screen.getByRole('searchbox', { name: t('settings.labels.edit.searchLabel') });
    fireEvent.change(search, { target: { value: 'előre kell' } });
    expect(row('urgent')).not.toBeNull();
    expect(row('qa-ok')).toBeNull();

    fireEvent.change(search, { target: { value: 'release-appr' } });
    expect(row('release-approved')).not.toBeNull();
    expect(row('urgent')).toBeNull();

    fireEvent.change(search, { target: { value: 'nincs-ilyen' } });
    expect(await screen.findByText(t('settings.labels.edit.noMatch', { q: 'nincs-ilyen' }))).toBeTruthy();
  });

  it('counts the matches and clears the search from the empty result', async () => {
    renderPanel(LABELS);
    const search = await screen.findByRole('searchbox', { name: t('settings.labels.edit.searchLabel') });
    fireEvent.change(search, { target: { value: 'nincs-ilyen' } });
    expect(await screen.findByText(t('settings.labels.edit.found', { count: 0 }))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('settings.labels.edit.clearSearch') }));
    expect((search as HTMLInputElement).value).toBe('');
    expect(row('urgent')).not.toBeNull();
  });

  it('offers a retry when the tags used on cards cannot be loaded', async () => {
    server.use(
      http.get('http://localhost/api/projects/AC/board', () =>
        HttpResponse.json({ error: { code: 'internal', message: 'Down' } }, { status: 500 }),
      ),
    );
    renderPanel(LABELS);
    expect(await screen.findByRole('button', { name: t('app.retry') })).toBeTruthy();
    expect(row('urgent')).not.toBeNull();
  });

  it('opens a label from its row and offers the add button to an admin only', async () => {
    renderPanel(LABELS);
    await screen.findByRole('button', { name: t('settings.labels.add') });
    fireEvent.click(row('urgent')!);
    const dialog = await panel();
    expect(await dialog.findByRole('heading', { name: 'Sürgős' })).toBeTruthy();
  });

  it('gives a member the list and a read-only panel with the reason, and no add button', async () => {
    renderPanel(`${LABELS}?show=label:qa-ok`, member);
    const dialog = await panel();
    await dialog.findByText(t('settings.pipeline.memberNote'));
    expect(dialog.queryByLabelText(t('settings.labels.name'))).toBeNull();
    expect(dialog.queryByRole('textbox')).toBeNull();
    expect(dialog.queryByRole('button', { name: t('settings.pipeline.edit.save') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('settings.labels.add') })).toBeNull();
  });

  it('fits a 360 px phone: the panel is a dialog and the list keeps no fixed width', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      // Not wide: the settings panel is a dialog over the list.
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }));
    window.innerWidth = 360;
    renderPanel(`${LABELS}?show=label:urgent`);
    const dialog = await panel();
    await dialog.findByLabelText(t('settings.labels.name'));
    expect(screen.queryByRole('complementary')).toBeNull();
    for (const element of [row('urgent')!, ...document.querySelectorAll<HTMLElement>('input, textarea')]) {
      expect(element.style.width).toBe('');
      expect(element.getAttribute('width')).toBeNull();
    }
  });
});

describe('label panel editor', () => {
  it('saves several fields with one request carrying the whole pipeline', async () => {
    const project = renderPanel();
    const dialog = await panel();
    const save = dialog.getByRole('button', { name: t('settings.pipeline.edit.save') });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(await dialog.findByLabelText(t('settings.labels.name')), {
      target: { value: 'Rohanó' },
    });
    fireEvent.change(dialog.getByLabelText(t('settings.labels.meaning')), {
      target: { value: 'Most kell.' },
    });
    fireEvent.click(dialog.getByRole('radio', { name: t('columnColors.red') }));
    fireEvent.click(dialog.getByRole('checkbox', { name: t('settings.labels.requiresComment') }));
    fireEvent.click(save);

    await waitFor(() => expect(patches(project)).toHaveLength(1));
    const body = patches(project)[0]!.body as { pipeline: { labels: LabelDefinition[] } };
    expect(body.pipeline.labels).toHaveLength(project.backend.config.pipeline.labels.length);
    expect(savedLabel(project, 'urgent')).toMatchObject({
      name: 'Rohanó',
      meaning: 'Most kell.',
      color: 'red',
      requiresComment: true,
    });
    expect(await dialog.findByRole('heading', { name: 'Rohanó' })).toBeTruthy();
  });

  it('shows the gates that use the label and links them to the pipeline', async () => {
    renderPanel(`${LABELS}?show=label:qa-ok`);
    const dialog = await panel();
    const link = await dialog.findByRole('link', { name: /Ügyfélteszt/ });
    expect(link.getAttribute('href')).toBe('/p/AC/settings/pipeline?show=stage:client_test');
  });

  it('keeps the draft after a conflict, and the re-save carries both changes', async () => {
    const project = renderPanel();
    const dialog = await panel();
    const name = await dialog.findByLabelText(t('settings.labels.name'));
    fireEvent.change(name, { target: { value: 'Rohanó' } });
    project.backend.config.pipeline.labels.find((label) => label.id === 'qa-ok')!.meaning = 'Elsewhere';
    project.backend.configVersion = 'other-save';
    project.backend.history.unshift({
      version: 'other-save',
      message: 'Changed elsewhere',
      author: 'kata',
      at: new Date().toISOString(),
    });
    fireEvent.click(dialog.getByRole('button', { name: t('settings.pipeline.edit.save') }));

    const kata = project.backend.config.team.members.find((candidate) => candidate.handle === 'kata')!;
    await dialog.findByText(t('settings.pipeline.edit.conflict', { name: kata.displayName }));
    expect((name as HTMLInputElement).value).toBe('Rohanó');

    fireEvent.click(dialog.getByRole('button', { name: t('settings.pipeline.edit.save') }));
    await waitFor(() => expect(savedLabel(project, 'urgent')?.name).toBe('Rohanó'));
    expect(savedLabel(project, 'qa-ok')?.meaning).toBe('Elsewhere');
  });

  it('raises the conflict band when a live update changes the very label being edited', async () => {
    const project = renderPanel();
    const dialog = await panel();
    const name = await dialog.findByLabelText(t('settings.labels.name'));
    fireEvent.change(name, { target: { value: 'Rohanó' } });
    saveElsewhere(project, 'urgent');
    await act(async () => {
      await project.client.invalidateQueries({ queryKey: queryKeys.config('AC') });
    });
    const kata = project.backend.config.team.members.find((candidate) => candidate.handle === 'kata')!;
    await dialog.findByText(t('settings.pipeline.edit.conflict', { name: kata.displayName }));
    expect((name as HTMLInputElement).value).toBe('Rohanó');
    expect(patches(project)).toHaveLength(0);
  });

  it('keeps the approval labels and the human-only setting for the owner when an admin is not one', async () => {
    const project = renderPanel(`${LABELS}?show=label:release-approved`, nonOwnerAdmin);
    const dialog = await panel();
    await dialog.findByLabelText(t('settings.labels.name'));
    expect(dialog.getAllByText(t('settings.edit.approvalOwnerOnly')).length).toBeGreaterThan(0);
    expect(
      (dialog.getByRole('button', { name: t('settings.pipeline.edit.save') }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (dialog.getByLabelText(t('settings.labels.name')).closest('fieldset') as HTMLFieldSetElement).disabled,
    ).toBe(true);
    expect(patches(project)).toHaveLength(0);
  });

  it('keeps the saved chip while the name of an existing label is emptied', async () => {
    renderPanel();
    const dialog = await panel();
    fireEvent.change(await dialog.findByLabelText(t('settings.labels.name')), { target: { value: '' } });
    expect(dialog.queryByText(t('settings.labels.newName'))).toBeNull();
  });

  it('shows no setter choice for a label the system puts on', async () => {
    const project = mockProject();
    project.backend.config.pipeline.labels.push({ id: 'pr-merged', name: 'PR merged', setBy: 'system' });
    project.render(
      <ToastProvider>
        <SettingsTestRoutes initialSection="labels" />
      </ToastProvider>,
      `${LABELS}?show=label:pr-merged`,
    );
    const dialog = await panel();
    await dialog.findByLabelText(t('settings.labels.name'));
    expect(dialog.getByText(t('settings.labels.edit.systemSetter'))).toBeTruthy();
    expect(dialog.queryByRole('checkbox', { name: t('settings.labels.humansOnly') })).toBeNull();
  });

  it('lets a non-owner admin edit an ordinary label but not make it human-only', async () => {
    const project = renderPanel(`${LABELS}?show=label:urgent`, nonOwnerAdmin);
    const dialog = await panel();
    const humans = (await dialog.findByRole('radio', {
      name: t('settings.labels.whoOptions.humans'),
    })) as HTMLInputElement;
    expect(humans.disabled).toBe(true);
    fireEvent.change(dialog.getByLabelText(t('settings.labels.name')), { target: { value: 'Rohanó' } });
    fireEvent.click(dialog.getByRole('button', { name: t('settings.pipeline.edit.save') }));
    await waitFor(() => expect(savedLabel(project, 'urgent')?.name).toBe('Rohanó'));
  });
});

describe('new label', () => {
  it('takes the id from the name, saves one request and then shows the saved label', async () => {
    const project = renderPanel(LABELS);
    fireEvent.click(await screen.findByRole('button', { name: t('settings.labels.add') }));
    const dialog = await panel();
    const create = dialog.getByRole('button', { name: t('settings.labels.edit.create') });
    expect((create as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(await dialog.findByLabelText(t('settings.labels.name')), {
      target: { value: 'Várakozik' },
    });
    const id = labelId(
      'Várakozik',
      project.backend.config.pipeline.labels.map((label) => label.id),
    );
    expect(dialog.getByText(id)).toBeTruthy();
    fireEvent.click(create);

    await waitFor(() => expect(patches(project)).toHaveLength(1));
    expect(savedLabel(project, id)?.name).toBe('Várakozik');
    // The selection moved on to the label itself: its fixed id is shown and the form is the saved one.
    await screen.findByRole('heading', { name: 'Várakozik' });
    expect(
      within(await screen.findByRole('dialog')).getByRole('button', { name: t('settings.labels.remove') }),
    ).toBeTruthy();
    expect(await screen.findByText(t('settings.labels.edit.created', { name: 'Várakozik' }))).toBeTruthy();
  });

  it('closes the panel when the undo takes the new label away again', async () => {
    const project = renderPanel(LABELS);
    fireEvent.click(await screen.findByRole('button', { name: t('settings.labels.add') }));
    const dialog = await panel();
    fireEvent.change(await dialog.findByLabelText(t('settings.labels.name')), {
      target: { value: 'Várakozik' },
    });
    fireEvent.click(dialog.getByRole('button', { name: t('settings.labels.edit.create') }));
    await screen.findByRole('heading', { name: 'Várakozik' });

    fireEvent.click(await screen.findByRole('button', { name: t('settings.pipeline.edit.undo') }));
    await waitFor(() =>
      expect(project.backend.config.pipeline.labels.some((l) => l.name === 'Várakozik')).toBe(false),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: t('settings.labels.add') })),
    );
  });

  it('does not take a name that is empty', async () => {
    const project = renderPanel(LABELS);
    fireEvent.click(await screen.findByRole('button', { name: t('settings.labels.add') }));
    const dialog = await panel();
    fireEvent.change(await dialog.findByLabelText(t('settings.labels.name')), { target: { value: '   ' } });
    expect(
      (dialog.getByRole('button', { name: t('settings.labels.edit.create') }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(patches(project)).toHaveLength(0);
  });

  it('defines a tag used on cards: the name is prefilled and the id is the tag', async () => {
    const project = mockProject();
    project.backend.findTask('AC-20')!.labels.push('Sürgős');
    project.render(
      <ToastProvider>
        <SettingsTestRoutes initialSection="labels" />
      </ToastProvider>,
      LABELS,
    );
    const tagRow = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-tag-row="Sürgős"]');
      expect(found).not.toBeNull();
      return found!;
    });
    fireEvent.click(tagRow);
    const dialog = await panel();
    const name = (await dialog.findByLabelText(t('settings.labels.name'))) as HTMLInputElement;
    await waitFor(() => expect(name.value).toBe('Sürgős'));
    fireEvent.change(dialog.getByLabelText(t('settings.labels.meaning')), {
      target: { value: 'Előre kell.' },
    });
    fireEvent.click(dialog.getByRole('button', { name: t('settings.labels.edit.create') }));
    await waitFor(() => expect(patches(project)).toHaveLength(1));
    expect(savedLabel(project, 'Sürgős')).toMatchObject({ name: 'Sürgős', meaning: 'Előre kell.' });
  });
});

describe('deleting a label', () => {
  it('confirms, saves at once, and the undo from the toast brings the label back', async () => {
    const project = renderPanel();
    const dialog = await panel();
    fireEvent.click(await dialog.findByRole('button', { name: t('settings.labels.remove') }));
    const confirm = within(await screen.findByRole('alertdialog'));
    expect(document.activeElement).toBe(confirm.getByRole('button', { name: t('common.cancel') }));
    fireEvent.click(confirm.getByRole('button', { name: t('settings.labels.edit.removeConfirm') }));

    await waitFor(() => expect(savedLabel(project, 'urgent')).toBeUndefined());
    expect(patches(project)).toHaveLength(1);
    expect(await screen.findByText(t('settings.labels.edit.removed', { name: 'Sürgős' }))).toBeTruthy();

    fireEvent.click(await screen.findByRole('button', { name: t('settings.pipeline.edit.undo') }));
    await waitFor(() => expect(savedLabel(project, 'urgent')).toMatchObject({ name: 'Sürgős' }));
    expect(patches(project)).toHaveLength(2);
  });

  it('cancels without a request', async () => {
    const project = renderPanel();
    const dialog = await panel();
    fireEvent.click(await dialog.findByRole('button', { name: t('settings.labels.remove') }));
    const confirm = within(await screen.findByRole('alertdialog'));
    fireEvent.click(confirm.getByRole('button', { name: t('common.cancel') }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(savedLabel(project, 'urgent')).toBeDefined();
    expect(patches(project)).toHaveLength(0);
  });

  it('refuses a label that a gate requires, and names the stage', async () => {
    const project = renderPanel(`${LABELS}?show=label:qa-ok`);
    const dialog = await panel();
    const remove = (await dialog.findByRole('button', {
      name: t('settings.labels.remove'),
    })) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    expect(dialog.getByText(t('settings.labels.edit.removeUsed', { stages: 'Ügyfélteszt' }))).toBeTruthy();
    expect(patches(project)).toHaveLength(0);
  });

  it('refuses a label that a gate only refers to in a `when`', async () => {
    const project = mockProject();
    project.backend.config.pipeline.labels.push({ ...URGENT });
    project.backend.config.pipeline.stages.find((stage) => stage.id === 'qa')!.gate = {
      conditions: [{ type: 'has_label', label: 'code-review-ok', when: 'urgent' }],
    };
    project.render(
      <ToastProvider>
        <SettingsTestRoutes initialSection="labels" />
      </ToastProvider>,
      `${LABELS}?show=label:urgent`,
    );
    const dialog = await panel();
    const remove = (await dialog.findByRole('button', {
      name: t('settings.labels.remove'),
    })) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    expect(dialog.getByText(t('settings.labels.edit.removeUsed', { stages: 'QA' }))).toBeTruthy();
  });

  it('keeps the focus in the list after the delete', async () => {
    renderPanel();
    const dialog = await panel();
    fireEvent.click(await dialog.findByRole('button', { name: t('settings.labels.remove') }));
    const confirm = within(await screen.findByRole('alertdialog'));
    fireEvent.click(confirm.getByRole('button', { name: t('settings.labels.edit.removeConfirm') }));
    await waitFor(() => expect(row('urgent')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(row('release-approved')));
  });

  it('moves the focus to the next row after a delete in the middle, and back to the label on the undo', async () => {
    const project = mockProject();
    project.backend.config.pipeline.labels.push(
      { ...URGENT },
      { id: 'later', name: 'Később', setBy: 'anyone' },
    );
    project.render(
      <ToastProvider>
        <SettingsTestRoutes initialSection="labels" />
      </ToastProvider>,
      `${LABELS}?show=label:urgent`,
    );
    const dialog = await panel();
    fireEvent.click(await dialog.findByRole('button', { name: t('settings.labels.remove') }));
    const confirm = within(await screen.findByRole('alertdialog'));
    fireEvent.click(confirm.getByRole('button', { name: t('settings.labels.edit.removeConfirm') }));
    await waitFor(() => expect(row('urgent')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(row('later')));

    fireEvent.click(await screen.findByRole('button', { name: t('settings.pipeline.edit.undo') }));
    await waitFor(() => expect(row('urgent')).not.toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(row('urgent')));
  });
});
