import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { TaskDrawer } from './TaskDrawer';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

const drawer = (
  <Routes>
    <Route path="/p/:key/tasks/:taskKey" element={<TaskDrawer />} />
  </Routes>
);

/** A project with the given repositories (the fake project has three: webshop, admin and infra). */
function projectWith(repos?: string[]) {
  const project = mockProject();
  if (repos)
    project.backend.config.project.repos = repos.map((name) => ({ name, path: name, defaultBranch: 'main' }));
  return project;
}

/** The repository select of the drawer, once the configuration has come in. */
const repoSelect = async () => (await screen.findByLabelText(t('task.repoLabel'))) as HTMLSelectElement;

describe('the repository of a task in the drawer', () => {
  describe('in a project with one repository', () => {
    it('shows the only repository for a task that names none, and no select', async () => {
      const project = projectWith(['shop']);
      project.backend.updateTask('AC-20', { repo: null });
      project.render(drawer, '/p/AC/tasks/AC-20');

      expect(await screen.findByText(t('task.repo', { repo: 'shop' }))).toBeTruthy();
      expect(screen.queryByLabelText(t('task.repoLabel'))).toBeNull();
      expect(screen.queryByText(t('task.workspaceRoot'), { exact: false })).toBeNull();
      expect(screen.queryByText(t('task.repoNone'))).toBeNull();
    });

    it('shows the repository of the task itself', async () => {
      const project = projectWith(['shop', 'other']);
      project.backend.updateTask('AC-20', { repo: 'other' });
      project.backend.config.project.repos = [project.backend.config.project.repos[1]!];
      project.render(drawer, '/p/AC/tasks/AC-20');

      expect(await screen.findByText(t('task.repo', { repo: 'other' }))).toBeTruthy();
    });
  });

  describe('in a project without repositories', () => {
    it('names the workspace root, which is where the work happens', async () => {
      const project = projectWith([]);
      project.backend.updateTask('AC-20', { repo: null });
      project.render(drawer, '/p/AC/tasks/AC-20');

      expect(await screen.findByText(t('task.repo', { repo: t('task.workspaceRoot') }))).toBeTruthy();
      expect(screen.queryByLabelText(t('task.repoLabel'))).toBeNull();
    });
  });

  describe('in a project with several repositories', () => {
    it('offers a select with every repository, and says that none is chosen', async () => {
      const project = projectWith();
      project.backend.updateTask('AC-20', { repo: null });
      project.render(drawer, '/p/AC/tasks/AC-20');

      const select = await repoSelect();
      expect(select.value).toBe('');
      expect([...select.options].map((option) => [option.value, option.textContent])).toEqual([
        ['', t('task.repoNone')],
        ['webshop', 'webshop'],
        ['admin', 'admin'],
        ['infra', 'infra'],
      ]);
      // It is a select that saves on change: there is no button to save it with.
      expect(select.closest('label')?.querySelector('button')).toBeNull();
      expect(screen.queryByRole('button', { name: t('task.save') })).toBeNull();
    });

    it('shows the repository of the task in the select', async () => {
      const project = projectWith();
      project.render(drawer, '/p/AC/tasks/AC-20');

      expect((await repoSelect()).value).toBe(project.backend.findTask('AC-20')!.repo);
    });

    it('saves the pick on change, shows it on the timeline and keeps it', async () => {
      const project = projectWith();
      project.backend.updateTask('AC-20', { repo: null });
      project.backend.sessions.length = 0;
      project.render(drawer, '/p/AC/tasks/AC-20');

      const select = await repoSelect();
      fireEvent.change(select, { target: { value: 'admin' } });

      await waitFor(() => expect(project.backend.findTask('AC-20')!.repo).toBe('admin'));
      expect(project.requests).toContainEqual({
        method: 'PATCH',
        path: '/api/projects/AC/tasks/AC-20',
        body: { repo: 'admin' },
      });
      await waitFor(() =>
        expect((screen.getByLabelText(t('task.repoLabel')) as HTMLSelectElement).value).toBe('admin'),
      );
      await screen.findByText(
        t('timeline.events.task_updated', {
          fields: t('timeline.repoChange', { previous: t('timeline.noRepo'), repo: 'admin' }),
        }),
      );
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('clears the repository when the empty choice is picked', async () => {
      const project = projectWith();
      project.backend.sessions.length = 0;
      project.render(drawer, '/p/AC/tasks/AC-20');

      fireEvent.change(await repoSelect(), { target: { value: '' } });

      await waitFor(() => expect(project.backend.findTask('AC-20')!.repo).toBeNull());
      expect(project.requests).toContainEqual({
        method: 'PATCH',
        path: '/api/projects/AC/tasks/AC-20',
        body: { repo: null },
      });
      await screen.findByText(
        t('timeline.events.task_updated', {
          fields: t('timeline.repoChange', { previous: 'infra', repo: t('timeline.noRepo') }),
        }),
      );
    });

    it('refuses the change while a session of the task is running, and shows the old repository again', async () => {
      const project = projectWith();
      // AC-20 has a live session.
      project.render(drawer, '/p/AC/tasks/AC-20');

      fireEvent.change(await repoSelect(), { target: { value: 'admin' } });

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toBe(t('errors.codes.task_session_live'));
      expect(project.backend.findTask('AC-20')!.repo).toBe('infra');
      await waitFor(() =>
        expect((screen.getByLabelText(t('task.repoLabel')) as HTMLSelectElement).value).toBe('infra'),
      );
    });

    it('keeps a repository the configuration no longer has visible', async () => {
      const project = projectWith();
      project.backend.updateTask('AC-20', { repo: 'gone' });
      project.render(drawer, '/p/AC/tasks/AC-20');

      const select = await repoSelect();
      expect(select.value).toBe('gone');
      expect([...select.options].map((option) => option.value)).toEqual([
        '',
        'gone',
        'webshop',
        'admin',
        'infra',
      ]);
    });

    it('does not let people without edit rights or closed tasks change it', async () => {
      const readOnly = projectWith();
      readOnly.backend.updateTask('AC-20', { repo: 'admin' });
      const { unmount } = readOnly.render(drawer, '/p/AC/tasks/AC-20', {
        can: { createTasks: false, manageTeam: false, workInSessions: false },
      });
      // Without access to the configuration only the task's own repository is known.
      expect(await screen.findByText(t('task.repo', { repo: 'admin' }))).toBeTruthy();
      expect(screen.queryByLabelText(t('task.repoLabel'))).toBeNull();
      unmount();

      const closed = projectWith();
      closed.backend.updateTask('AC-20', { status: 'done' });
      closed.render(drawer, '/p/AC/tasks/AC-20');
      await screen.findByText(t('task.repo', { repo: 'infra' }));
      expect(screen.queryByLabelText(t('task.repoLabel'))).toBeNull();
    });

    it('says nothing for a viewer when the task names none: the repositories are not known to them', async () => {
      const project = projectWith();
      project.backend.updateTask('AC-20', { repo: null });
      project.render(drawer, '/p/AC/tasks/AC-20', {
        can: { createTasks: false, manageTeam: false, workInSessions: false },
      });
      await screen.findByText(project.backend.findTask('AC-20')!.title);
      expect(screen.queryByText(t('task.repoNone'))).toBeNull();
      expect(screen.queryByText(t('task.workspaceRoot'), { exact: false })).toBeNull();
    });

    it('shows a plain text where the select is not offered but none is chosen', async () => {
      const project = projectWith();
      project.backend.updateTask('AC-20', { repo: null, status: 'cancelled' });
      project.render(drawer, '/p/AC/tasks/AC-20');

      expect(await screen.findByText(t('task.repoNone'))).toBeTruthy();
      expect(screen.queryByLabelText(t('task.repoLabel'))).toBeNull();
    });
  });

  describe('starting a task that names none', () => {
    it('refuses in a project with several repositories, and starts once one is picked', async () => {
      const project = projectWith();
      project.backend.updateTask('AC-24', { repo: null });
      project.render(drawer, '/p/AC/tasks/AC-24');

      fireEvent.click(await screen.findByRole('button', { name: t('task.start') }));

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain(t('errors.codes.repo_required'));
      // Nothing changed: the task is not assigned and did not move.
      expect(project.backend.findTask('AC-24')).toMatchObject({ assignee: null, stageId: 'ready' });

      fireEvent.change(await repoSelect(), { target: { value: 'webshop' } });
      await waitFor(() => expect(project.backend.findTask('AC-24')!.repo).toBe('webshop'));
      fireEvent.click(screen.getByRole('button', { name: t('task.start') }));
      await waitFor(() => expect(project.backend.findTask('AC-24')!.assignee).not.toBeNull());
    });

    it('starts in a project with one repository, which the task works in', async () => {
      const project = projectWith(['shop']);
      project.backend.updateTask('AC-24', { repo: null });
      project.render(drawer, '/p/AC/tasks/AC-24');

      fireEvent.click(await screen.findByRole('button', { name: t('task.start') }));

      await waitFor(() => expect(project.backend.findTask('AC-24')!.assignee).not.toBeNull());
      expect(within(document.body).queryByText(t('errors.codes.repo_required'))).toBeNull();
    });
  });
});
