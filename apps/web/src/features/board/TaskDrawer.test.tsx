import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { mockProject } from '../../test/mockProject';
import { t } from '../../i18n/t';
import { TaskDrawer } from './TaskDrawer';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

const drawer = (
  <Routes>
    <Route path="/p/:key/tasks/:taskKey" element={<TaskDrawer />} />
  </Routes>
);

describe('task drawer lifecycle', () => {
  it('confirms cancellation with a reason, stops live sessions, and reopens unassigned', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-20');
    fireEvent.click(await screen.findByRole('button', { name: 'Feladat megszakítása' }));
    expect(project.backend.findTask('AC-20')?.status).toBe('active');
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Indok/), { target: { value: 'Acme scope changed.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Feladat megszakítása' }));
    await screen.findByRole('button', { name: 'Újranyitás' });
    expect(project.backend.findTask('AC-20')).toMatchObject({ status: 'cancelled', assignee: 'be-1' });
    expect(project.backend.findSession('ses_ac20_be1')?.state).toBe('exited');
    expect(screen.getByText('Megszakította a feladatot: Acme scope changed.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Újranyitás' }));
    await screen.findByRole('button', { name: 'Feladat megszakítása' });
    expect(project.backend.findTask('AC-20')).toMatchObject({
      status: 'active',
      assignee: null,
      closedAt: null,
      stageId: 'dev',
    });
    expect(screen.getByText('Újranyitotta a feladatot.')).toBeTruthy();
  });
  it('offers stopping a live session, then allows changing and clearing the assignee', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-20');
    await screen.findByRole('button', { name: 'Felelős mentése' });
    fireEvent.change(screen.getByLabelText('Felelős'), { target: { value: 'kata' } });
    fireEvent.click(screen.getByRole('button', { name: 'Felelős mentése' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Session leállítása' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Session leállítása' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Felelős mentése' }));
    await waitFor(() => expect(project.backend.findTask('AC-20')?.assignee).toBe('kata'));
    await screen.findByText(/Előző felelős: Backend fejlesztő/);
    fireEvent.change(screen.getByLabelText('Felelős'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Felelős mentése' }));
    await waitFor(() => expect(project.backend.findTask('AC-20')?.assignee).toBeNull());
  });
  it('hides lifecycle controls from non-admin members', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-20', {
      can: { createTasks: true, manageTeam: false, workInSessions: false },
    });
    await screen.findByText('Napi mentés és visszaállítási próba');
    expect(screen.queryByRole('button', { name: 'Feladat megszakítása' })).toBeNull();
    expect(screen.queryByLabelText('Felelős')).toBeNull();
  });
});

describe('task drawer stage moves', () => {
  it('defaults to the next stage and moves successfully', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-20');
    const target = await screen.findByLabelText(t('task.move.target'));
    expect((target as HTMLSelectElement).value).toBe('code_review');
    fireEvent.click(screen.getByRole('button', { name: t('task.move.submit') }));
    await waitFor(() => expect(project.backend.findTask('AC-20')?.stageId).toBe('code_review'));
    await waitFor(() =>
      expect((screen.getByLabelText(t('task.move.target')) as HTMLSelectElement).value).toBe('integration'),
    );
    expect(project.requests).toContainEqual({
      method: 'PATCH',
      path: '/api/projects/AC/tasks/AC-20',
      body: { stageId: 'code_review' },
    });
  });
  it('previews gates and lists unmet conditions inline without moving', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-20');
    fireEvent.change(await screen.findByLabelText(t('task.move.target')), {
      target: { value: 'client_test' },
    });
    expect(screen.getByText(/Integration:/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('task.move.submit') }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      t('settings.pipeline.gateCheck', { check: t('checks.names.code_review') }),
    );
    expect(alert.textContent).toContain(t('settings.pipeline.gateCheck', { check: t('checks.names.qa') }));
    expect(project.backend.findTask('AC-20')?.stageId).toBe('dev');
  });
  it('reports requested approval as information and stays in the original stage', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-17');
    await screen.findByLabelText(t('task.move.target'));
    fireEvent.click(screen.getByRole('button', { name: t('task.move.submit') }));
    expect(await screen.findByText(t('errors.codes.approval_requested'))).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(project.backend.findTask('AC-17')?.stageId).toBe('merge');
    expect(
      project.backend.inbox.some(
        (item) => item.taskKey === 'AC-17' && item.kind === 'decision' && item.state === 'open',
      ),
    ).toBe(true);
  });
  it.each(['client', 'viewer'])('hides moving from %s access', async (access) => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-20', {
      myHandle: access === 'client' ? 'kata' : 'bence',
      can: { createTasks: false, manageTeam: false, workInSessions: false },
    });
    await screen.findByText(project.backend.findTask('AC-20')!.title);
    expect(screen.queryByLabelText(t('task.move.target'))).toBeNull();
  });
  it.each(['done', 'cancelled'] as const)('hides moving for %s tasks', async (status) => {
    const project = mockProject();
    project.backend.updateTask('AC-20', { status });
    project.render(drawer, '/p/AC/tasks/AC-20');
    await screen.findByText(project.backend.findTask('AC-20')!.title);
    expect(screen.queryByLabelText(t('task.move.target'))).toBeNull();
  });
});

describe('task drawer checks', () => {
  it('shows gate checks and saves a result with a note, refreshing the state and timeline', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-20');
    const section = await screen.findByRole('region', { name: t('task.checks.title') });
    const qa = within(section).getByRole('region', { name: t('checks.names.qa') });
    expect(within(qa).getByRole('heading').textContent).toBe(
      t('checks.line', { name: t('checks.names.qa'), state: t('checks.states.pending') }),
    );
    expect(within(section).queryByRole('region', { name: t('checks.names.security_review') })).toBeNull();
    fireEvent.change(within(qa).getByLabelText(t('task.checks.state')), { target: { value: 'passed' } });
    fireEvent.change(within(qa).getByLabelText(t('task.checks.note'), { exact: false }), {
      target: { value: 'Acme behavior verified.' },
    });
    fireEvent.click(within(qa).getByRole('button', { name: t('task.checks.save') }));
    await waitFor(() => expect(project.backend.findTask('AC-20')?.checks.qa).toBe('passed'));
    await waitFor(() =>
      expect(within(qa).getByRole('heading').textContent).toContain(t('checks.states.passed')),
    );
    expect(await screen.findByText('Acme behavior verified.')).toBeTruthy();
    expect(project.requests).toContainEqual({
      method: 'POST',
      path: '/api/projects/AC/tasks/AC-20/checks',
      body: { check: 'qa', state: 'passed', note: 'Acme behavior verified.' },
    });
  });

  it.each(['assignee', 'pr_author'] as const)(
    'explains self-review to the %s and keeps client testing available',
    async (kind) => {
      const project = mockProject();
      const task = project.backend.findTask('AC-20')!;
      project.backend.updateTask(
        task.key,
        kind === 'assignee'
          ? { assignee: 'owner' }
          : {
              links: [...task.links, { kind: 'pull_request', ref: '42', repo: 'acme/web', author: 'owner' }],
            },
      );
      project.render(drawer, '/p/AC/tasks/AC-20');
      const section = await screen.findByRole('region', { name: t('task.checks.title') });
      const qa = within(section).getByRole('region', { name: t('checks.names.qa') });
      expect(within(qa).getByText(t('errors.codes.self_review_forbidden'))).toBeTruthy();
      expect(within(qa).queryByRole('button')).toBeNull();
      const client = within(section).getByRole('region', { name: t('checks.names.client_test') });
      fireEvent.change(within(client).getByLabelText(t('task.checks.state')), {
        target: { value: 'passed' },
      });
      fireEvent.click(within(client).getByRole('button', { name: t('task.checks.save') }));
      await waitFor(() => expect(project.backend.findTask(task.key)?.checks.client_test).toBe('passed'));
      expect(project.requests).toContainEqual({
        method: 'POST',
        path: '/api/projects/AC/tasks/AC-20/checks',
        body: { check: 'client_test', state: 'passed' },
      });
    },
  );

  it.each(['viewer', 'done', 'cancelled'])('shows checks read-only for %s', async (reason) => {
    const project = mockProject();
    if (reason === 'done' || reason === 'cancelled') project.backend.updateTask('AC-20', { status: reason });
    project.render(
      drawer,
      '/p/AC/tasks/AC-20',
      reason === 'viewer' ? { can: { createTasks: false, manageTeam: false, workInSessions: false } } : {},
    );
    const section = await screen.findByRole('region', { name: t('task.checks.title') });
    expect(within(section).getAllByRole('heading').length).toBeGreaterThan(1);
    expect(within(section).queryByRole('combobox')).toBeNull();
    expect(within(section).queryByRole('button')).toBeNull();
  });

  it('shows errors from a check request inline', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-20');
    const section = await screen.findByRole('region', { name: t('task.checks.title') });
    const qa = within(section).getByRole('region', { name: t('checks.names.qa') });
    // The task closes after the drawer has loaded, before the human submits.
    project.backend.findTask('AC-20')!.status = 'done';
    fireEvent.click(within(qa).getByRole('button', { name: t('task.checks.save') }));
    expect((await within(qa).findByRole('alert')).textContent).toBe(t('errors.codes.task_closed'));
  });
});
