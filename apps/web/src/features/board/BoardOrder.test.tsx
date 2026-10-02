import styles from './BoardPage.module.css';
import { act, createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sortBoardOrder } from '@projectman/shared';
import type { ServerEvent } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { applyServerEvent } from '../../api/cache';
import { ToastProvider } from '../../components/Toast';
import { t } from '../../i18n/t';
import { findBoardCardLinks } from '../../test/boardCards';
import { createMockFetch, mockProject } from '../../test/mockProject';
import { BoardPage } from './BoardPage';

afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

type Project = ReturnType<typeof mockProject>;

function transfer() {
  return { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
}

const columnOf = (project: Project, id: string) =>
  screen.getByRole('region', {
    name: project.backend.config.pipeline.columns.find((c) => c.id === id)!.name,
  });
const cardOf = (key: string) => document.querySelector<HTMLElement>(`[data-card-key="${key}"]`)!;
const keysIn = (column: HTMLElement) =>
  Array.from(column.querySelectorAll<HTMLElement>('[data-card-key]')).map((card) => card.dataset.cardKey);
const lines = (column: HTMLElement) => column.querySelectorAll(`.${styles.dropLine}`);
const moves = (project: Project) =>
  project.requests.filter((request) => request.path.endsWith('/board-move'));

/** jsdom has no layout: gives a column's cards boxes 100px apart (the middle of the n-th card is n*100+40). */
function layout(column: HTMLElement) {
  Array.from(column.querySelectorAll<HTMLElement>('[data-card-key]')).forEach((card, index) => {
    card.getBoundingClientRect = () =>
      ({
        top: index * 100,
        bottom: index * 100 + 80,
        height: 80,
        left: 0,
        right: 200,
        width: 200,
      }) as DOMRect;
  });
}

/** The stored order of a column's open cards, by the shared rule. */
function storedOrder(project: Project, columnId: string) {
  const stages = new Set(
    project.backend.config.pipeline.stages.filter((s) => s.columnId === columnId).map((s) => s.id),
  );
  return sortBoardOrder(
    project.backend.tasks
      .filter((task) => stages.has(task.stageId) && task.status !== 'done' && task.status !== 'cancelled')
      .map((task) => ({ key: task.key, rank: task.boardRank, updatedAt: task.updatedAt })),
  ).map((card) => card.key);
}

async function renderBoard(project: Project, overrides: Parameters<Project['render']>[2] = {}) {
  const view = project.render(
    <ToastProvider>
      <BoardPage />
    </ToastProvider>,
    '/',
    overrides,
  );
  await findBoardCardLinks(project.backend.findTask('AC-25')!.title);
  return view;
}

/** jsdom has no DragEvent, so the pointer position is put on the event by hand. */
function dragEvent(type: 'dragOver' | 'drop', target: HTMLElement, dataTransfer: object, y: number) {
  const event = createEvent[type](target, { dataTransfer });
  Object.defineProperty(event, 'clientY', { value: y });
  fireEvent(target, event);
}

/** Holds a card over `y` of the column and drops it there. */
function dragTo(column: HTMLElement, key: string, y: number) {
  layout(column);
  const dataTransfer = transfer();
  fireEvent.dragStart(cardOf(key), { dataTransfer });
  dragEvent('dragOver', column, dataTransfer, y);
  return { drop: () => dragEvent('drop', column, dataTransfer, y), dataTransfer };
}

describe('manual card order on the board (PM-118)', () => {
  it('shows a column in its stored order, whatever the cards are doing', async () => {
    const project = mockProject();
    await renderBoard(project);
    // Three stages share the review column; the order is the stored one, not the stage's or the phase's.
    expect(keysIn(columnOf(project, 'review'))).toEqual(['AC-25', 'AC-26', 'AC-21']);
    expect(keysIn(columnOf(project, 'dev'))).toEqual(['AC-20', 'AC-22']);
  });

  it('puts a card at the place it is dropped in its own column and keeps its stage', async () => {
    const project = mockProject();
    await renderBoard(project);
    const review = columnOf(project, 'review');
    const { drop } = dragTo(review, 'AC-25', 150);

    expect(lines(review)).toHaveLength(1);
    expect(screen.queryByText(new RegExp(t('task.move.dropTarget', { stage: '.*' })))).toBeNull();
    drop();

    await waitFor(() => expect(keysIn(review)).toEqual(['AC-26', 'AC-25', 'AC-21']));
    expect(moves(project).map((request) => request.body)).toEqual([
      { columnId: 'review', fromStageId: 'code_review', placement: { at: 'before', anchor: 'AC-21' } },
    ]);
    expect(project.backend.findTask('AC-25')?.stageId).toBe('code_review');
    expect(storedOrder(project, 'review')).toEqual(['AC-26', 'AC-25', 'AC-21']);
    // A rank is never sent from the browser.
    expect(JSON.stringify(moves(project)[0]!.body)).not.toContain('rank');
    expect(screen.queryByText(t('task.move.success'))).toBeNull();
  });

  it('shows the card on its new place at once, while the request is on its way', async () => {
    const project = mockProject();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inner = createMockFetch(project.backend, project.requests);
    setFetchImplementation(async (path, init) => {
      if (path.endsWith('/board-move')) await held;
      return inner(path, init);
    });
    await renderBoard(project);
    const review = columnOf(project, 'review');
    dragTo(review, 'AC-25', 150).drop();

    expect(keysIn(review)).toEqual(['AC-26', 'AC-25', 'AC-21']);
    expect(within(review).getByText(t('task.move.pending'))).toBeTruthy();
    release();
    await waitFor(() => expect(screen.queryByText(t('task.move.pending'))).toBeNull());
    expect(keysIn(review)).toEqual(['AC-26', 'AC-25', 'AC-21']);
  });

  it('sends nothing when the card is dropped where it already is', async () => {
    const project = mockProject();
    await renderBoard(project);
    const review = columnOf(project, 'review');
    const { drop } = dragTo(review, 'AC-26', 150);

    expect(lines(review)).toHaveLength(0);
    drop();
    await Promise.resolve();
    expect(moves(project)).toEqual([]);
    expect(keysIn(review)).toEqual(['AC-25', 'AC-26', 'AC-21']);
  });

  it('drops a card of another column between two cards, and enters the column by its first stage', async () => {
    const project = mockProject();
    await renderBoard(project);
    const dev = columnOf(project, 'dev');
    const { drop } = dragTo(dev, 'AC-24', 100);

    expect(lines(dev)).toHaveLength(1);
    const stage = project.backend.config.pipeline.stages.find((entry) => entry.id === 'dev')!;
    expect(within(dev).getByText(t('task.move.dropTarget', { stage: stage.name }))).toBeTruthy();
    drop();

    await waitFor(() => expect(project.backend.findTask('AC-24')?.stageId).toBe('dev'));
    await waitFor(() => expect(keysIn(dev)).toEqual(['AC-20', 'AC-24', 'AC-22']));
    expect(moves(project).map((request) => request.body)).toEqual([
      { columnId: 'dev', fromStageId: 'ready', placement: { at: 'before', anchor: 'AC-22' } },
    ]);
    expect(await screen.findByText(t('task.move.success'))).toBeTruthy();
    expect(storedOrder(project, 'dev')).toEqual(['AC-20', 'AC-24', 'AC-22']);
  });

  it('places the card against the visible neighbour when a search hides some cards', async () => {
    const project = mockProject();
    project.backend.updateTask('AC-25', { title: 'Alpha one' });
    project.backend.updateTask('AC-21', { title: 'Alpha two' });
    await renderBoard(project, { search: 'Alpha' });
    const review = columnOf(project, 'review');
    expect(keysIn(review)).toEqual(['AC-25', 'AC-21']);
    dragTo(review, 'AC-25', 250).drop();

    await waitFor(() => expect(moves(project)).toHaveLength(1));
    expect(moves(project)[0]!.body).toEqual({
      columnId: 'review',
      fromStageId: 'code_review',
      placement: { at: 'after', anchor: 'AC-21' },
    });
    // The card the search hides keeps its place.
    await waitFor(() => expect(storedOrder(project, 'review')).toEqual(['AC-26', 'AC-21', 'AC-25']));
  });

  it('says the Done column is ordered by time, and draws no insertion line over it', async () => {
    const project = mockProject();
    await renderBoard(project);
    const done = columnOf(project, 'done');
    expect(within(done).getByText(t('board.doneChronological'))).toBeTruthy();
    expect(keysIn(done).every((key) => cardOf(key!).draggable === false)).toBe(true);

    const target = dragTo(done, 'AC-28', 150);
    expect(lines(done)).toHaveLength(0);
    target.drop();
    await waitFor(() => expect(moves(project)).toHaveLength(1));
    expect(moves(project)[0]!.body).toEqual({
      columnId: 'done',
      fromStageId: 'release',
      placement: { at: 'top' },
    });
  });

  it('says the board changed when the anchor is gone, and shows the order as it is', async () => {
    const project = mockProject();
    await renderBoard(project);
    const review = columnOf(project, 'review');
    layout(review);
    // Someone else moved AC-21 out of the column; this browser has not heard of it yet.
    project.backend.tasks.find((task) => task.key === 'AC-21')!.stageId = 'client_test';
    dragTo(review, 'AC-25', 150).drop();

    expect(await screen.findByText(t('errors.codes.board_stale'))).toBeTruthy();
    await waitFor(() => expect(keysIn(review)).toEqual(['AC-25', 'AC-26']));
    expect(screen.queryByText(t('task.move.pending'))).toBeNull();
  });

  it('follows another person reordering the column, and shows a new card at the top', async () => {
    const project = mockProject();
    const view = await renderBoard(project);
    const connection = {
      deliver: (event: ServerEvent) => act(() => applyServerEvent(view.client, event)),
    };
    project.backend.connect(connection);
    project.backend.handleCommand(connection, { type: 'subscribe_project', projectKey: 'AC' });
    const review = columnOf(project, 'review');

    const reply = project.backend.handle('POST', '/api/projects/AC/tasks/AC-25/board-move', {
      columnId: 'review',
      fromStageId: 'code_review',
      placement: { at: 'end' },
    });
    expect(reply.status).toBe(200);
    await waitFor(() => expect(keysIn(review)).toEqual(['AC-26', 'AC-21', 'AC-25']));

    const created = project.backend.handle('POST', '/api/projects/AC/tasks', { title: 'Brand new card' });
    expect(created.status).toBe(201);
    const ready = columnOf(project, 'ready');
    await waitFor(() => expect(keysIn(ready)).toHaveLength(3));
    expect(within(ready).getAllByRole('link')[0]!.textContent).toContain('Brand new card');
  });

  it('reorders by keyboard with Alt+Arrow, says where the card went and keeps the focus on it', async () => {
    const project = mockProject();
    await renderBoard(project);
    const review = columnOf(project, 'review');
    const link = cardOf('AC-25').querySelector('a')!;
    link.focus();
    expect(link.getAttribute('aria-keyshortcuts')).toBe('Alt+ArrowUp Alt+ArrowDown');
    expect(document.getElementById(link.getAttribute('aria-describedby')!)?.textContent).toBe(
      t('board.reorder.help'),
    );

    fireEvent.keyDown(link, { key: 'ArrowDown' });
    await Promise.resolve();
    expect(moves(project)).toEqual([]);

    fireEvent.keyDown(link, { key: 'ArrowDown', altKey: true });
    await waitFor(() => expect(keysIn(review)).toEqual(['AC-26', 'AC-25', 'AC-21']));
    expect(moves(project).map((request) => request.body)).toEqual([
      { columnId: 'review', fromStageId: 'code_review', placement: { at: 'before', anchor: 'AC-21' } },
    ]);
    const column = project.backend.config.pipeline.columns.find((c) => c.id === 'review')!;
    expect(
      screen.getByText(t('board.reorder.moved', { column: column.name, position: 2, key: 'AC-25' })),
    ).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(cardOf('AC-25').querySelector('a')));
  });

  it('says so at the top and the bottom of a column, and in the Done column', async () => {
    const project = mockProject();
    await renderBoard(project);
    fireEvent.keyDown(cardOf('AC-25').querySelector('a')!, { key: 'ArrowUp', altKey: true });
    expect(screen.getByText(t('board.reorder.atTop'))).toBeTruthy();
    fireEvent.keyDown(cardOf('AC-21').querySelector('a')!, { key: 'ArrowDown', altKey: true });
    expect(screen.getByText(t('board.reorder.atBottom'))).toBeTruthy();
    fireEvent.keyDown(cardOf('AC-16').querySelector('a')!, { key: 'ArrowDown', altKey: true });
    expect(screen.getByText(t('board.reorder.doneFixed'))).toBeTruthy();
    expect(moves(project)).toEqual([]);
  });

  it('offers no keyboard reordering to a viewer who may not move cards', async () => {
    const project = mockProject();
    await renderBoard(project, { can: { createTasks: false, manageTeam: false, workInSessions: false } });
    const link = cardOf('AC-25').querySelector('a')!;
    expect(link.getAttribute('aria-keyshortcuts')).toBeNull();
    fireEvent.keyDown(link, { key: 'ArrowDown', altKey: true });
    await Promise.resolve();
    expect(moves(project)).toEqual([]);
  });
});
