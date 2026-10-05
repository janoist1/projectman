import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { MockBackend } from '../../mocks/backend';
import { ToastProvider } from '../../components/Toast';
import { createMockFetch, mockProject } from '../../test/mockProject';
import { BoardPage } from './BoardPage';
import { TaskDrawer } from './TaskDrawer';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

const drawer = (
  <ToastProvider>
    <Routes>
      <Route path="/p/:key/tasks/:taskKey" element={<TaskDrawer />} />
    </Routes>
  </ToastProvider>
);
const REASON = 'Átfogó adatmigráció';
const startRequests = (project: ReturnType<typeof mockProject>) =>
  project.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/start'));

/** A project whose backend developer `be-1` is the Senior; AC-24 (in "Indulhat") is a Senior card. */
function seniorProject(opts: { seniorCard?: boolean } = {}) {
  const backend = new MockBackend();
  expect(backend.handle('PATCH', '/api/projects/AC/members/be-1', { senior: true }).status).toBe(200);
  if (opts.seniorCard !== false)
    backend.findTask('AC-24')!.developerLevel = {
      level: 'senior',
      reason: REASON,
      setBy: 'owner',
      setAt: new Date().toISOString(),
    };
  return mockProject(backend);
}
const markLabel = t('task.level.markLabel', { reason: REASON });

describe('the Senior mark on a card (PM-349)', () => {
  it('marks a Senior card of an open stage, with the reason in its label, and no other card', async () => {
    const project = seniorProject();
    project.render(<BoardPage />);
    const mark = await screen.findByLabelText(markLabel);
    expect(mark.textContent).toBe(t('task.level.mark'));
    expect(mark.getAttribute('title')).toBe(markLabel);
    expect(screen.getAllByText(t('task.level.mark'))).toHaveLength(1);
  });

  it('does not mark a card that has no recommendation or recommends any developer', async () => {
    const project = seniorProject({ seniorCard: false });
    project.backend.findTask('AC-24')!.developerLevel = {
      level: 'any',
      reason: null,
      setBy: 'owner',
      setAt: new Date().toISOString(),
    };
    project.render(<BoardPage />);
    await screen.findByText(project.backend.findTask('AC-24')!.title);
    expect(screen.queryByText(t('task.level.mark'))).toBeNull();
  });

  it('drops the mark while the card waits for the Senior: the status line says it', async () => {
    const project = seniorProject();
    project.backend.updateTask('AC-24', {
      stageId: 'dev',
      startWaiting: { reason: 'senior_busy', seniors: ['be-1'], since: new Date().toISOString() },
    });
    project.render(<BoardPage />);
    await screen.findByText(t('taskStatus.startWaiting.senior_busy'));
    expect(screen.queryByText(t('task.level.mark'))).toBeNull();
  });
});

describe('"Ki vigye?" of a Senior card (PM-349)', () => {
  it('offers the Senior as the automatic choice, says why, and marks the Senior in the list', async () => {
    const project = seniorProject();
    project.render(drawer, '/p/AC/tasks/AC-24');
    const select = (await screen.findByLabelText(t('task.assigneeLabel'))) as HTMLSelectElement;
    expect(within(select).getByRole('option', { name: t('task.assigneeAutoSenior') })).toBeTruthy();
    expect(select.textContent).toContain(`Backend fejlesztő · be-1 · ${t('task.level.mark')}`);
    expect(screen.getByText(t('task.assigneeHintSenior', { reason: REASON }))).toBeTruthy();
  });

  it('offers the least loaded developer for a card that is no Senior task', async () => {
    const project = seniorProject({ seniorCard: false });
    project.render(drawer, '/p/AC/tasks/AC-24');
    const select = (await screen.findByLabelText(t('task.assigneeLabel'))) as HTMLSelectElement;
    expect(within(select).getByRole('option', { name: t('task.assigneeAuto') })).toBeTruthy();
    expect(screen.queryByText(/Senior-feladat/)).toBeNull();
  });

  it('says there is no Senior when the team has none, and offers the automatic choice', async () => {
    const project = seniorProject();
    project.backend.handle('PATCH', '/api/projects/AC/members/be-1', { senior: false });
    project.render(drawer, '/p/AC/tasks/AC-24');
    const select = (await screen.findByLabelText(t('task.assigneeLabel'))) as HTMLSelectElement;
    expect(within(select).getByRole('option', { name: t('task.assigneeAuto') })).toBeTruthy();
    expect(screen.getByText(t('task.assigneeHintNoSenior'))).toBeTruthy();
  });

  it('asks before a developer who is no Senior gets the card, with "Mégse" focused, and starts nothing on cancel', async () => {
    const project = seniorProject();
    project.render(drawer, '/p/AC/tasks/AC-24');
    const select = (await screen.findByLabelText(t('task.assigneeLabel'))) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'dev-1' } });
    fireEvent.click(screen.getByRole('button', { name: t('task.start') }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(t('seniorWarning.title'))).toBeTruthy();
    expect(dialog.textContent).toContain(
      t('seniorWarning.description', { reason: REASON, name: 'Általános fejlesztő' }),
    );
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: t('common.cancel') }));
    expect(startRequests(project)).toEqual([]);

    fireEvent.click(within(dialog).getByRole('button', { name: t('common.cancel') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(startRequests(project)).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: t('task.start') }));
    fireEvent.click(await screen.findByRole('button', { name: t('seniorWarning.confirm') }));
    await waitFor(() => expect(project.backend.findTask('AC-24')!.assignee).toBe('dev-1'));
    expect(startRequests(project).map((request) => request.body)).toEqual([{ assignee: 'dev-1' }]);
  });

  it('asks nothing when the Senior is chosen, and the Senior card of a team without a Senior', async () => {
    const project = seniorProject();
    project.render(drawer, '/p/AC/tasks/AC-24');
    const select = (await screen.findByLabelText(t('task.assigneeLabel'))) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'be-1' } });
    fireEvent.click(screen.getByRole('button', { name: t('task.start') }));
    await waitFor(() => expect(project.backend.findTask('AC-24')!.assignee).toBe('be-1'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks about the Senior card before the open prerequisite', async () => {
    const project = seniorProject({ seniorCard: false });
    project.backend.findTask('AC-23')!.developerLevel = {
      level: 'senior',
      reason: REASON,
      setBy: 'owner',
      setAt: new Date().toISOString(),
    };
    project.render(drawer, '/p/AC/tasks/AC-23');
    const select = (await screen.findByLabelText(t('task.assigneeLabel'))) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'dev-1' } });
    fireEvent.click(screen.getByRole('button', { name: t('task.start') }));
    const first = await screen.findByRole('dialog');
    expect(within(first).getByText(t('seniorWarning.title'))).toBeTruthy();
    fireEvent.click(within(first).getByRole('button', { name: t('seniorWarning.confirm') }));
    const second = await screen.findByRole('dialog');
    await waitFor(() => expect(within(second).getByText(t('prerequisiteWarning.title'))).toBeTruthy());
  });

  it('waits for the Senior when it is busy: no assignee, a toast, and the hint of the waiting card', async () => {
    const project = seniorProject();
    project.render(drawer, '/p/AC/tasks/AC-24');
    fireEvent.click(await screen.findByRole('button', { name: t('task.start') }));
    expect(await screen.findByText(t('task.startedSeniorWait', { key: 'AC-24' }))).toBeTruthy();
    const task = project.backend.findTask('AC-24')!;
    expect(task.assignee).toBeNull();
    expect(task.stageId).toBe('dev');
    expect(task.startWaiting).toMatchObject({ reason: 'senior_busy', seniors: ['be-1'] });
    expect(await screen.findByText(t('taskStatus.startHints.senior_busy'))).toBeTruthy();
  });

  it('gives the card to a free Senior at once', async () => {
    const project = seniorProject();
    project.backend.sessions = project.backend.sessions.filter((session) => session.member !== 'be-1');
    project.render(drawer, '/p/AC/tasks/AC-24');
    fireEvent.click(await screen.findByRole('button', { name: t('task.start') }));
    await waitFor(() => expect(project.backend.findTask('AC-24')!.assignee).toBe('be-1'));
    expect(screen.queryByText(t('task.startedSeniorWait', { key: 'AC-24' }))).toBeNull();
  });
});

describe('the hint of a card that waits for the Senior (PM-349)', () => {
  const waiting = (decidedBy?: string) => {
    const project = seniorProject();
    project.backend.updateTask('AC-24', {
      stageId: 'dev',
      startWaiting: {
        reason: 'senior_busy',
        seniors: ['be-1'],
        since: new Date().toISOString(),
        ...(decidedBy ? { waitDecidedBy: decidedBy } : {}),
      },
    });
    return project;
  };

  it('has the base hint when nobody decided', async () => {
    waiting().render(drawer, '/p/AC/tasks/AC-24');
    expect(await screen.findByText(t('taskStatus.startHints.senior_busy'))).toBeTruthy();
  });

  it("names the person who decided, and says 'you' when it is the viewer", async () => {
    waiting('kata').render(drawer, '/p/AC/tasks/AC-24');
    expect(await screen.findByText(/döntése: a kártya megvárja a Seniort/)).toBeTruthy();
  });

  it("says 'Úgy döntöttél' when the viewer decided", async () => {
    waiting('owner').render(drawer, '/p/AC/tasks/AC-24');
    expect(await screen.findByText(t('taskStatus.startHints.senior_busy_decided_me'))).toBeTruthy();
  });
});

describe('the "Ajánlott" row (PM-349)', () => {
  const row = async () => screen.findByText(t('task.level.label'));
  const patches = (project: ReturnType<typeof mockProject>) =>
    project.requests.filter((request) => request.method === 'PATCH' && request.path.endsWith('/tasks/AC-24'));

  it('shows "Bármelyik fejlesztő" for a card without a recommendation, and the Senior with the reason', async () => {
    const project = seniorProject({ seniorCard: false });
    project.render(drawer, '/p/AC/tasks/AC-24');
    await row();
    expect(screen.getByText(t('task.level.any'))).toBeTruthy();
  });

  it('shows the Senior chip and the reason of a Senior card', async () => {
    const project = seniorProject();
    project.render(drawer, '/p/AC/tasks/AC-24');
    await row();
    expect(screen.getByText(t('task.level.senior'))).toBeTruthy();
    expect(screen.getAllByText(REASON).length).toBeGreaterThan(0);
  });

  it('says a Senior card of a team without a Senior goes to any developer', async () => {
    const project = seniorProject();
    project.backend.handle('PATCH', '/api/projects/AC/members/be-1', { senior: false });
    project.render(drawer, '/p/AC/tasks/AC-24');
    await row();
    expect(await screen.findByText(t('task.level.noSenior'))).toBeTruthy();
  });

  it('takes the reading view away while the editor is open, and brings it back on Cancel', async () => {
    const project = seniorProject();
    project.backend.handle('PATCH', '/api/projects/AC/members/be-1', { senior: false });
    project.render(drawer, '/p/AC/tasks/AC-24');
    await row();
    await screen.findByText(t('task.level.noSenior'));
    expect(screen.getAllByText(REASON).length).toBeGreaterThan(0);
    fireEvent.click(await screen.findByRole('button', { name: t('task.level.edit') }));

    const field = screen.getByLabelText(t('task.level.reasonSenior')) as HTMLTextAreaElement;
    expect(field.value).toBe(REASON);
    // The reason is in the field only, and the team-without-a-Senior line is the form's own note.
    expect(screen.queryAllByText(REASON).filter((node) => node.tagName !== 'TEXTAREA')).toEqual([]);
    expect(screen.queryByText(t('task.level.noSenior'))).toBeNull();
    expect(screen.getByText(t('task.level.noSeniorEditor'), { exact: false })).toBeTruthy();

    fireEvent.click(within(field.closest('form')!).getByRole('button', { name: t('common.cancel') }));
    await waitFor(() => expect(screen.queryByLabelText(t('task.level.reasonSenior'))).toBeNull());
    expect(screen.getAllByText(REASON).length).toBeGreaterThan(0);
    expect(screen.getByText(t('task.level.noSenior'))).toBeTruthy();
  });

  it('saves a Senior recommendation with its reason, tells it, and returns focus to the pencil', async () => {
    const project = seniorProject({ seniorCard: false });
    project.render(drawer, '/p/AC/tasks/AC-24');
    await row();
    fireEvent.click(await screen.findByRole('button', { name: t('task.level.edit') }));
    fireEvent.click(screen.getByRole('button', { name: t('task.level.senior') }));
    fireEvent.change(screen.getByLabelText(t('task.level.reasonSenior')), {
      target: { value: ` ${REASON} ` },
    });
    fireEvent.click(screen.getByRole('button', { name: t('task.level.save') }));

    await waitFor(() =>
      expect(project.backend.findTask('AC-24')!.developerLevel).toMatchObject({
        level: 'senior',
        reason: REASON,
      }),
    );
    expect(patches(project).map((request) => request.body)).toEqual([
      { developerLevel: { level: 'senior', reason: REASON } },
    ]);
    expect(await screen.findByText(t('task.level.saved', { level: t('timeline.levelSenior') }))).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: t('task.level.edit') })),
    );
    expect(
      project.backend.timeline.filter(
        (event) => event.taskKey === 'AC-24' && event.type === 'task_level_changed',
      ),
    ).toHaveLength(1);
  });

  it('wants a reason for a Senior card: the field says so, and nothing is sent', async () => {
    const project = seniorProject({ seniorCard: false });
    project.render(drawer, '/p/AC/tasks/AC-24');
    await row();
    fireEvent.click(await screen.findByRole('button', { name: t('task.level.edit') }));
    fireEvent.click(screen.getByRole('button', { name: t('task.level.senior') }));
    fireEvent.click(screen.getByRole('button', { name: t('task.level.save') }));
    expect(await screen.findByText(t('task.level.reasonRequired'))).toBeTruthy();
    expect(patches(project)).toEqual([]);
  });

  it('closes the editor on Escape without saving, and keeps the drawer open', async () => {
    const project = seniorProject({ seniorCard: false });
    project.render(drawer, '/p/AC/tasks/AC-24');
    await row();
    fireEvent.click(await screen.findByRole('button', { name: t('task.level.edit') }));
    const field = screen.getByLabelText(t('task.level.reasonAny'));
    fireEvent.keyDown(field, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByLabelText(t('task.level.reasonAny'))).toBeNull());
    expect(patches(project)).toEqual([]);
    expect(screen.getByText(t('task.level.label'))).toBeTruthy();
  });

  it('has no pencil for someone who may not set the recommendation, nor for a closed card', async () => {
    const project = seniorProject({ seniorCard: false });
    project.backend.config.team.members.find((member) => member.handle === 'owner')!.kind;
    const closed = project.backend.findTask('AC-24')!;
    closed.status = 'cancelled';
    project.render(drawer, '/p/AC/tasks/AC-24');
    await screen.findByRole('heading', { name: closed.title });
    expect(screen.queryByRole('button', { name: t('task.level.edit') })).toBeNull();
  });

  it('shows the refusal of the server in an alert and keeps the editor open', async () => {
    const project = seniorProject({ seniorCard: false });
    const fetch = createMockFetch(project.backend, project.requests);
    setFetchImplementation(async (path, init) => {
      if (init?.method === 'PATCH')
        return new Response(
          JSON.stringify({ error: { code: 'developer_level_forbidden', message: 'Forbidden' } }),
          { status: 403 },
        );
      return fetch(path, init);
    });
    project.render(drawer, '/p/AC/tasks/AC-24');
    await row();
    fireEvent.click(await screen.findByRole('button', { name: t('task.level.edit') }));
    fireEvent.click(screen.getByRole('button', { name: t('task.level.any') }));
    fireEvent.click(screen.getByRole('button', { name: t('task.level.save') }));
    expect((await screen.findByRole('alert')).textContent).toBe(t('errors.codes.developer_level_forbidden'));
    expect(screen.getByLabelText(t('task.level.reasonAny'))).toBeTruthy();
  });
});
