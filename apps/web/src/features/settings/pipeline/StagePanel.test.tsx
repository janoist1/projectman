import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useNavigate } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { queryKeys } from '../../../api/queryKeys';
import { ToastProvider } from '../../../components/Toast';
import { t } from '../../../i18n/t';
import { mockProject } from '../../../test/mockProject';
import { SettingsTestRoutes } from '../testRoutes';

const PIPELINE = '/p/AC/settings/pipeline';
const nonOwnerAdmin = { can: { manageTeam: true }, isOwner: false };
const member = { can: { manageTeam: false, createTasks: false, workInSessions: false }, isOwner: false };

beforeEach(() => window.localStorage.clear());

function BackButton() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(-1)}>
      back
    </button>
  );
}

function renderPanel(
  route = `${PIPELINE}?show=stage:dev`,
  overrides: Parameters<ReturnType<typeof mockProject>['render']>[2] = {},
) {
  const project = mockProject();
  const view = project.render(
    <ToastProvider>
      <SettingsTestRoutes initialSection="pipeline" />
      <BackButton />
    </ToastProvider>,
    route,
    overrides,
  );
  return Object.assign(project, { client: view.client });
}

/** The settings reload the way a live update makes them. */
async function reload(project: ReturnType<typeof renderPanel>) {
  await act(async () => {
    await project.client.invalidateQueries({ queryKey: queryKeys.config('AC') });
  });
}

async function panel() {
  return within(await screen.findByRole('dialog'));
}

function patches(project: ReturnType<typeof mockProject>) {
  return project.requests.filter((request) => request.method === 'PATCH' && request.path.endsWith('/config'));
}

/** Another admin saved a change to the description of a stage after this panel loaded the settings. */
function saveElsewhere(project: ReturnType<typeof mockProject>, stageId: string) {
  const stage = project.backend.config.pipeline.stages.find((candidate) => candidate.id === stageId)!;
  stage.description = 'Changed elsewhere';
  project.backend.configVersion = 'other-save';
  project.backend.history.unshift({
    version: 'other-save',
    message: 'Changed elsewhere',
    author: 'kata',
    at: new Date().toISOString(),
  });
}

describe('stage panel editor', () => {
  it('saves one field with one request carrying the whole pipeline, and cancel leaves no trace', async () => {
    const project = renderPanel();
    const dialog = await panel();
    const name = await dialog.findByLabelText(t('settings.pipeline.edit.name'));
    const save = dialog.getByRole('button', { name: t('settings.pipeline.edit.save') });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(name, { target: { value: 'Építés' } });
    fireEvent.click(dialog.getByRole('button', { name: t('settings.pipeline.edit.cancel') }));
    expect((name as HTMLInputElement).value).toBe('Fejlesztés');
    expect(patches(project)).toHaveLength(0);

    fireEvent.change(name, { target: { value: 'Építés' } });
    fireEvent.click(save);
    await waitFor(() => expect(patches(project)).toHaveLength(1));
    const body = patches(project)[0]!.body as {
      baseVersion: string;
      pipeline: { stages: Array<{ id: string; name: string }> };
    };
    expect(body.pipeline.stages).toHaveLength(project.backend.config.pipeline.stages.length);
    expect(project.backend.config.pipeline.stages.find((stage) => stage.id === 'dev')!.name).toBe('Építés');
    // The panel stays open, titled with the saved name.
    expect(await dialog.findByRole('heading', { name: 'Építés' })).toBeTruthy();
  });

  it('keeps the kind of the first stage locked and says why', async () => {
    renderPanel(`${PIPELINE}?show=stage:ready`);
    const dialog = await panel();
    await dialog.findByLabelText(t('settings.pipeline.edit.name'));
    const queue = dialog.getByRole('radio', { name: t('stageKinds.queue') }) as HTMLInputElement;
    expect(queue.matches(':disabled')).toBe(true);
    expect(dialog.getByText(t('settings.pipeline.edit.kindFirst'))).toBeTruthy();
  });

  it('keeps the draft after a conflict, names who saved, and the re-save carries both changes', async () => {
    const project = renderPanel();
    const dialog = await panel();
    const name = await dialog.findByLabelText(t('settings.pipeline.edit.name'));
    fireEvent.change(name, { target: { value: 'Építés' } });
    saveElsewhere(project, 'qa');
    fireEvent.click(dialog.getByRole('button', { name: t('settings.pipeline.edit.save') }));

    const member = project.backend.config.team.members.find((candidate) => candidate.handle === 'kata')!;
    await dialog.findByText(t('settings.pipeline.edit.conflict', { name: member.displayName }));
    expect((name as HTMLInputElement).value).toBe('Építés');

    fireEvent.click(dialog.getByRole('button', { name: t('settings.pipeline.edit.save') }));
    await waitFor(() =>
      expect(project.backend.config.pipeline.stages.find((stage) => stage.id === 'dev')?.name).toBe('Építés'),
    );
    const other = project.backend.config.pipeline.stages.find((candidate) => candidate.id === 'qa')!;
    expect(other.description).toBe('Changed elsewhere');
  });

  it('raises the conflict band when a live update changes the very stage being edited', async () => {
    const project = renderPanel();
    const dialog = await panel();
    const name = await dialog.findByLabelText(t('settings.pipeline.edit.name'));
    fireEvent.change(name, { target: { value: 'Építés' } });
    saveElsewhere(project, 'dev');
    await reload(project);

    const kata = project.backend.config.team.members.find((candidate) => candidate.handle === 'kata')!;
    await dialog.findByText(t('settings.pipeline.edit.conflict', { name: kata.displayName }));
    expect((name as HTMLInputElement).value).toBe('Építés');
    expect(patches(project)).toHaveLength(0);
  });

  it('merges silently when a live update changes another stage than the one being edited', async () => {
    const project = renderPanel();
    const dialog = await panel();
    fireEvent.change(await dialog.findByLabelText(t('settings.pipeline.edit.name')), {
      target: { value: 'Építés' },
    });
    saveElsewhere(project, 'qa');
    await reload(project);
    await waitFor(() => expect(project.backend.history[0]?.version).toBe('other-save'));

    fireEvent.click(dialog.getByRole('button', { name: t('settings.pipeline.edit.save') }));
    await waitFor(() => expect(patches(project)).toHaveLength(1));
    const kata = project.backend.config.team.members.find((candidate) => candidate.handle === 'kata')!;
    expect(dialog.queryByText(t('settings.pipeline.edit.conflict', { name: kata.displayName }))).toBeNull();
  });

  it('tells that the stage is gone when it was deleted meanwhile, and only closes', async () => {
    const project = renderPanel();
    const dialog = await panel();
    const name = await dialog.findByLabelText(t('settings.pipeline.edit.name'));
    fireEvent.change(name, { target: { value: 'Építés' } });
    project.backend.config.pipeline.stages = project.backend.config.pipeline.stages.filter(
      (stage) => stage.id !== 'dev',
    );
    project.backend.configVersion = 'other-save';
    project.backend.history.unshift({
      version: 'other-save',
      message: 'Deleted',
      author: 'kata',
      at: new Date().toISOString(),
    });
    fireEvent.click(dialog.getByRole('button', { name: t('settings.pipeline.edit.save') }));
    await dialog.findByText(t('settings.pipeline.edit.gone'));
    expect(
      dialog.getAllByRole('button', { name: t('settings.pipeline.edit.goneClose') }).length,
    ).toBeGreaterThan(0);
    expect(dialog.queryByRole('button', { name: t('settings.pipeline.edit.save') })).toBeNull();
  });

  it('undoes a save from the toast with a request that carries the earlier pipeline', async () => {
    const project = renderPanel();
    const dialog = await panel();
    const name = await dialog.findByLabelText(t('settings.pipeline.edit.name'));
    fireEvent.change(name, { target: { value: 'Építés' } });
    fireEvent.click(dialog.getByRole('button', { name: t('settings.pipeline.edit.save') }));
    fireEvent.click(await screen.findByRole('button', { name: t('settings.pipeline.edit.undo') }));
    await waitFor(() => expect(patches(project)).toHaveLength(2));
    await waitFor(() =>
      expect(project.backend.config.pipeline.stages.find((stage) => stage.id === 'dev')?.name).toBe(
        'Fejlesztés',
      ),
    );
  });

  it('refuses the undo with a message when someone else saved after the change', async () => {
    const project = renderPanel();
    const dialog = await panel();
    const name = await dialog.findByLabelText(t('settings.pipeline.edit.name'));
    fireEvent.change(name, { target: { value: 'Építés' } });
    fireEvent.click(dialog.getByRole('button', { name: t('settings.pipeline.edit.save') }));
    const undo = await screen.findByRole('button', { name: t('settings.pipeline.edit.undo') });
    saveElsewhere(project, 'qa');
    fireEvent.click(undo);
    await screen.findByText(t('settings.pipeline.edit.undoConflict'));
    expect(project.backend.config.pipeline.stages.find((stage) => stage.id === 'dev')?.name).toBe('Építés');
  });

  it('asks before leaving a changed stage for another one, and goes on when the change is dropped', async () => {
    const project = renderPanel();
    const dialog = await panel();
    fireEvent.change(await dialog.findByLabelText(t('settings.pipeline.edit.name')), {
      target: { value: 'Építés' },
    });
    const flow = await screen.findByRole('region', { name: t('settings.sections.pipeline') });
    fireEvent.click(flow.querySelector('[data-show="stage:qa"]')!);
    const leave = within(await screen.findByRole('dialog', { name: t('settings.pipeline.edit.leaveTitle') }));

    fireEvent.click(leave.getByRole('button', { name: t('settings.pipeline.edit.leaveKeep') }));
    expect(screen.queryByRole('dialog', { name: t('settings.pipeline.edit.leaveTitle') })).toBeNull();
    expect(flow.querySelector('[data-show="stage:dev"]')?.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(flow.querySelector('[data-show="stage:qa"]')!);
    const again = within(await screen.findByRole('dialog', { name: t('settings.pipeline.edit.leaveTitle') }));
    fireEvent.click(again.getByRole('button', { name: t('settings.pipeline.edit.leaveDiscard') }));
    await waitFor(() =>
      expect(flow.querySelector('[data-show="stage:qa"]')?.getAttribute('aria-pressed')).toBe('true'),
    );
    expect(patches(project)).toHaveLength(0);
  });

  it('asks before the Back button leaves a changed stage, and keeps the panel on "continue"', async () => {
    renderPanel(`${PIPELINE}?show=stage:dev`);
    const flow = await screen.findByRole('region', { name: t('settings.sections.pipeline') });
    await waitFor(() => expect(flow.querySelector('[data-show="stage:qa"]')).not.toBeNull());
    fireEvent.click(flow.querySelector('[data-show="stage:qa"]')!);
    const dialog = await panel();
    fireEvent.change(await dialog.findByLabelText(t('settings.pipeline.edit.name')), {
      target: { value: 'Próba' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'back' }));
    const leave = within(await screen.findByRole('dialog', { name: t('settings.pipeline.edit.leaveTitle') }));
    fireEvent.click(leave.getByRole('button', { name: t('settings.pipeline.edit.leaveKeep') }));
    expect(flow.querySelector('[data-show="stage:qa"]')?.getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByLabelText(t('settings.pipeline.edit.name')) as HTMLInputElement).value).toBe('Próba');
  });

  it('locks an approval row for an admin who is not an owner and blocks the save of an approver change', async () => {
    renderPanel(`${PIPELINE}?show=stage:release`, nonOwnerAdmin);
    const dialog = await panel();
    await dialog.findByLabelText(t('settings.pipeline.edit.name'));
    expect(dialog.getAllByText(t('settings.edit.approvalOwnerOnly')).length).toBeGreaterThan(0);
    const remove = dialog.getAllByRole('button', { name: t('settings.pipeline.edit.removeCondition') });
    expect(remove.some((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    // A release stage that is no release any more drops its approvers: the owner's decision.
    fireEvent.click(dialog.getByRole('radio', { name: t('stageKinds.step') }));
    const save = dialog.getByRole('button', { name: t('settings.pipeline.edit.save') });
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });

  it('gives a member no editor fields', async () => {
    renderPanel(`${PIPELINE}?show=stage:dev`, member);
    const dialog = await panel();
    await dialog.findByText(t('settings.pipeline.memberNote'));
    expect(dialog.queryByLabelText(t('settings.pipeline.edit.name'))).toBeNull();
    expect(dialog.queryByRole('button', { name: t('settings.pipeline.edit.save') })).toBeNull();
  });

  it('adds an owner from the picker with the keyboard only', async () => {
    renderPanel(`${PIPELINE}?show=stage:qa`);
    const dialog = await panel();
    await dialog.findByLabelText(t('settings.pipeline.edit.name'));
    fireEvent.click(dialog.getByRole('button', { name: t('settings.pipeline.edit.addMember') }));
    const search = dialog.getByRole('combobox', { name: t('settings.pipeline.edit.memberSearch') });
    const gone = () => dialog.queryByRole('combobox', { name: t('settings.pipeline.edit.memberSearch') });
    expect(document.activeElement).toBe(search);
    fireEvent.change(search, { target: { value: 'kata' } });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(gone()).toBeNull();
    expect(
      dialog.getByRole('button', { name: t('settings.pipeline.edit.removeMember', { name: 'Kata' }) }),
    ).toBeTruthy();
    expect(
      (dialog.getByRole('button', { name: t('settings.pipeline.edit.save') }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('names an AI member by the role catalogue in the picker, not by the role id', async () => {
    renderPanel(`${PIPELINE}?show=stage:qa`);
    const dialog = await panel();
    await dialog.findByLabelText(t('settings.pipeline.edit.name'));
    fireEvent.click(dialog.getByRole('button', { name: t('settings.pipeline.edit.addMember') }));
    const list = await dialog.findByRole('listbox');
    await waitFor(() => expect(list.textContent).not.toMatch(/[a-z]+_[a-z]+/));
  });

  it('closes the picker with Escape and keeps the panel open', async () => {
    renderPanel(`${PIPELINE}?show=stage:qa`);
    const dialog = await panel();
    await dialog.findByLabelText(t('settings.pipeline.edit.name'));
    fireEvent.click(dialog.getByRole('button', { name: t('settings.pipeline.edit.addMember') }));
    const search = { name: t('settings.pipeline.edit.memberSearch') };
    fireEvent.keyDown(dialog.getByRole('combobox', search), { key: 'Escape' });
    expect(dialog.queryByRole('combobox', search)).toBeNull();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('shows a live error on the name and keeps the save off', async () => {
    renderPanel();
    const dialog = await panel();
    fireEvent.change(await dialog.findByLabelText(t('settings.pipeline.edit.name')), {
      target: { value: ' ' },
    });
    expect(dialog.getByText(t('settings.pipeline.edit.nameRequired'))).toBeTruthy();
    expect(
      (dialog.getByRole('button', { name: t('settings.pipeline.edit.save') }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
