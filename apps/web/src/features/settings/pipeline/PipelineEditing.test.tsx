import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { ToastProvider } from '../../../components/Toast';
import { t } from '../../../i18n/t';
import { server } from '../../../test/msw/server';
import { mockProject } from '../../../test/mockProject';
import { SettingsTestRoutes } from '../testRoutes';
import { NEW_COLUMN } from './stageDraft';

const PIPELINE = '/p/AC/settings/pipeline';
const nonOwnerAdmin = { can: { manageTeam: true }, isOwner: false };

beforeEach(() => window.localStorage.clear());

type Project = ReturnType<typeof mockProject>;

/** Renders the panel at a route; `prepare` shapes the backend before the page loads it. */
function renderAt(
  route: string,
  overrides: Parameters<Project['render']>[2] = {},
  prepare: (project: Project) => void = () => {},
) {
  const project = mockProject();
  prepare(project);
  project.render(
    <ToastProvider>
      <SettingsTestRoutes initialSection="pipeline" />
    </ToastProvider>,
    route,
    overrides,
  );
  return project;
}

async function panel() {
  return within(await screen.findByRole('dialog'));
}

function patches(project: ReturnType<typeof mockProject>) {
  return project.requests.filter((request) => request.method === 'PATCH' && request.path.endsWith('/config'));
}

function stageIds(project: ReturnType<typeof mockProject>) {
  return project.backend.config.pipeline.stages.map((stage) => stage.id);
}

const columnIdsInOrder = (project: ReturnType<typeof mockProject>) =>
  project.backend.config.pipeline.columns.map((column) => column.id);

/** The stage column of a stage, as the saved configuration has it. */
const columnOf = (project: ReturnType<typeof mockProject>, stageId: string) =>
  project.backend.config.pipeline.stages.find((stage) => stage.id === stageId)!.columnId;

/** A step needs an owner and the fixture has no duty holders: a queue stage is saved as it is. */
function nameQueueStage(dialog: ReturnType<typeof within>, name: string) {
  fireEvent.change(dialog.getByLabelText(t('settings.pipeline.edit.name')), { target: { value: name } });
  fireEvent.click(dialog.getByRole('radio', { name: t('stageKinds.queue') }));
}

describe('new stage', () => {
  it('puts a stage after the chosen one with an identifier from its name, in one request, and opens it', async () => {
    const project = renderAt(`${PIPELINE}?show=new-stage&after=dev`);
    const dialog = await panel();
    await dialog.findByLabelText(t('settings.pipeline.edit.name'));
    nameQueueStage(dialog, 'Design review');
    expect(dialog.getByText(t('settings.pipeline.new.idPreview', { id: 'design_review' }))).toBeTruthy();
    fireEvent.click(dialog.getByRole('button', { name: t('settings.pipeline.createStage') }));

    await waitFor(() => expect(patches(project)).toHaveLength(1));
    const ids = stageIds(project);
    expect(ids[ids.indexOf('dev') + 1]).toBe('design_review');
    // The panel moved on to the saved stage, which shows its identifier.
    expect(await screen.findByText('design_review', { selector: 'code' })).toBeTruthy();
  });

  it('suffixes the identifier when the name gives one that is taken', async () => {
    const project = renderAt(`${PIPELINE}?show=new-stage&after=dev`);
    const dialog = await panel();
    await dialog.findByLabelText(t('settings.pipeline.edit.name'));
    nameQueueStage(dialog, 'QA');
    expect(dialog.getByText(t('settings.pipeline.new.idPreview', { id: 'qa_2' }))).toBeTruthy();
    fireEvent.click(dialog.getByRole('button', { name: t('settings.pipeline.createStage') }));
    await waitFor(() => expect(stageIds(project)).toContain('qa_2'));
  });

  it('puts the stage in front of the first one when the address says so', async () => {
    const project = renderAt(`${PIPELINE}?show=new-stage&after=`);
    const dialog = await panel();
    const place = (await dialog.findByLabelText(t('settings.pipeline.new.place'))) as HTMLSelectElement;
    expect(place.value).toBe('');
    // The first stage must stay a queue: the new one cannot take its place as another kind.
    fireEvent.change(dialog.getByLabelText(t('settings.pipeline.edit.name')), { target: { value: 'Inbox' } });
    fireEvent.click(dialog.getByRole('radio', { name: t('stageKinds.queue') }));
    fireEvent.click(dialog.getByRole('button', { name: t('settings.pipeline.createStage') }));
    await waitFor(() => expect(patches(project)).toHaveLength(1));
    expect(stageIds(project)[0]).toBe('inbox');
  });

  it('keeps the save off until the name is there, and while a step has no owner', async () => {
    const project = renderAt(`${PIPELINE}?show=new-stage&after=dev`);
    const dialog = await panel();
    const save = dialog.getByRole('button', {
      name: t('settings.pipeline.createStage'),
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(await dialog.findByLabelText(t('settings.pipeline.edit.name')), {
      target: { value: 'X' },
    });
    // A named step without an owner is still refused by the rules, live.
    expect(await dialog.findByText(t('settings.pipeline.edit.fixFirst'))).toBeTruthy();
    expect(save.disabled).toBe(true);
    expect(patches(project)).toHaveLength(0);
  });

  it('creates a new column named like the stage and orders the columns by the stages', async () => {
    const project = renderAt(`${PIPELINE}?show=new-stage&after=dev`);
    const dialog = await panel();
    await dialog.findByLabelText(t('settings.pipeline.edit.name'));
    nameQueueStage(dialog, 'Design');
    fireEvent.change(dialog.getByLabelText(t('settings.pipeline.fields.column')), {
      target: { value: NEW_COLUMN },
    });
    expect(dialog.getByText(t('settings.pipeline.new.columnIdPreview', { id: 'design' }))).toBeTruthy();
    fireEvent.click(dialog.getByRole('button', { name: t('settings.pipeline.createStage') }));
    await waitFor(() => expect(patches(project)).toHaveLength(1));
    const columns = project.backend.config.pipeline.columns;
    expect(columns.find((column) => column.id === 'design')?.name).toBe('Design');
    expect(columnOf(project, 'design')).toBe('design');
    const order = columnIdsInOrder(project);
    expect(order.indexOf('design')).toBe(order.indexOf('dev') + 1);
  });

  it('falls back to the default place when the stage in the address does not exist', async () => {
    renderAt(`${PIPELINE}?show=new-stage&after=nothing`);
    const dialog = await panel();
    const place = (await dialog.findByLabelText(t('settings.pipeline.new.place'))) as HTMLSelectElement;
    expect(place.value).not.toBe('nothing');
  });

  it('offers a member no new-stage panel', async () => {
    renderAt(`${PIPELINE}?show=new-stage&after=dev`, {
      can: { manageTeam: false, createTasks: false, workInSessions: false },
      isOwner: false,
    });
    const section = await screen.findByRole('region', { name: t('settings.sections.pipeline') });
    await waitFor(() => expect(section.querySelectorAll('[data-show^="stage:"]').length).toBeGreaterThan(0));
    expect(screen.queryByLabelText(t('settings.pipeline.edit.name'))).toBeNull();
  });

  it('opens the new-stage panel from the header button, the insert button and the stage menu', async () => {
    renderAt(PIPELINE);
    const section = await screen.findByRole('region', { name: t('settings.sections.pipeline') });
    await waitFor(() => expect(section.querySelectorAll('[data-show^="stage:"]').length).toBeGreaterThan(0));
    fireEvent.click(within(section).getByRole('button', { name: t('settings.pipeline.addStage') }));
    expect(
      await (await panel()).findByRole('heading', { name: t('settings.pipeline.new.stageTitle') }),
    ).toBeTruthy();
    fireEvent.click(
      within(section).getAllByRole('button', {
        name: t('settings.pipeline.insertAfter', { name: 'Fejlesztés' }),
      })[0]!,
    );
    const place = (await (
      await panel()
    ).findByLabelText(t('settings.pipeline.new.place'))) as HTMLSelectElement;
    expect(place.value).toBe('dev');
  });

  it('opens the new-stage panel in front of or after a stage from the stage menu', async () => {
    renderAt(`${PIPELINE}?show=stage:dev`);
    const dialog = await panel();
    fireEvent.click(await dialog.findByRole('button', { name: t('settings.pipeline.menu.label') }));
    fireEvent.click(await screen.findByRole('button', { name: t('settings.pipeline.menu.after') }));
    const place = (await (
      await panel()
    ).findByLabelText(t('settings.pipeline.new.place'))) as HTMLSelectElement;
    expect(place.value).toBe('dev');
  });
});

describe('new column and column panel', () => {
  it('adds a column at the end of the stageless ones, and the section stays when it empties', async () => {
    const project = renderAt(PIPELINE);
    const section = await screen.findByRole('region', { name: t('settings.sections.pipeline') });
    expect(await within(section).findByText(t('settings.pipeline.noEmptyColumns'))).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: t('settings.pipeline.addColumn') }));
    const dialog = await panel();
    fireEvent.change(await dialog.findByLabelText(t('settings.pipeline.edit.name')), {
      target: { value: 'Parkoló' },
    });
    fireEvent.click(dialog.getByRole('button', { name: t('settings.pipeline.createColumn') }));
    await waitFor(() => expect(patches(project)).toHaveLength(1));
    expect(columnIdsInOrder(project).at(-1)).toBe('parkolo');
    expect(await screen.findByText('parkolo', { selector: 'code' })).toBeTruthy();
    await waitFor(() => expect(section.querySelector('[data-show="column:parkolo"]')).not.toBeNull());
  });

  it('renames a column and saves a colour only when it changes', async () => {
    const project = renderAt(`${PIPELINE}?show=column:review`);
    const dialog = await panel();
    const name = await dialog.findByLabelText(t('settings.pipeline.edit.name'));
    fireEvent.change(name, { target: { value: 'Ellenőrzés' } });
    fireEvent.click(dialog.getByRole('radio', { name: t('columnColors.purple') }));
    fireEvent.click(dialog.getByRole('button', { name: t('settings.pipeline.edit.save') }));
    await waitFor(() => expect(patches(project)).toHaveLength(1));
    const column = project.backend.config.pipeline.columns.find((candidate) => candidate.id === 'review')!;
    expect(column.name).toBe('Ellenőrzés');
    expect(column.color).toBe('purple');
    // The other columns kept the colour they showed.
    expect(project.backend.config.pipeline.columns.filter((candidate) => candidate.color)).toHaveLength(1);
  });

  it('lists the stages of a column as links to their panels', async () => {
    renderAt(`${PIPELINE}?show=column:review`);
    const dialog = await panel();
    fireEvent.click(await dialog.findByRole('button', { name: 'QA' }));
    expect(await (await panel()).findByRole('heading', { name: 'QA' })).toBeTruthy();
  });
});

describe('delete', () => {
  it('blocks the delete of a stage that still holds cards and says how many', async () => {
    const project = renderAt(`${PIPELINE}?show=stage:dev`);
    const count = project.backend.tasks.filter((task) => task.stageId === 'dev').length;
    expect(count).toBeGreaterThan(0);
    const dialog = await panel();
    const button = (await dialog.findByRole('button', {
      name: t('settings.pipeline.delete.stage'),
    })) as HTMLButtonElement;
    await waitFor(() =>
      expect(dialog.getByText(t('settings.pipeline.delete.cards', { count }))).toBeTruthy(),
    );
    expect(button.disabled).toBe(true);
  });

  it.each([
    ['the first stage', 'ready'],
    ['the last stage', 'done'],
  ])('blocks the delete of %s with the rule it would break', async (_name, stageId) => {
    renderAt(`${PIPELINE}?show=stage:${stageId}`, {}, (project) => project.backend.tasks.splice(0));
    const dialog = await panel();
    const button = (await dialog.findByRole('button', {
      name: t('settings.pipeline.delete.stage'),
    })) as HTMLButtonElement;
    expect(await dialog.findByText(/^Nem törölhető:/)).toBeTruthy();
    expect(button.disabled).toBe(true);
  });

  it('keeps an approval gate for the owner: an admin who is not an owner cannot delete the stage', async () => {
    renderAt(`${PIPELINE}?show=stage:release`, nonOwnerAdmin, (project) => project.backend.tasks.splice(0));
    const dialog = await panel();
    const button = (await dialog.findByRole('button', {
      name: t('settings.pipeline.delete.stage'),
    })) as HTMLButtonElement;
    expect(await dialog.findByText(t('settings.pipeline.delete.ownerOnly'))).toBeTruthy();
    expect(button.disabled).toBe(true);
  });

  it('deletes an empty stage after the question, at once, and undoes it from the toast', async () => {
    const project = renderAt(`${PIPELINE}?show=stage:qa`, {}, (shaped) => shaped.backend.tasks.splice(0));
    const before = stageIds(project);
    const dialog = await panel();
    const button = (await dialog.findByRole('button', {
      name: t('settings.pipeline.delete.stage'),
    })) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    const question = within(await screen.findByRole('alertdialog'));
    fireEvent.click(question.getByRole('button', { name: t('settings.pipeline.delete.confirm') }));
    await waitFor(() => expect(stageIds(project)).not.toContain('qa'));
    expect(patches(project)).toHaveLength(1);
    // The panel closed and the toast offers the way back.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(await screen.findByRole('button', { name: t('settings.pipeline.edit.undo') }));
    await waitFor(() => expect(stageIds(project)).toEqual(before));
  });

  it('deletes a column that has no stage', async () => {
    const project = renderAt(`${PIPELINE}?show=column:spare`, {}, (shaped) =>
      shaped.backend.config.pipeline.columns.push({ id: 'spare', name: 'Tartalék' }),
    );
    const dialog = await panel();
    const button = (await dialog.findByRole('button', {
      name: t('settings.pipeline.delete.column'),
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: t('settings.pipeline.delete.confirm'),
      }),
    );
    await waitFor(() => expect(columnIdsInOrder(project)).not.toContain('spare'));
    expect(patches(project)).toHaveLength(1);
  });

  it('blocks the delete of a column that still has stages and names them', async () => {
    renderAt(`${PIPELINE}?show=column:review`);
    const dialog = await panel();
    const button = (await dialog.findByRole('button', {
      name: t('settings.pipeline.delete.column'),
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(dialog.getByText(/QA/, { selector: 'p' })).toBeTruthy();
  });

  it('gives the server stage_in_use refusal the same message as the check', async () => {
    const project = renderAt(`${PIPELINE}?show=stage:qa`, {}, (shaped) => shaped.backend.tasks.splice(0));
    server.use(
      http.patch('http://localhost/api/projects/AC/config', () =>
        HttpResponse.json(
          { error: { code: 'stage_in_use', message: 'in use', details: { stageId: 'qa', tasks: 3 } } },
          { status: 409 },
        ),
      ),
    );
    const dialog = await panel();
    const button = (await dialog.findByRole('button', {
      name: t('settings.pipeline.delete.stage'),
    })) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: t('settings.pipeline.delete.confirm'),
      }),
    );
    expect(await dialog.findByText(t('settings.pipeline.delete.cards', { count: 3 }))).toBeTruthy();
    expect(stageIds(project)).toContain('qa');
  });
});
