import { createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { ToastProvider } from '../../components/Toast';
import { t } from '../../i18n/t';
import { findBoardCardLinks } from '../../test/boardCards';
import { mockProject } from '../../test/mockProject';
import { BoardPage } from './BoardPage';
import { TaskDrawer } from './TaskDrawer';

afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

type Project = ReturnType<typeof mockProject>;

const drawer = (
  <Routes>
    <Route path="/p/:key/tasks/:taskKey" element={<TaskDrawer />} />
  </Routes>
);

const transfer = () => ({ setData: vi.fn(), effectAllowed: '', dropEffect: '' });

/** The display name of the AI code reviewer, who merges unless the configuration says otherwise. */
function reviewerName(project: Project): string {
  return project.backend.config.team.members.find((member) => member.handle === 'code-review')!.displayName;
}

/** Drops the card on a column the way the board does (jsdom has no layout: every drop lands at the top). */
function dropOn(project: Project, taskKey: string, columnId: string) {
  const column = screen.getByRole('region', {
    name: project.backend.config.pipeline.columns.find((entry) => entry.id === columnId)!.name,
  });
  const card = document.querySelector<HTMLElement>(`[data-card-key="${taskKey}"]`)!;
  const dataTransfer = transfer();
  fireEvent.dragStart(card, { dataTransfer });
  const over = createEvent.dragOver(column, { dataTransfer });
  Object.defineProperty(over, 'clientY', { value: 0 });
  fireEvent(column, over);
  const drop = createEvent.drop(column, { dataTransfer });
  Object.defineProperty(drop, 'clientY', { value: 0 });
  fireEvent(column, drop);
}

/** Opens the move panel of the drawer and asks for the release step. */
async function moveToRelease() {
  fireEvent.click(await screen.findByRole('button', { name: t('task.move.open') }));
  const target = await screen.findByLabelText(t('task.move.target'));
  fireEvent.change(target, { target: { value: 'release' } });
  fireEvent.click(screen.getByRole('button', { name: t('task.move.submit') }));
}

describe('a move refused for want of the merge, in the drawer (PM-453)', () => {
  it('tells another member who merges and offers no button', async () => {
    const project = mockProject();
    project.backend.reconcileMerges();
    project.render(drawer, '/p/AC/tasks/AC-27');
    await moveToRelease();
    const text = t('task.merge.refused.notMerged', {
      merger: reviewerName(project),
      base: 'main',
      target: 'Élesítés',
    });
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.getByText(text).getAttribute('role')).toBe('status');
    expect(project.backend.findTask('AC-27')!.stageId).toBe('merge');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('gives the merger the error and a button that starts the merge on the spot', async () => {
    const project = mockProject();
    project.backend.config.team.merger = { kind: 'member', handle: 'owner' };
    project.backend.reconcileMerges();
    project.render(drawer, '/p/AC/tasks/AC-27');
    await moveToRelease();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('main');
    const start = within(alert.parentElement!).getByRole('button', { name: t('task.merge.button') });
    fireEvent.click(start);
    await waitFor(() => expect(project.backend.findTask('AC-27')!.merge?.state).toBe('queued'));
  });

  it('says it is the engine when the card’s machine cannot be reached', async () => {
    const project = mockProject();
    project.backend.reconcileMerges();
    project.backend.setMergeRefusal('AC-27', 'engine_unavailable');
    project.render(drawer, '/p/AC/tasks/AC-27');
    await moveToRelease();
    expect(await screen.findByText(t('task.merge.refused.engine'))).toBeTruthy();
  });
});

describe('a move refused for want of the merge, on the board (PM-453)', () => {
  it('names who merges in the toast, puts the card back and does not move it', async () => {
    const project = mockProject();
    project.backend.reconcileMerges();
    project.render(
      <ToastProvider>
        <BoardPage />
      </ToastProvider>,
    );
    await findBoardCardLinks(project.backend.findTask('AC-27')!.title);
    dropOn(project, 'AC-27', 'done');
    const region = screen.getByLabelText(t('toast.region'));
    await waitFor(() => expect(region.textContent).toContain(reviewerName(project)));
    expect(region.textContent).toContain('main');
    expect(project.backend.findTask('AC-27')!.stageId).toBe('merge');
    await waitFor(() => expect(screen.queryByText(t('task.move.pending'))).toBeNull());
  });
});

describe('a group move refused for want of the merge (PM-453)', () => {
  it('lists the held cards with the merger’s name', async () => {
    const project = mockProject();
    project.backend.findTask('AC-17')!.parentKey = 'AC-27';
    project.backend.reconcileMerges();
    project.render(
      <ToastProvider>
        <BoardPage />
      </ToastProvider>,
    );
    await findBoardCardLinks(project.backend.findTask('AC-27')!.title);
    dropOn(project, 'AC-27', 'done');
    const region = screen.getByLabelText(t('toast.region'));
    await waitFor(() => expect(region.textContent).toContain(t('board.groupMove.none')));
    expect(region.textContent).toContain(t('task.merge.refused.group', { merger: reviewerName(project) }));
    expect(within(region).getByRole('link', { name: 'AC-17' })).toBeTruthy();
    expect(project.backend.findTask('AC-27')!.stageId).toBe('merge');
    expect(project.backend.findTask('AC-17')!.stageId).toBe('merge');
  });
});
