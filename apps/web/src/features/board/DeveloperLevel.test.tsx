import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { ToastProvider } from '../../components/Toast';
import { t } from '../../i18n/t';
import { MockBackend } from '../../mocks/backend';
import { mockProject } from '../../test/mockProject';
import { onTaskUpdate } from '../../test/msw/tasks';
import { apiFailure } from '../../test/msw/contract';
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
const REASON = 'Migration across modules';
function complexityProject(scored = true) {
  const backend = new MockBackend();
  backend.handle('PATCH', '/api/projects/AC/members/be-1', { complexityLimit: 13 });
  if (scored)
    backend.findTask('AC-24')!.complexity = {
      points: 8,
      reason: REASON,
      setBy: 'owner',
      setAt: new Date().toISOString(),
    };
  return mockProject(backend);
}
const openEditor = async () =>
  fireEvent.click(await screen.findByRole('button', { name: t('task.complexity.edit') }));
const startRequests = (project: ReturnType<typeof mockProject>) =>
  project.requests.filter((r) => r.path.endsWith('/start'));

describe('complexity on the board and drawer', () => {
  it('marks a scored card in the header, including while waiting', async () => {
    const project = complexityProject();
    project.backend.updateTask('AC-24', {
      startWaiting: { reason: 'senior_busy', seniors: ['be-1'], since: new Date().toISOString() },
    });
    project.render(<BoardPage />);
    expect(await screen.findByTitle(t('task.complexity.mark', { points: 8 }))).toBeTruthy();
  });
  it('does not mark an unscored card', async () => {
    const project = complexityProject(false);
    project.render(<BoardPage />);
    await screen.findByText(project.backend.findTask('AC-24')!.title);
    expect(screen.queryByTitle(t('task.complexity.mark', { points: 8 }))).toBeNull();
  });
  it('reads points and reason', async () => {
    const project = complexityProject();
    project.render(drawer, '/p/AC/tasks/AC-24');
    expect(await screen.findByText(t('task.complexity.points', { points: 8 }))).toBeTruthy();
    expect(screen.getByText(REASON)).toBeTruthy();
  });
  it('offers an empty value to editors on first use', async () => {
    complexityProject(false).render(drawer, '/p/AC/tasks/AC-24');
    expect(await screen.findByText(t('task.complexity.empty'))).toBeTruthy();
  });
  it('saves optional reasons and restores focus', async () => {
    const project = complexityProject(false);
    project.render(drawer, '/p/AC/tasks/AC-24');
    await openEditor();
    fireEvent.click(screen.getByRole('radio', { name: t('task.complexity.points', { points: 13 }) }));
    const field = screen.getByLabelText(t('task.complexity.reason')) as HTMLTextAreaElement;
    expect(field.maxLength).toBe(300);
    fireEvent.click(screen.getByRole('button', { name: t('task.complexity.save') }));
    await waitFor(() =>
      expect(project.backend.findTask('AC-24')!.complexity).toMatchObject({ points: 13, reason: null }),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: t('task.complexity.edit') })),
    );
  });
  it('removes the points with an explicit null points request', async () => {
    const project = complexityProject();
    project.render(drawer, '/p/AC/tasks/AC-24');
    await openEditor();
    fireEvent.click(screen.getByRole('radio', { name: t('task.complexity.empty') }));
    fireEvent.click(screen.getByRole('button', { name: t('task.complexity.save') }));
    await waitFor(() => expect(project.backend.findTask('AC-24')!.complexity).toBeUndefined());
    expect(
      project.requests.some((r) => r.method === 'PATCH' && JSON.stringify(r.body).includes('"points":null')),
    ).toBe(true);
  });
  it('closes only the editor on Escape and restores its pencil', async () => {
    complexityProject().render(drawer, '/p/AC/tasks/AC-24');
    await openEditor();
    fireEvent.keyDown(screen.getByLabelText(t('task.complexity.reason')), { key: 'Escape' });
    expect(screen.queryByLabelText(t('task.complexity.reason'))).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: t('task.complexity.edit') })),
    );
  });
  it('retains the editor and reason after a refused save', async () => {
    onTaskUpdate('AC-24', apiFailure(403, 'complexity_forbidden'));
    complexityProject().render(drawer, '/p/AC/tasks/AC-24');
    await openEditor();
    fireEvent.click(screen.getByRole('button', { name: t('task.complexity.save') }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect((screen.getByLabelText(t('task.complexity.reason')) as HTMLTextAreaElement).value).toBe(REASON);
  });
  it('hides the pencil on closed cards', async () => {
    const project = complexityProject();
    project.backend.findTask('AC-24')!.status = 'cancelled';
    project.render(drawer, '/p/AC/tasks/AC-24');
    await screen.findByText(t('task.complexity.label'));
    expect(screen.queryByRole('button', { name: t('task.complexity.edit') })).toBeNull();
  });
  it('shows a read-only value to developers', async () => {
    const project = complexityProject();
    project.render(drawer, '/p/AC/tasks/AC-24', { myHandle: 'dev-1' });
    await screen.findByText(t('task.complexity.points', { points: 8 }));
    expect(screen.queryByRole('button', { name: t('task.complexity.edit') })).toBeNull();
  });
  it('omits the row for an unscored reader', async () => {
    const project = complexityProject(false);
    project.render(drawer, '/p/AC/tasks/AC-24', { myHandle: 'dev-1' });
    await screen.findByRole('heading', { name: project.backend.findTask('AC-24')!.title });
    expect(screen.queryByText(t('task.complexity.label'))).toBeNull();
  });
  it('has no pencil without access to configuration', async () => {
    complexityProject().render(drawer, '/p/AC/tasks/AC-24', { can: { readConfig: false } });
    await screen.findByText(t('task.complexity.points', { points: 8 }));
    expect(screen.queryByRole('button', { name: t('task.complexity.edit') })).toBeNull();
  });
  it('selects points with arrow keys in the radio group', async () => {
    complexityProject(false).render(drawer, '/p/AC/tasks/AC-24');
    await openEditor();
    const empty = screen.getByRole('radio', { name: t('task.complexity.empty') });
    empty.focus();
    fireEvent.keyDown(empty, { key: 'ArrowLeft' });
    const maximum = screen.getByRole('radio', { name: t('task.complexity.points', { points: 13 }) });
    expect(maximum.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(maximum);
  });
  it('trims and persists the optional reason in the new event', async () => {
    const project = complexityProject();
    project.render(drawer, '/p/AC/tasks/AC-24');
    await openEditor();
    fireEvent.change(screen.getByLabelText(t('task.complexity.reason')), {
      target: { value: '  More modules  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('task.complexity.save') }));
    await waitFor(() => expect(project.backend.findTask('AC-24')!.complexity?.reason).toBe('More modules'));
    expect(
      project.backend.timeline.some(
        (event) => event.type === 'task_complexity_changed' && event.data.reason === 'More modules',
      ),
    ).toBe(true);
  });
  it('warns when nobody reaches the points, including a newly selected value', async () => {
    const project = complexityProject();
    project.backend.handle('PATCH', '/api/projects/AC/members/be-1', { complexityLimit: 5 });
    project.render(drawer, '/p/AC/tasks/AC-24');
    expect(await screen.findByText(t('task.complexity.noneReach', { points: 8 }))).toBeTruthy();
    await openEditor();
    fireEvent.click(screen.getByRole('radio', { name: t('task.complexity.points', { points: 13 }) }));
    expect(
      screen.getByText(t('task.complexity.noneReachEditor', { points: 13 }), { exact: false }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: t('task.complexity.teamLink') }).getAttribute('href')).toBe(
      '/p/AC/team',
    );
  });
});

describe('starting and assigning scored cards', () => {
  it('falls back to a human stage owner when every AI developer is busy', () => {
    const project = complexityProject(false);
    const stage = project.backend.config.pipeline.stages.find((stage) => stage.kind === 'work')!;
    stage.owners = ['fe-1', 'be-1', 'dev-1', 'owner'];
    const result = project.backend.handle('POST', '/api/projects/AC/tasks/AC-24/start', {});
    expect(result.status).toBe(200);
    expect(project.backend.findTask('AC-24')!.assignee).toBe('owner');
  });
  it('does not assign a busy developer when the shared choice finds nobody free', () => {
    const project = complexityProject(false);
    const result = project.backend.handle('POST', '/api/projects/AC/tasks/AC-24/start', {});
    expect(result.status).toBe(409);
    expect(project.backend.findTask('AC-24')!.assignee).toBeNull();
  });
  it('shows limits and the automatic threshold', async () => {
    complexityProject().render(drawer, '/p/AC/tasks/AC-24');
    const select = await screen.findByLabelText(t('task.assigneeLabel'));
    expect(
      within(select).getByRole('option', { name: t('task.complexity.auto', { points: 8 }) }),
    ).toBeTruthy();
    expect(select.textContent).toContain(t('team.limit', { limit: 13 }));
  });
  it('cancels a start above the chosen developer limit', async () => {
    const project = complexityProject();
    project.render(drawer, '/p/AC/tasks/AC-24');
    fireEvent.change(await screen.findByLabelText(t('task.assigneeLabel')), { target: { value: 'dev-1' } });
    fireEvent.click(screen.getByRole('button', { name: t('task.start') }));
    const modal = await screen.findByRole('dialog');
    expect(document.activeElement).toBe(within(modal).getByRole('button', { name: t('common.cancel') }));
    fireEvent.click(within(modal).getByRole('button', { name: t('common.cancel') }));
    expect(startRequests(project)).toEqual([]);
  });
  it('allows a confirmed manual start above the limit', async () => {
    const project = complexityProject();
    project.render(drawer, '/p/AC/tasks/AC-24');
    fireEvent.change(await screen.findByLabelText(t('task.assigneeLabel')), { target: { value: 'dev-1' } });
    fireEvent.click(screen.getByRole('button', { name: t('task.start') }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: t('complexityWarning.confirm') }),
    );
    await waitFor(() => expect(project.backend.findTask('AC-24')!.assignee).toBe('dev-1'));
  });
  it('waits when all suitable developers are busy', async () => {
    const project = complexityProject();
    project.render(drawer, '/p/AC/tasks/AC-24');
    fireEvent.click(await screen.findByRole('button', { name: t('task.start') }));
    expect(await screen.findByText(t('task.startedSeniorWait', { key: 'AC-24' }))).toBeTruthy();
    expect(project.backend.findTask('AC-24')!.startWaiting?.reason).toBe('senior_busy');
  });
  it('starts a free developer whose limit reaches the points', async () => {
    const project = complexityProject();
    project.backend.sessions = project.backend.sessions.filter((s) => s.member !== 'be-1');
    project.render(drawer, '/p/AC/tasks/AC-24');
    fireEvent.click(await screen.findByRole('button', { name: t('task.start') }));
    await waitFor(() => expect(project.backend.findTask('AC-24')!.assignee).toBe('be-1'));
  });
  it('shows an immediate assignment warning without confirmation', async () => {
    const project = complexityProject();
    project.backend.findTask('AC-24')!.assignee = 'dev-1';
    project.render(drawer, '/p/AC/tasks/AC-24');
    const warning = await screen.findByText(
      t('task.complexity.assigneeWarning', { points: 8, limit: 5, name: 'Általános fejlesztő' }),
    );
    expect(warning.getAttribute('role')).toBe('status');
  });
});
