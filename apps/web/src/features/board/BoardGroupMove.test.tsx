import styles from './BoardPage.module.css';
import { createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardGroupItem, BoardMoveResult, LabelView } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { ToastProvider } from '../../components/Toast';
import { t } from '../../i18n/t';
import { findBoardCardLinks } from '../../test/boardCards';
import { createMockFetch, mockProject } from '../../test/mockProject';
import { BoardPage } from './BoardPage';
import { groupMoveToast } from './groupMove';

afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

type Project = ReturnType<typeof mockProject>;

const transfer = () => ({ setData: vi.fn(), effectAllowed: '', dropEffect: '' });
const columnOf = (project: Project, id: string) =>
  screen.getByRole('region', {
    name: project.backend.config.pipeline.columns.find((c) => c.id === id)!.name,
  });
const cardOf = (key: string) => document.querySelector<HTMLElement>(`[data-card-key="${key}"]`)!;
const keysIn = (column: HTMLElement) =>
  Array.from(column.querySelectorAll<HTMLElement>('[data-card-key]')).map((card) => card.dataset.cardKey);
const moves = (project: Project) =>
  project.requests.filter((request) => request.path.endsWith('/board-move'));
const toastRegion = () => screen.getByLabelText(t('toast.region'));

/** A collecting card of the review column with the two other cards of the column as its subtasks. */
function reviewFamily(project: Project, qaOk: readonly string[]) {
  const { backend } = project;
  for (const key of ['AC-26', 'AC-21']) backend.findTask(key)!.parentKey = 'AC-25';
  // The way to the client column passes the Integration gate (a code review) and then asks for a QA.
  backend.findTask('AC-25')!.labels.push('code-review-ok');
  for (const key of qaOk) backend.findTask(key)!.labels.push('qa-ok');
}

async function renderBoard(project: Project, overrides: Parameters<Project['render']>[2] = {}) {
  project.render(
    <ToastProvider>
      <BoardPage />
    </ToastProvider>,
    '/',
    overrides,
  );
  await findBoardCardLinks(project.backend.findTask('AC-25')!.title);
}

/** Holds a card over the top of a column (jsdom has no layout: every drop lands at the top). */
function dragOver(column: HTMLElement, key: string) {
  const dataTransfer = transfer();
  fireEvent.dragStart(cardOf(key), { dataTransfer });
  const over = createEvent.dragOver(column, { dataTransfer });
  Object.defineProperty(over, 'clientY', { value: 0 });
  fireEvent(column, over);
  return () => {
    const drop = createEvent.drop(column, { dataTransfer });
    Object.defineProperty(drop, 'clientY', { value: 0 });
    fireEvent(column, drop);
  };
}

describe('moving a collecting card with its subtasks (PM-121)', () => {
  it('marks the subtasks that go along while the card is held over another column', async () => {
    const project = mockProject();
    reviewFamily(project, []);
    await renderBoard(project);
    const client = columnOf(project, 'client');
    dragOver(client, 'AC-25');

    expect(within(client).getByText(t('board.dropHereWithSubtasks', { stage: 'Ügyfélteszt', count: 2 })));
    for (const key of ['AC-26', 'AC-21']) {
      expect(cardOf(key).classList.contains(styles.alongMark!)).toBe(true);
      expect(within(cardOf(key)).getByText(t('board.goesAlong'))).toBeTruthy();
    }
    expect(cardOf('AC-25').textContent).not.toContain(t('board.goesAlong'));
  });

  it('marks nothing when the card is held over its own column or has no subtasks', async () => {
    const project = mockProject();
    reviewFamily(project, []);
    await renderBoard(project);
    dragOver(columnOf(project, 'review'), 'AC-25');
    expect(screen.queryByText(t('board.goesAlong'))).toBeNull();
    // A card without subtasks takes the plain text.
    dragOver(columnOf(project, 'dev'), 'AC-24');
    expect(screen.queryByText(t('board.goesAlong'))).toBeNull();
    expect(
      within(columnOf(project, 'dev')).getByText(t('task.move.dropTarget', { stage: 'Fejlesztés' })),
    ).toBeTruthy();
  });

  it('counts a subtask the search hides, and shows no mark on it', async () => {
    const project = mockProject();
    reviewFamily(project, []);
    await renderBoard(project, { search: 'Számla PDF' });
    expect(cardOf('AC-26')).toBeNull();
    const client = columnOf(project, 'client');
    dragOver(client, 'AC-25');
    expect(within(client).getByText(t('board.dropHereWithSubtasks', { stage: 'Ügyfélteszt', count: 2 })));
  });

  it('moves the group in one request, leaves the cards in place meanwhile and lands them as a block', async () => {
    const project = mockProject();
    reviewFamily(project, ['AC-25', 'AC-26', 'AC-21']);
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
    const client = columnOf(project, 'client');
    const drop = dragOver(client, 'AC-25');
    drop();

    // No optimistic move: the cards stay, dimmed and busy, until the server says which of them moved.
    expect(keysIn(columnOf(project, 'review'))).toEqual(expect.arrayContaining(['AC-25', 'AC-26', 'AC-21']));
    for (const key of ['AC-25', 'AC-26', 'AC-21']) {
      expect(cardOf(key).getAttribute('aria-busy')).toBe('true');
      expect(cardOf(key).classList.contains(styles.pending!)).toBe(true);
    }
    release();

    const region = toastRegion();
    await waitFor(() =>
      expect(region.textContent).toContain(
        t('board.groupMove.parentAndChildren', { key: 'AC-25', count: 2, column: 'Ügyfélteszt' }),
      ),
    );
    expect(moves(project)).toHaveLength(1);
    expect(moves(project)[0]!.body).toEqual({
      columnId: 'client',
      fromStageId: 'code_review',
      placement: { at: 'before', anchor: 'AC-18' },
      withSubtasks: true,
    });
    // The collecting card first, its subtasks after it in their order, as one block at the dropped place.
    await waitFor(() => expect(keysIn(client).slice(0, 3)).toEqual(['AC-25', 'AC-26', 'AC-21']));
    expect(project.backend.findTask('AC-21')?.stageId).toBe('client_test');
    // Everything moved: nothing is listed under the message.
    expect(region.querySelector('ul')).toBeNull();
  });

  it('tells a partial move in one toast: what moved, then each card that stayed and why', async () => {
    const project = mockProject();
    reviewFamily(project, ['AC-25', 'AC-26']);
    await renderBoard(project);
    dragOver(columnOf(project, 'client'), 'AC-25')();

    const region = toastRegion();
    await waitFor(() =>
      expect(region.textContent).toContain(
        t('board.groupMove.parentAndChildren', { key: 'AC-25', count: 1, column: 'Ügyfélteszt' }),
      ),
    );
    expect(region.textContent).toContain(t('board.groupMove.stayed'));
    const link = within(region).getByRole('link', { name: 'AC-21' });
    expect(link.getAttribute('href')).toBe('/p/AC/tasks/AC-21');
    expect(region.textContent).toContain(t('board.groupMove.reason.missing', { labels: 'QA rendben' }));
    // The card that was held back stays where it was, and the moved ones are not taken back.
    expect(project.backend.findTask('AC-21')?.stageId).toBe('qa');
    expect(project.backend.findTask('AC-25')?.stageId).toBe('client_test');
    expect(project.backend.findTask('AC-26')?.stageId).toBe('client_test');
    expect(screen.queryByText(t('task.move.success'))).toBeNull();
    expect(moves(project)).toHaveLength(1);
  });

  it('says when no card moved, as an error that stays', async () => {
    const project = mockProject();
    reviewFamily(project, []);
    await renderBoard(project);
    dragOver(columnOf(project, 'client'), 'AC-25')();

    const region = toastRegion();
    await waitFor(() => expect(region.textContent).toContain(t('board.groupMove.none')));
    for (const key of ['AC-25', 'AC-26', 'AC-21'])
      expect(within(region).getByRole('link', { name: key })).toBeTruthy();
    expect(project.backend.findTask('AC-25')?.stageId).toBe('code_review');
    expect(keysIn(columnOf(project, 'review'))).toEqual(expect.arrayContaining(['AC-25', 'AC-26', 'AC-21']));
    expect(screen.getByRole('button', { name: t('toast.dismiss') })).toBeTruthy();
  });

  it('asks once for the whole group before cards with an open prerequisite start, and sends the answer with it', async () => {
    const project = mockProject();
    project.backend.findTask('AC-23')!.parentKey = 'AC-24';
    await renderBoard(project);
    dragOver(columnOf(project, 'dev'), 'AC-24')();

    expect(await screen.findByText(t('prerequisiteWarning.groupDescription'))).toBeTruthy();
    expect(screen.getByText(t('prerequisiteWarning.groupRow', { key: 'AC-23', keys: 'AC-17' }))).toBeTruthy();
    // Nothing is sent before the answer.
    expect(moves(project)).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: t('prerequisiteWarning.confirm') }));
    await waitFor(() => expect(moves(project)).toHaveLength(1));
    expect(moves(project)[0]!.body).toMatchObject({
      columnId: 'dev',
      despitePrerequisites: true,
      withSubtasks: true,
    });
    await waitFor(() => expect(project.backend.findTask('AC-23')?.stageId).toBe('dev'));
    expect(project.backend.findTask('AC-24')?.stageId).toBe('dev');
  });

  it('moves nothing when the warning of the group is cancelled', async () => {
    const project = mockProject();
    project.backend.findTask('AC-23')!.parentKey = 'AC-24';
    await renderBoard(project);
    dragOver(columnOf(project, 'dev'), 'AC-24')();
    await screen.findByText(t('prerequisiteWarning.groupDescription'));
    fireEvent.click(screen.getByRole('button', { name: t('common.cancel') }));
    await waitFor(() => expect(screen.queryByText(t('prerequisiteWarning.groupDescription'))).toBeNull());
    expect(moves(project)).toHaveLength(0);
    expect(project.backend.findTask('AC-24')?.stageId).toBe('ready');
  });

  it('moves a card without subtasks exactly as before: one card, no flag, the plain toast', async () => {
    const project = mockProject();
    await renderBoard(project);
    dragOver(columnOf(project, 'dev'), 'AC-24')();
    await waitFor(() => expect(project.backend.findTask('AC-24')?.stageId).toBe('dev'));
    expect(moves(project)[0]!.body).toEqual({
      columnId: 'dev',
      fromStageId: 'ready',
      placement: { at: 'before', anchor: 'AC-20' },
    });
    expect(await screen.findByText(t('task.move.success'))).toBeTruthy();
  });
});

describe('the toast of a group move', () => {
  const labels: LabelView[] = [];
  const result = (group: BoardMoveResult['group']): BoardMoveResult => ({
    task: {} as BoardMoveResult['task'],
    outcome: 'moved',
    reranked: [],
    group,
  });
  const input = (group: BoardMoveResult['group']) => ({
    result: result(group),
    parentKey: 'AC-1',
    columnName: 'Fejlesztés',
    projectKey: 'AC',
    labels,
  });
  const blocked = (taskKey: string): BoardGroupItem => ({
    taskKey,
    outcome: 'blocked',
    code: 'gate_blocked',
    message: 'x',
    unmet: [],
    approvals: [],
  });

  it('is a short confirmation that closes by itself when every card moved', () => {
    const toast = groupMoveToast(
      input([
        { taskKey: 'AC-1', outcome: 'moved' },
        { taskKey: 'AC-2', outcome: 'moved' },
      ]),
    );
    expect(toast).toMatchObject({ tone: 'ok', sticky: false, items: [] });
    expect(toast.message).toBe(
      t('board.groupMove.parentAndChildren', { key: 'AC-1', count: 1, column: 'Fejlesztés' }),
    );
  });

  it('names what moved in the first sentence: only the collecting card, or only subtasks', () => {
    expect(groupMoveToast(input([{ taskKey: 'AC-1', outcome: 'moved' }, blocked('AC-2')])).message).toContain(
      t('board.groupMove.parentOnly', { key: 'AC-1', column: 'Fejlesztés' }),
    );
    expect(groupMoveToast(input([blocked('AC-1'), { taskKey: 'AC-2', outcome: 'moved' }])).message).toContain(
      t('board.groupMove.childrenOnly', { count: 1, column: 'Fejlesztés' }),
    );
  });

  it('stays until closed when a card stayed, as info when some moved and as an error when none did', () => {
    const some = groupMoveToast(input([{ taskKey: 'AC-1', outcome: 'moved' }, blocked('AC-2')]));
    expect(some).toMatchObject({ tone: 'info', sticky: true });
    expect(some.items).toEqual([
      { key: 'AC-2', to: '/p/AC/tasks/AC-2', text: t('board.groupMove.reason.unknown') },
    ]);
    const none = groupMoveToast(input([blocked('AC-1'), blocked('AC-2')]));
    expect(none).toMatchObject({ tone: 'error', sticky: true });
    expect(none.message).toBe(`${t('board.groupMove.none')} ${t('board.groupMove.stayed')}`);
  });

  it('gives the reason of each kind of card that stayed, and counts what is over five lines', () => {
    const group: NonNullable<BoardMoveResult['group']> = [
      { taskKey: 'AC-1', outcome: 'moved' },
      { taskKey: 'AC-2', outcome: 'approval_pending', inboxItemIds: ['inb-1'] },
      { taskKey: 'AC-3', outcome: 'skipped', reason: 'changed' },
      { taskKey: 'AC-4', outcome: 'skipped', reason: 'closed' },
      blocked('AC-5'),
      blocked('AC-6'),
      blocked('AC-7'),
      blocked('AC-8'),
    ];
    const { items } = groupMoveToast(input(group));
    expect(items).toHaveLength(6);
    expect(items[0]!.text).toBe(t('board.groupMove.reason.approval'));
    expect(items[1]!.text).toBe(t('board.groupMove.reason.skipped'));
    expect(items[5]).toMatchObject({ bare: true, text: t('board.groupMove.more', { count: 2 }) });
  });

  it('says that nobody may give the approval a card needs, naming the label', () => {
    const noApprover = (taskKey: string, label?: string): BoardGroupItem => ({
      taskKey,
      outcome: 'blocked',
      code: 'no_approver',
      message: 'x',
      unmet: [],
      approvals: label ? [{ stageId: 'merge', label, approvers: [] }] : [],
    });
    const { items } = groupMoveToast(
      input([{ taskKey: 'AC-1', outcome: 'moved' }, noApprover('AC-2', 'merge-ok'), noApprover('AC-3')]),
    );
    expect(items[0]!.text).toBe(t('board.groupMove.reason.noApprover', { label: 'merge-ok' }));
    expect(items[1]!.text).toBe(t('board.groupMove.reason.noApproverUnnamed'));
  });
});
