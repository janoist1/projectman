import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { AcceptanceItem } from '@projectman/shared';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { apiFailure } from '../../test/msw/contract';
import { onTaskUpdate } from '../../test/msw/tasks';
import { TaskDrawer } from './TaskDrawer';

const drawer = (
  <Routes>
    <Route path="/p/:key/tasks/:taskKey" element={<TaskDrawer />} />
  </Routes>
);
const AT = '2026-01-05T10:00:00.000Z';

function item(n: number, over: Partial<AcceptanceItem> = {}): AcceptanceItem {
  return {
    id: `acc_${String(n).padStart(10, '0')}`,
    position: n,
    text: `Item ${n}`,
    state: 'open',
    evidence: null,
    reason: null,
    movedTo: null,
    origin: null,
    markedBy: null,
    markedAt: null,
    confirmedBy: null,
    confirmedAt: null,
    createdBy: 'owner',
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}
const settled = (n: number, markedBy: string): AcceptanceItem =>
  item(n, { state: 'done', evidence: 'abc123', markedBy, markedAt: AT });

function setup(items: AcceptanceItem[], overrides?: Parameters<ReturnType<typeof mockProject>['render']>[2]) {
  const project = mockProject();
  project.backend.putAcceptance('AC-20', items);
  project.render(drawer, '/p/AC/tasks/AC-20', overrides);
  return project;
}
const patches = (project: ReturnType<typeof mockProject>) =>
  project.requests.filter((request) => request.method === 'PATCH');
const rowOf = async (text: string) => (await screen.findByText(text)).closest('li') as HTMLElement;
const openMenu = (row: HTMLElement, action: string) => {
  fireEvent.click(within(row).getByRole('button', { name: t('task.acceptance.more') }));
  fireEvent.click(screen.getByRole('button', { name: action }));
};

describe('acceptance items on the card', () => {
  it('counts the items and marks one done with its evidence', async () => {
    const project = setup([item(1), settled(2, 'be-1')]);
    const row = await rowOf('Item 1');
    expect(screen.getByText(t('task.acceptance.progress', { done: 1, total: 2, confirmed: 0 }))).toBeTruthy();

    fireEvent.click(within(row).getByRole('button', { name: t('task.acceptance.actions.done') }));
    const submit = screen.getByRole('button', { name: t('task.acceptance.form.doneSubmit') });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(t('task.acceptance.form.doneLabel')), {
      target: { value: 'src/a.ts:12' },
    });
    fireEvent.click(submit);

    await waitFor(() =>
      expect(patches(project)).toContainEqual(
        expect.objectContaining({
          body: { acceptance: [{ op: 'done', itemId: item(1).id, evidence: 'src/a.ts:12' }] },
        }),
      ),
    );
    await waitFor(() => expect(project.backend.acceptanceOf('AC-20')[0]!.state).toBe('done'));
  });

  it('confirms a settled item that somebody else marked', async () => {
    const project = setup([settled(1, 'be-1')]);
    const row = await rowOf('Item 1');
    fireEvent.click(within(row).getByRole('button', { name: t('task.acceptance.actions.confirm') }));
    await waitFor(() =>
      expect(patches(project)).toContainEqual(
        expect.objectContaining({ body: { acceptance: [{ op: 'confirm', itemId: item(1).id }] } }),
      ),
    );
    await waitFor(() => expect(project.backend.acceptanceOf('AC-20')[0]!.confirmedBy).toBe('owner'));
  });

  it('keeps the confirm button off for the viewer’s own mark, with the reason', async () => {
    const project = setup([settled(1, 'owner')]);
    const row = await rowOf('Item 1');
    const button = within(row).getByRole('button', {
      name: t('task.acceptance.actions.confirm'),
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(within(row).getByText(t('errors.acceptanceRefusal.own_work'))).toBeTruthy();
    fireEvent.click(button);
    expect(patches(project)).toHaveLength(0);
  });

  it('moves an open item to another card picked from the open ones', async () => {
    const project = setup([item(1)]);
    openMenu(await rowOf('Item 1'), t('task.acceptance.actions.move'));
    const picker = screen.getByLabelText(t('task.acceptance.form.moveLabel')) as HTMLSelectElement;
    expect([...picker.options].map((option) => option.value)).not.toContain('AC-20');
    fireEvent.change(picker, { target: { value: 'AC-24' } });
    fireEvent.click(
      within(picker.closest('form')!).getByRole('button', { name: t('task.acceptance.form.moveSubmit') }),
    );
    await waitFor(() =>
      expect(patches(project)).toContainEqual(
        expect.objectContaining({
          body: { acceptance: [{ op: 'move', itemId: item(1).id, taskKey: 'AC-24' }] },
        }),
      ),
    );
    expect(project.backend.acceptanceOf('AC-24')[0]!.origin).toEqual({
      taskKey: 'AC-20',
      itemId: item(1).id,
    });
  });

  it('adds items one after the other without closing the input', async () => {
    const project = setup([item(1)]);
    await screen.findByText('Item 1');
    fireEvent.click(screen.getByRole('button', { name: t('task.acceptance.add.open') }));
    const input = screen.getByLabelText(t('task.acceptance.add.label')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Second' } });
    fireEvent.submit(input.closest('form')!);
    await screen.findByText('Second');
    await waitFor(() => expect(input.value).toBe(''));
    expect(screen.getByLabelText(t('task.acceptance.add.label'))).toBe(input);
    expect(patches(project)).toContainEqual(
      expect.objectContaining({ body: { acceptance: [{ op: 'add', text: 'Second' }] } }),
    );
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByLabelText(t('task.acceptance.add.label'))).toBeNull();
  });

  it('shows the server’s reason when it refuses a change', async () => {
    setup([item(1)]);
    onTaskUpdate(
      'AC-20',
      apiFailure(409, 'acceptance_item_refused', 'refused', { reason: 'not_marker', itemId: item(1).id }),
    );
    openMenu(await rowOf('Item 1'), t('task.acceptance.actions.remove'));
    fireEvent.click(screen.getByRole('button', { name: t('task.acceptance.form.removeSubmit') }));
    expect((await screen.findByRole('alert')).textContent).toBe(t('errors.acceptanceRefusal.not_marker'));
  });

  it('invites to write the first item, and is silent for a viewer with nothing to read', async () => {
    const first = setup([]);
    expect(await screen.findByText(t('task.acceptance.empty'))).toBeTruthy();
    expect(screen.getByRole('button', { name: t('task.acceptance.add.open') })).toBeTruthy();
    expect(patches(first)).toHaveLength(0);
  });

  it('shows the list read-only when the viewer cannot edit cards', async () => {
    setup([item(1), settled(2, 'be-1')], { can: { createTasks: false } });
    await screen.findByText('Item 1');
    expect(screen.queryByRole('button', { name: t('task.acceptance.actions.confirm') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('task.acceptance.add.open') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('task.acceptance.more') })).toBeNull();
  });

  it('hides the whole section for a viewer when there are no items', async () => {
    const project = setup([], { can: { createTasks: false } });
    await screen.findAllByText(project.backend.findTask('AC-20')!.title);
    expect(screen.queryByText(t('task.acceptance.title'))).toBeNull();
  });
});
