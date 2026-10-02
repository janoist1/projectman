import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Task } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import type { MockBackend } from '../../mocks/backend';
import { findBoardCardLinks, withoutTeamStrip } from '../../test/boardCards';
import { mockProject } from '../../test/mockProject';
import { BoardPage } from './BoardPage';
import { NewTaskDialog } from './NewTaskDialog';
import { TaskDrawer } from './TaskDrawer';

afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

const base = '/api/projects/AC/tasks';
const create = (backend: MockBackend, title: string, extra: object = {}) =>
  Task.parse(backend.handle('POST', base, { title, ...extra }).body);

/**
 * A theme with five cards: two cards of the board's own (one open, one done), a collecting card with
 * a subtask and a cancelled subtask. A second theme, a closed one, and a card outside every theme.
 */
function themed() {
  const project = mockProject();
  const { backend } = project;
  const theme = create(backend, 'Webshop epic', { kind: 'theme' });
  const other = create(backend, 'Hosting epic', { kind: 'theme' });
  const collector = create(backend, 'Collector card', { themeKey: theme.key });
  const subtask = create(backend, 'Open subtask', { parentKey: collector.key });
  const dropped = create(backend, 'Dropped subtask', { parentKey: collector.key });
  backend.handle('POST', `${base}/${dropped.key}/cancel`, {});
  backend.updateTask('AC-24', { themeKey: theme.key });
  backend.updateTask('AC-16', { themeKey: theme.key });
  return { project, backend, theme, other, collector, subtask, dropped };
}

const boardRoutes = (
  <Routes>
    <Route path="/p/:projectKey" element={<BoardPage />} />
    <Route path="/p/:projectKey/tasks/:taskKey" element={<BoardPage />}>
      <Route index element={<TaskDrawer />} />
    </Route>
  </Routes>
);

const drawerRoutes = (
  <Routes>
    <Route path="/p/:key/tasks/:taskKey" element={<TaskDrawer />} />
  </Routes>
);

const tile = (title: string, done: number, total: number) =>
  screen.findByRole('button', { name: t('board.themes.filter', { title, done, total }) });
/** The tile's main button (the one that filters); the arrow beside it opens the theme. */
const filterTile = (title: string) =>
  screen
    .getAllByRole('button', { name: new RegExp(title) })
    .find((button) => button.hasAttribute('aria-pressed'))!;
const titleOf = (backend: MockBackend, key: string) => backend.findTask(key)!.title;
const hasCard = (title: string) =>
  withoutTeamStrip(screen.queryAllByRole('link', { name: new RegExp(title) })).length > 0;

describe('themes on the board', () => {
  it('lists the themes in a strip and keeps them out of the columns', async () => {
    const { project, theme, other } = themed();
    project.render(<BoardPage />);
    const strip = await screen.findByRole('region', { name: t('board.themes.title') });
    // Five cards count: the done one, the open ones and the collecting card; the cancelled subtask does not.
    expect(await tile(theme.title, 1, 4)).toBeTruthy();
    expect(within(strip).getAllByRole('button', { name: new RegExp(other.title) })).toHaveLength(2);
    await findBoardCardLinks(titleOf(project.backend, 'AC-20'));
    // A theme is no card: it has no link among the columns' cards.
    expect(hasCard(theme.title)).toBe(false);
    expect(hasCard(other.title)).toBe(false);
    // Nor does it count in the board's totals: only the cards of the pipeline do.
    const cards = project.backend.tasks.filter(
      (task) => task.kind !== 'theme' && task.status !== 'cancelled',
    );
    const all = within(screen.getByRole('group', { name: t('board.filtersLabel') })).getByRole('button', {
      name: new RegExp(`^${t('board.filters.all')}`),
    });
    expect(within(all).getByText(String(cards.length))).toBeTruthy();
  });

  it('shows no strip while the project has no theme', async () => {
    const project = mockProject();
    project.render(<BoardPage />);
    await findBoardCardLinks(titleOf(project.backend, 'AC-20'));
    expect(screen.queryByRole('region', { name: t('board.themes.title') })).toBeNull();
  });

  it('filters the board to a theme, subtasks of a collecting card included, and back', async () => {
    const { project, backend, theme, collector, subtask } = themed();
    project.render(<BoardPage />);
    fireEvent.click(await tile(theme.title, 1, 4));
    await waitFor(() => expect(hasCard(titleOf(backend, 'AC-20'))).toBe(false));
    expect(hasCard(titleOf(backend, 'AC-24'))).toBe(true);
    expect(hasCard(collector.title)).toBe(true);
    expect(hasCard(subtask.title)).toBe(true);
    expect(screen.getByText(t('board.subtitleFiltered', { values: theme.title, count: 4 }))).toBeTruthy();
    expect(filterTile(theme.title).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(filterTile(theme.title));
    await waitFor(() => expect(hasCard(titleOf(backend, 'AC-20'))).toBe(true));
  });

  it('follows a collecting card that changes theme, with its subtasks', async () => {
    const { project, backend, other, collector, subtask } = themed();
    expect(backend.handle('PATCH', `${base}/${collector.key}`, { themeKey: other.key }).status).toBe(200);
    project.render(<BoardPage />);
    fireEvent.click(await tile(other.title, 0, 2));
    await waitFor(() => expect(hasCard(subtask.title)).toBe(true));
    expect(hasCard(collector.title)).toBe(true);
    expect(hasCard(titleOf(backend, 'AC-24'))).toBe(false);
  });

  it('narrows together with the search and the other filters', async () => {
    const { project, backend, theme, collector, subtask } = themed();
    project.render(<BoardPage />, '/', { search: 'subtask' });
    fireEvent.click(await tile(theme.title, 1, 4));
    // Of the theme's cards only the subtasks match the search.
    await waitFor(() => expect(hasCard(collector.title)).toBe(false));
    expect(hasCard(subtask.title)).toBe(true);
    expect(hasCard(titleOf(backend, 'AC-24'))).toBe(false);
    // The counts of the filter buttons follow the theme too: the open subtask waits for work.
    const all = within(screen.getByRole('group', { name: t('board.filtersLabel') })).getByRole('button', {
      name: new RegExp(`^${t('board.filters.all')}`),
    });
    expect(within(all).getByText('1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${t('board.filters.needsYou')}`) }));
    await waitFor(() => expect(hasCard(subtask.title)).toBe(false));
  });

  it('opens a theme from its tile and hides the closed ones until asked', async () => {
    const { project, backend, other } = themed();
    backend.handle('POST', `${base}/${other.key}/close-theme`, {});
    project.render(boardRoutes, '/p/AC');
    await screen.findByRole('region', { name: t('board.themes.title') });
    expect(screen.queryAllByRole('button', { name: new RegExp(other.title) })).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: t('board.themes.closed', { count: 1 }) }));
    expect(filterTile(other.title)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('board.themes.open', { title: other.title }) }));
    expect((await screen.findByRole('heading', { name: other.title })).tagName).toBe('H2');
    expect(
      within(screen.getByRole('complementary', { name: t('theme.drawerLabel') })).getByText(t('theme.badge')),
    ).toBeTruthy();
  });

  it('shows the same strip and a list without themes on a phone', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query) =>
        ({
          matches: query.includes('max-width'),
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    );
    const { project, backend, theme } = themed();
    project.render(<BoardPage />);
    expect(await tile(theme.title, 1, 4)).toBeTruthy();
    await screen.findByText(titleOf(backend, 'AC-20'));
    expect(hasCard(theme.title)).toBe(false);
    fireEvent.click(await tile(theme.title, 1, 4));
    await waitFor(() => expect(hasCard(titleOf(backend, 'AC-20'))).toBe(false));
    expect(hasCard(titleOf(backend, 'AC-24'))).toBe(true);
  });
});

describe('creating a theme', () => {
  it('creates a theme without a repository, label or theme, and says so in the dialog', async () => {
    const project = mockProject();
    project.render(<NewTaskDialog open initialKind="theme" onClose={() => {}} />);
    await screen.findByRole('heading', { name: t('newTask.titleTheme') });
    expect(screen.queryByLabelText(t('newTask.fields.repo'))).toBeNull();
    fireEvent.change(screen.getByLabelText(t('newTask.fields.title')), { target: { value: 'Hosting move' } });
    fireEvent.click(screen.getByRole('button', { name: t('newTask.submit') }));
    await waitFor(() =>
      expect(project.backend.tasks.some((task) => task.title === 'Hosting move')).toBe(true),
    );
    const created = project.backend.tasks.find((task) => task.title === 'Hosting move')!;
    expect(created.kind).toBe('theme');
    const request = project.requests.find((entry) => entry.method === 'POST' && entry.path === base);
    expect(request?.body).toMatchObject({ title: 'Hosting move', kind: 'theme' });
    expect(request?.body).not.toHaveProperty('repo');
    expect(request?.body).not.toHaveProperty('labels');
    expect(request?.body).not.toHaveProperty('themeKey');
  });

  it('switches the kind in the dialog and offers the open themes for a task', async () => {
    const { project, backend, theme, other } = themed();
    backend.handle('POST', `${base}/${other.key}/close-theme`, {});
    project.render(<NewTaskDialog open onClose={() => {}} />);
    const select = (await screen.findByLabelText(t('newTask.fields.theme'))) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(2));
    expect([...select.options].map((option) => option.value)).toEqual(['', theme.key]);
    fireEvent.click(screen.getByRole('button', { name: t('newTask.kinds.theme') }));
    expect(screen.queryByLabelText(t('newTask.fields.theme'))).toBeNull();
    expect(screen.getByRole('heading', { name: t('newTask.titleTheme') })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('newTask.kinds.task') }));
    expect(screen.getByLabelText(t('newTask.fields.repo'))).toBeTruthy();
  });

  it('puts a new card into the theme the board is filtered to', async () => {
    const { project, backend, theme } = themed();
    project.render(<NewTaskDialog open onClose={() => {}} />, '/', { themeFilter: theme.key });
    const select = (await screen.findByLabelText(t('newTask.fields.theme'))) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(theme.key));
    expect(screen.getByText(t('newTask.fields.themeFromFilter'))).toBeTruthy();
    fireEvent.change(screen.getByLabelText(t('newTask.fields.title')), { target: { value: 'In the theme' } });
    fireEvent.click(screen.getByRole('button', { name: t('newTask.submit') }));
    await waitFor(() => expect(backend.tasks.some((task) => task.title === 'In the theme')).toBe(true));
    expect(backend.tasks.find((task) => task.title === 'In the theme')!.themeKey).toBe(theme.key);
  });
});

describe("a theme's card", () => {
  it('shows its cards as a tree and how far it is, the cancelled not counted', async () => {
    const { project, theme, collector, subtask, dropped } = themed();
    project.render(drawerRoutes, `/p/AC/tasks/${theme.key}`);
    await screen.findByText(t('theme.progress', { done: 1, total: 4 }));
    expect(screen.getByText(t('theme.percent', { percent: 25 }))).toBeTruthy();
    expect(screen.getByText(t('theme.cancelledNote', { count: 1 }))).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1');
    // The process items of a card are not there.
    expect(screen.queryByText(t('task.start'))).toBeNull();
    expect(screen.queryByText(t('taskLifecycle.assignee'))).toBeNull();
    expect(screen.queryByText(t('task.repoLabel'))).toBeNull();
    expect(screen.queryByRole('button', { name: t('taskLifecycle.title') })).toBeNull();
    const tree = screen.getByText(t('theme.cardsCount', { count: 5 })).closest('section')!;
    const nested = within(tree).getByRole('list', { name: t('theme.subtasksOf', { key: collector.key }) });
    expect(within(nested).getByText(subtask.title, { exact: false })).toBeTruthy();
    expect(within(nested).getByText(dropped.title, { exact: false })).toBeTruthy();
    fireEvent.click(within(tree).getByRole('button', { name: t('theme.collapse', { key: collector.key }) }));
    expect(
      within(tree).queryByRole('list', { name: t('theme.subtasksOf', { key: collector.key }) }),
    ).toBeNull();
    // Each card opens.
    expect(
      within(tree)
        .getByRole('link', { name: new RegExp(titleOf(project.backend, 'AC-24')) })
        .getAttribute('href'),
    ).toBe('/p/AC/tasks/AC-24');
  });

  it('says so when it has no card', async () => {
    const project = mockProject();
    const theme = create(project.backend, 'Empty epic', { kind: 'theme' });
    project.render(drawerRoutes, `/p/AC/tasks/${theme.key}`);
    await screen.findByText(t('theme.empty'));
    expect(screen.getByText(t('theme.progress', { done: 0, total: 0 }))).toBeTruthy();
  });

  it('closes and reopens without touching its cards', async () => {
    const { project, backend, theme } = themed();
    const before = JSON.stringify(backend.tasks.filter((task) => task.themeKey === theme.key));
    project.render(drawerRoutes, `/p/AC/tasks/${theme.key}`);
    fireEvent.click(await screen.findByRole('button', { name: t('theme.close') }));
    await screen.findByRole('button', { name: t('theme.reopen') });
    expect(backend.findTask(theme.key)!.status).toBe('cancelled');
    expect(screen.getByText(/Lezárt téma/)).toBeTruthy();
    expect(JSON.stringify(backend.tasks.filter((task) => task.themeKey === theme.key))).toBe(before);
    fireEvent.click(screen.getByRole('button', { name: t('theme.reopen') }));
    await screen.findByRole('button', { name: t('theme.close') });
    expect(backend.findTask(theme.key)!.status).toBe('active');
  });

  it('offers no closing to a person who cannot edit', async () => {
    const { project, theme } = themed();
    project.render(drawerRoutes, `/p/AC/tasks/${theme.key}`, {
      can: { createTasks: false, manageTeam: false, workInSessions: false },
    });
    await screen.findByText(t('theme.progress', { done: 1, total: 4 }));
    expect(screen.queryByRole('button', { name: t('theme.close') })).toBeNull();
    expect(screen.getByRole('button', { name: t('theme.filterBoard') })).toBeTruthy();
  });

  it('filters the board from its card', async () => {
    const { project, theme } = themed();
    project.render(boardRoutes, `/p/AC/tasks/${theme.key}`);
    fireEvent.click(await screen.findByRole('button', { name: t('theme.filterBoard') }));
    await waitFor(() => expect(filterTile(theme.title).getAttribute('aria-pressed')).toBe('true'));
    expect(screen.getByText(t('board.subtitleFiltered', { values: theme.title, count: 4 }))).toBeTruthy();
  });
});

describe('the theme of a card in its drawer', () => {
  it('sets and clears the theme of a card, and lists only the open themes', async () => {
    const { project, backend, theme, other } = themed();
    const third = create(backend, 'Closed epic', { kind: 'theme' });
    backend.handle('POST', `${base}/${third.key}/close-theme`, {});
    project.render(drawerRoutes, '/p/AC/tasks/AC-20');
    const select = (await screen.findByLabelText(t('task.theme'))) as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(['', theme.key, other.key]);
    fireEvent.change(select, { target: { value: other.key } });
    await waitFor(() => expect(backend.findTask('AC-20')!.themeKey).toBe(other.key));
    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => expect(backend.findTask('AC-20')!.themeKey ?? null).toBeNull());
  });

  it('keeps a closed theme the card already has in the list', async () => {
    const { project, backend, theme } = themed();
    backend.handle('POST', `${base}/${theme.key}/close-theme`, {});
    project.render(drawerRoutes, '/p/AC/tasks/AC-24');
    const select = (await screen.findByLabelText(t('task.theme'))) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(theme.key));
    expect(screen.getByRole('option', { name: t('task.themeClosed', { title: theme.title }) })).toBeTruthy();
  });

  it('says that the subtasks follow a collecting card', async () => {
    const { project, collector } = themed();
    project.render(drawerRoutes, `/p/AC/tasks/${collector.key}`);
    await screen.findByText(t('task.themeKids', { count: 2 }));
  });

  it('reads the theme of a subtask from its collecting card, without a way to change it', async () => {
    const { project, theme, collector, subtask } = themed();
    project.render(drawerRoutes, `/p/AC/tasks/${subtask.key}`);
    const link = await screen.findByRole('link', { name: theme.title });
    expect(link.getAttribute('href')).toBe(`/p/AC/tasks/${theme.key}`);
    expect(screen.getByText(`· ${t('task.themeFromParent', { key: collector.key })}`)).toBeTruthy();
    expect(screen.queryByLabelText(t('task.theme'))).toBeNull();
  });

  it('has no theme row while the project has no theme', async () => {
    const project = mockProject();
    project.render(drawerRoutes, '/p/AC/tasks/AC-20');
    await screen.findByText(t('newTask.fields.visibility'));
    expect(screen.queryByText(t('task.theme'))).toBeNull();
  });

  it('shows the theme as text to a person who cannot edit', async () => {
    const { project, theme } = themed();
    project.render(drawerRoutes, '/p/AC/tasks/AC-24', {
      can: { createTasks: false, manageTeam: false, workInSessions: false },
    });
    expect(await screen.findByRole('link', { name: theme.title })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: t('task.theme') })).toBeNull();
  });
});
