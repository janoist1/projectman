import styles from './BoardPage.module.css';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { ToastProvider } from '../../components/Toast';
import { t } from '../../i18n/t';
import { findBoardCardLinks, withoutTeamStrip } from '../../test/boardCards';
import { createMockFetch, mockProject } from '../../test/mockProject';
import { BoardPage } from './BoardPage';

afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

function transfer() {
  return { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
}

describe('desktop board moving', () => {
  it('applies explicit and positional colours to constrained columns and card lists', async () => {
    const project = mockProject();
    project.backend.config.pipeline.columns[0]!.color = 'purple';
    delete project.backend.config.pipeline.columns[1]!.color;
    const view = project.render(<BoardPage />);
    const column = await screen.findByRole('region', {
      name: project.backend.config.pipeline.columns[0]!.name,
    });
    expect(column.getAttribute('data-column-color')).toBe('purple');
    expect(
      screen
        .getByRole('region', { name: project.backend.config.pipeline.columns[1]!.name })
        .getAttribute('data-column-color'),
    ).toBe('blue');
    expect(column.classList.contains(styles.column!)).toBe(true);
    expect(column.parentElement!.classList.contains(styles.columns!)).toBe(true);
    expect(column.querySelector(`.${styles.cards}`)).toBeTruthy();
    expect(view.container.firstElementChild!.classList.contains(styles.page!)).toBe(true);
  });

  it('shows the drop target and pending card, then rolls back a blocked move', async () => {
    const project = mockProject();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backendFetch = createMockFetch(project.backend);
    setFetchImplementation(async (path, init) => {
      if (path.endsWith('/board-move')) await held;
      return backendFetch(path, init);
    });
    project.render(
      <ToastProvider>
        <BoardPage />
      </ToastProvider>,
    );
    const title = project.backend.findTask('AC-20')!.title;
    const card = (await findBoardCardLinks(title))[0]!.parentElement!;
    expect(card.draggable).toBe(true);
    const column = screen.getByRole('region', {
      name: project.backend.config.pipeline.columns.find((entry) => entry.id === 'client')!.name,
    });
    const dataTransfer = transfer();
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.dragOver(column, { dataTransfer });
    expect(
      within(column).getByText(
        t('task.move.dropTarget', {
          stage: project.backend.config.pipeline.stages.find((entry) => entry.id === 'client_test')!.name,
        }),
      ),
    ).toBeTruthy();
    fireEvent.drop(column, { dataTransfer });
    expect(within(column).getByText(title)).toBeTruthy();
    expect(within(column).getByText(t('task.move.pending'))).toBeTruthy();
    release();
    await screen.findByText(new RegExp(t('errors.codes.gate_blocked')));
    await waitFor(() => expect(within(column).queryByText(title)).toBeNull());
    expect(project.backend.findTask('AC-20')?.stageId).toBe('dev');
    expect(screen.queryByText(t('task.move.pending'))).toBeNull();
  });
  it('moves into the first stage of a grouped destination column', async () => {
    const project = mockProject();
    project.render(<BoardPage />);
    const card = (await findBoardCardLinks(project.backend.findTask('AC-20')!.title))[0]!.parentElement!;
    const column = screen.getByRole('region', {
      name: project.backend.config.pipeline.columns.find((entry) => entry.id === 'review')!.name,
    });
    const dataTransfer = transfer();
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.drop(column, { dataTransfer });
    await waitFor(() => expect(project.backend.findTask('AC-20')?.stageId).toBe('code_review'));
    await waitFor(() => expect(screen.queryByText(t('task.move.pending'))).toBeNull());
  });
  describe('dropping a card with an open prerequisite into the work stage (PM-204)', () => {
    const patches = (project: ReturnType<typeof mockProject>) =>
      project.requests.filter((request) => request.path.endsWith('/board-move'));
    // The jsdom layout has no boxes, so a drop on a column lands before its first card.
    const intoWork = (extra: object = {}) => ({
      columnId: 'dev',
      fromStageId: 'ready',
      placement: { at: 'before', anchor: 'AC-20' },
      ...extra,
    });
    const dropOnWork = async (project: ReturnType<typeof mockProject>, taskKey: string) => {
      project.render(
        <ToastProvider>
          <BoardPage />
        </ToastProvider>,
      );
      const card = (await findBoardCardLinks(project.backend.findTask(taskKey)!.title))[0]!.parentElement!;
      const workStage = project.backend.config.pipeline.stages.find((stage) => stage.id === 'dev')!;
      const workColumn = project.backend.config.pipeline.columns.find(
        (column) => column.id === workStage.columnId,
      )!;
      const column = screen.getByRole('region', { name: workColumn.name });
      const dataTransfer = transfer();
      fireEvent.dragStart(card, { dataTransfer });
      fireEvent.drop(column, { dataTransfer });
    };

    it('warns first and moves nothing until the person accepts', async () => {
      const project = mockProject();
      await dropOnWork(project, 'AC-23');

      const dialog = await screen.findByRole('dialog');
      expect(dialog.textContent).toContain('AC-17');
      expect(patches(project)).toEqual([]);

      fireEvent.click(within(dialog).getByRole('button', { name: t('common.cancel') }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(patches(project)).toEqual([]);
      expect(project.backend.findTask('AC-23')?.stageId).toBe('ready');
    });

    it('moves with the warning accepted, and says so in the request', async () => {
      const project = mockProject();
      await dropOnWork(project, 'AC-23');

      fireEvent.click(await screen.findByRole('button', { name: t('prerequisiteWarning.confirm') }));

      await waitFor(() => expect(project.backend.findTask('AC-23')?.stageId).toBe('dev'));
      expect(patches(project).map((request) => request.body)).toEqual([
        intoWork({ despitePrerequisites: true }),
      ]);
    });

    it('moves without the flag when the person lets the card wait', async () => {
      const project = mockProject();
      await dropOnWork(project, 'AC-23');

      fireEvent.click(await screen.findByRole('button', { name: t('prerequisiteWarning.moveAndWait') }));

      await waitFor(() => expect(project.backend.findTask('AC-23')?.stageId).toBe('dev'));
      expect(patches(project).map((request) => request.body)).toEqual([intoWork()]);
    });

    it('moves a card without an open prerequisite at once', async () => {
      const project = mockProject();
      await dropOnWork(project, 'AC-24');

      await waitFor(() => expect(project.backend.findTask('AC-24')?.stageId).toBe('dev'));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(patches(project).map((request) => request.body)).toEqual([intoWork()]);
    });
  });
  it('disables dragging for clients', async () => {
    const project = mockProject();
    project.render(<BoardPage />, '/', {
      can: { createTasks: false, manageTeam: false, workInSessions: false },
    });
    const card = (await findBoardCardLinks(project.backend.findTask('AC-20')!.title))[0]!.parentElement!;
    expect(card.draggable).toBe(false);
  });
  it('disables dragging for done tasks', async () => {
    const project = mockProject();
    project.backend.updateTask('AC-20', { status: 'done' });
    project.render(<BoardPage />);
    const card = (await findBoardCardLinks(project.backend.findTask('AC-20')!.title))[0]!.parentElement!;
    expect(card.draggable).toBe(false);
  });
  it('excludes cancelled tasks from the board', async () => {
    const project = mockProject();
    project.backend.updateTask('AC-20', { status: 'cancelled' });
    project.render(<BoardPage />);
    await findBoardCardLinks(project.backend.findTask('AC-17')!.title);
    // The team strip may still name the card a member works on, so look for the card's own link.
    expect(
      withoutTeamStrip(screen.queryAllByRole('link')).some((link) =>
        link.getAttribute('href')?.endsWith('/tasks/AC-20'),
      ),
    ).toBe(false);
  });
  it('says an empty column is empty only when a filter or search narrowed the board', async () => {
    const project = mockProject();
    const view = project.render(<BoardPage />);
    await screen.findByRole('region', { name: project.backend.config.pipeline.columns[0]!.name });
    // The fixture board has a column without tasks; unfiltered it stays silent.
    expect(screen.queryByText(t('board.columnEmpty'))).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('board.filters.waiting')) }));
    expect(screen.getAllByText(t('board.columnEmpty')).length).toBeGreaterThan(0);
    view.unmount();
    project.render(<BoardPage />, '/', { search: 'zzz-no-such-task' });
    await screen.findByText(t('board.noResults', { query: 'zzz-no-such-task' }));
  });
});

function phone() {
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }));
}

describe('phone board', () => {
  it('has no draggable controls on phones', async () => {
    phone();
    const project = mockProject();
    const view = project.render(<BoardPage />);
    await findBoardCardLinks(project.backend.findTask('AC-20')!.title);
    expect(view.container.querySelector('[draggable="true"]')).toBeNull();
  });

  it('puts the filter where the title was and drops the subtitle and stage chips', async () => {
    phone();
    const project = mockProject();
    project.render(<BoardPage />);
    await screen.findByRole('group', { name: t('board.filtersLabel') });
    // The page title stays for screen readers; the subtitle is gone.
    expect(screen.getByRole('heading', { level: 1, name: t('board.title') })).toBeTruthy();
    expect(screen.queryByText(/folyamatban$/)).toBeNull();
    expect(screen.queryByRole('list', { name: 'Lépések' })).toBeNull();
  });

  it('shows the task key on the card', async () => {
    phone();
    const project = mockProject();
    project.render(<BoardPage />);
    const [link] = await findBoardCardLinks(project.backend.findTask('AC-20')!.title);
    expect(within(link!).getByText('AC-20')).toBeTruthy();
  });

  it('collapses the finished group to the newest few and expands it on request', async () => {
    phone();
    const project = mockProject();
    for (const [index, key] of ['AC-17', 'AC-18', 'AC-19', 'AC-20', 'AC-21'].entries()) {
      project.backend.updateTask(key, { status: 'done', closedAt: `2026-09-2${index}T10:00:00.000Z` });
    }
    project.render(<BoardPage />);
    const done = await screen.findByRole('region', { name: t('board.groups.done') });
    expect(within(done).getAllByRole('link')).toHaveLength(3);
    const all = within(done).getByRole('button', { name: /^Mind \(\d+\)$/ });
    expect(all.getAttribute('aria-expanded')).toBe('false');
    const total = Number(/\((\d+)\)/.exec(all.textContent!)![1]);
    expect(total).toBeGreaterThanOrEqual(5);
    fireEvent.click(all);
    expect(within(done).getAllByRole('link')).toHaveLength(total);
    fireEvent.click(within(done).getByRole('button', { name: t('board.doneFewer') }));
    expect(within(done).getAllByRole('link')).toHaveLength(3);
  });

  it('shows every finished match while searching', async () => {
    phone();
    const project = mockProject();
    for (const [index, key] of ['AC-17', 'AC-18', 'AC-19', 'AC-20', 'AC-21'].entries()) {
      project.backend.updateTask(key, { status: 'done', closedAt: `2026-09-2${index}T10:00:00.000Z` });
    }
    project.render(<BoardPage />, '/', { search: 'AC-' });
    const done = await screen.findByRole('region', { name: t('board.groups.done') });
    expect(within(done).queryByRole('button', { name: /^Mind/ })).toBeNull();
    expect(within(done).getAllByRole('link').length).toBeGreaterThanOrEqual(5);
  });
});
