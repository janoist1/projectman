import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { useState } from 'react';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { createMockFetch, mockProject } from '../../test/mockProject';
import { TaskDrawer } from './TaskDrawer';
import { TaskPrioritySelect } from './TaskPriority';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));
const drawer = (
  <Routes>
    <Route path="/p/:key/tasks/:taskKey" element={<TaskDrawer />} />
  </Routes>
);
const select = async () => (await screen.findByLabelText(t('priority.label'))) as HTMLSelectElement;

describe('card priority properties', () => {
  it('saves and clears in a live task drawer, recording the changes without changing rank', async () => {
    const project = mockProject();
    const rank = project.backend.findTask('AC-20')!.boardRank;
    project.render(drawer, '/p/AC/tasks/AC-20');
    fireEvent.change(await select(), { target: { value: 'high' } });
    await waitFor(() => expect(project.backend.findTask('AC-20')!.priority).toBe('high'));
    expect(project.requests).toContainEqual({
      method: 'PATCH',
      path: '/api/projects/AC/tasks/AC-20',
      body: { priority: 'high' },
    });
    await screen.findByText(
      t('timeline.events.task_updated', {
        fields: t('timeline.priorityChange', {
          previous: t('timeline.noPriority'),
          priority: t('priority.levels.high'),
        }),
      }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText(t('priority.label')).hasAttribute('disabled')).toBe(false),
    );
    fireEvent.change(await select(), { target: { value: '' } });
    await waitFor(() => expect(project.backend.findTask('AC-20')!.priority).toBeNull());
    expect(project.requests).toContainEqual({
      method: 'PATCH',
      path: '/api/projects/AC/tasks/AC-20',
      body: { priority: null },
    });
    expect(project.backend.findTask('AC-20')!.boardRank).toBe(rank);
  });

  it('shows the pending choice, then restores the saved value and focus on failure', async () => {
    const project = mockProject();
    project.backend.updateTask('AC-20', { priority: 'normal' });
    const fetch = createMockFetch(project.backend, project.requests);
    let fail: (() => void) | undefined;
    setFetchImplementation(async (path, init) => {
      if (init?.method === 'PATCH') {
        await new Promise<void>((resolve) => {
          fail = resolve;
        });
        return new Response(JSON.stringify({ error: { code: 'unexpected_failure', message: 'Failed' } }), {
          status: 500,
        });
      }
      return fetch(path, init);
    });
    project.render(drawer, '/p/AC/tasks/AC-20');
    const control = await select();
    control.focus();
    fireEvent.change(control, { target: { value: 'urgent' } });
    await waitFor(() => {
      expect(control.disabled).toBe(true);
      expect(control.value).toBe('urgent');
    });
    fail!();
    expect((await screen.findByRole('alert')).textContent).toBe(t('priority.saveFailed'));
    await waitFor(() => {
      expect(control.value).toBe('normal');
      expect(control.disabled).toBe(false);
      expect(document.activeElement).toBe(control);
    });
  });

  it('shows a read-only value and hides the row when unset', async () => {
    const project = mockProject();
    const task = { ...project.backend.findTask('AC-20')!, priority: 'low' as const };
    const view = project.render(<TaskPrioritySelect task={task} />, '/', { can: { createTasks: false } });
    expect(screen.getByText(t('priority.levels.low'))).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
    view.unmount();
    project.render(<TaskPrioritySelect task={{ ...task, priority: null }} />, '/', {
      can: { createTasks: false },
    });
    expect(screen.queryByText(t('priority.label'))).toBeNull();
  });

  it('follows external updates and permits editing a closed task', async () => {
    const project = mockProject();
    const task = { ...project.backend.findTask('AC-20')!, status: 'done' as const };
    project.backend.updateTask(task.key, { status: 'done' });
    function ExternalUpdate() {
      const [current, setCurrent] = useState(task);
      return (
        <>
          <button onClick={() => setCurrent({ ...task, priority: 'high' })}>External update</button>
          <TaskPrioritySelect task={current} />
        </>
      );
    }
    project.render(<ExternalUpdate />);
    expect((await select()).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'External update' }));
    expect((await select()).value).toBe('high');
    fireEvent.change(await select(), { target: { value: 'low' } });
    await waitFor(() => expect(project.backend.findTask(task.key)!.priority).toBe('low'));
  });
});
