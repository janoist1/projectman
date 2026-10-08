import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Task } from '@projectman/shared';
import type { InboxItem } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { MeContext } from '../../app/contexts';
import { ProjectLayout } from '../../app/ProjectLayout';
import { t } from '../../i18n/t';
import type { MockBackend } from '../../mocks/backend';
import * as fixtures from '../../mocks/fixtures';
import { mockProject } from '../../test/mockProject';
import { MapOverview } from './MapOverview';
import { MapPage } from './MapPage';

afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

const base = '/api/projects/AC/tasks';
const create = (backend: MockBackend, title: string, extra: object = {}) =>
  Task.parse(backend.handle('POST', base, { title, ...extra }).body);

/**
 * Two themes: "Webshop epic" holds AC-21 (the owner's permission question is open: Rád vár) and AC-17
 * (stands in a stage with no one working); "Hosting epic" holds AC-18 and AC-19. Everything else is "Egyéb".
 */
function themed() {
  const project = mockProject();
  const { backend } = project;
  const webshop = create(backend, 'Webshop epic', { kind: 'theme' });
  const hosting = create(backend, 'Hosting epic', { kind: 'theme' });
  backend.updateTask('AC-21', { themeKey: webshop.key });
  backend.updateTask('AC-17', { themeKey: webshop.key });
  backend.updateTask('AC-18', { themeKey: hosting.key });
  backend.updateTask('AC-19', { themeKey: hosting.key });
  return { project, backend, webshop, hosting };
}

const routes = (
  <Routes>
    <Route path="/p/:projectKey/map" element={<MapPage />}>
      <Route index element={<MapOverview />} />
    </Route>
  </Routes>
);

/** The query of the current location, to read what the filters wrote. */
function Search() {
  return <output data-testid="search">{useLocation().search}</output>;
}
const withSearch = (
  <>
    {routes}
    <Search />
  </>
);

const tileOf = (title: string) => screen.findByRole('link', { name: new RegExp(`^[^:]+: ${title}\\.`) });
const tiles = () => within(screen.getByRole('list', { name: t('map.groups') })).getAllByRole('listitem');
const titlesOf = () => tiles().map((tile) => tile.querySelector('a')?.getAttribute('aria-label') ?? '');
const segment = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });

describe('the map overview', () => {
  it('shows a tile per open theme and an "Egyéb" tile, the ones that wait for the owner first', async () => {
    const { project, webshop: theme } = themed();
    project.render(routes, '/p/AC/map');

    const webshop = await tileOf('Webshop epic');
    await tileOf('Hosting epic');
    // Both open cards of the webshop theme wait for the owner. "Egyéb" waits too but comes after the
    // named group of its level; the hosting theme has no card that waits for the owner.
    const labels = titlesOf();
    expect(labels).toHaveLength(3);
    expect(labels[0]).toContain('Webshop epic');
    expect(labels[1]).toContain(t('map.other'));
    expect(labels[2]).toContain('Hosting epic');
    expect(webshop.getAttribute('href')).toBe(`/p/AC/map/${theme.key}`);
    expect(within(webshop).getByText(t('map.signals.needsYou', { count: 2 }))).toBeTruthy();
    expect(within(webshop).getByText(t('map.progress', { done: 0, total: 2 }))).toBeTruthy();
    expect(within(webshop).getByText(t('map.kind.theme'))).toBeTruthy();
    expect(within(webshop).getByText(theme.key)).toBeTruthy();
    expect(webshop.getAttribute('data-top')).toBe('needs');
  });

  it('sums the signals into the summary line and the segments', async () => {
    const { project } = themed();
    project.render(routes, '/p/AC/map');
    await tileOf('Webshop epic');

    expect(screen.getByText(t('map.summary', { needs: 4, blocked: 3, working: 3, open: 12 }))).toBeTruthy();
    expect(segment(t('map.filters.all')).textContent).toContain('12');
    expect(segment(t('map.filters.needsYou')).textContent).toContain('4');
    expect(segment(t('map.filters.blocked')).textContent).toContain('3');
  });

  it('filters to what waits for the owner, writes it to the query, and keeps the progress bar whole', async () => {
    const { project } = themed();
    project.render(withSearch, '/p/AC/map');
    const before = await tileOf('Webshop epic');
    const progressBefore = within(before).getByText(/\d+ \/ \d+ kész/).textContent;

    fireEvent.click(segment(t('map.filters.needsYou')));
    await waitFor(() => expect(titlesOf().every((label) => !label.includes('Hosting epic'))).toBe(true));
    expect(screen.getByTestId('search').textContent).toBe('?show=needsYou');
    expect(within(await tileOf('Webshop epic')).getByText(/\d+ \/ \d+ kész/).textContent).toBe(
      progressBefore,
    );

    fireEvent.click(segment(t('map.filters.all')));
    await tileOf('Hosting epic');
    expect(screen.getByTestId('search').textContent).toBe('');
  });

  it('reads the filters from the query and ignores an unknown value', async () => {
    const { project } = themed();
    project.render(routes, '/p/AC/map?show=nonsense&member=nobody');
    await tileOf('Hosting epic');
    expect(segment(t('map.filters.all')).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('button', { name: t('map.clearFilters') })).toBeNull();
  });

  it('narrows the signals by the member but not the progress, and clears the filters', async () => {
    const { project } = themed();
    project.render(withSearch, '/p/AC/map?member=%40none');
    await screen.findByRole('button', { name: t('map.clearFilters') });
    const select = screen.getByLabelText(t('map.member')) as HTMLSelectElement;
    expect(select.value).toBe('@none');
    // No open card of the "no one responsible" choice waits for the owner or is blocked or worked on.
    expect(screen.getByText(t('map.summary', { needs: 0, blocked: 0, working: 0, open: 2 }))).toBeTruthy();
    const other = await tileOf(t('map.other'));
    const progress = within(other).getByText(/\d+ \/ \d+ kész/).textContent;

    fireEvent.change(select, { target: { value: 'be-1' } });
    expect(
      await screen.findByText(t('map.summary', { needs: 1, blocked: 0, working: 2, open: 3 })),
    ).toBeTruthy();
    expect(screen.getByTestId('search').textContent).toBe('?member=be-1');
    // The progress bar of a group is still the whole group's.
    expect(within(await tileOf(t('map.other'))).getByText(/\d+ \/ \d+ kész/).textContent).toBe(progress);

    fireEvent.click(screen.getByRole('button', { name: t('map.clearFilters') }));
    await waitFor(() => expect(screen.getByTestId('search').textContent).toBe(''));
    expect(screen.queryByRole('button', { name: t('map.clearFilters') })).toBeNull();
  });

  it('says so when a filter hides every group, and the button takes the filter off', async () => {
    const { project } = themed();
    project.render(withSearch, '/p/AC/map?show=blocked&member=be-1');
    expect(await screen.findByText(t('map.emptyFilter.blocked'))).toBeTruthy();
    expect(screen.getByText(t('map.emptyFilter.body'))).toBeTruthy();
    // The segments stay above it.
    expect(segment(t('map.filters.blocked')).getAttribute('aria-pressed')).toBe('true');
    const clear = screen.getAllByRole('button', { name: t('map.clearFilters') });
    fireEvent.click(clear.at(-1)!);
    await tileOf('Webshop epic');
    expect(screen.getByTestId('search').textContent).toBe('');
  });

  it('shows the first-use bar while only "Egyéb" exists, with a new-theme button for those who may create cards', async () => {
    const project = mockProject();
    const openNewTask = vi.fn();
    project.render(routes, '/p/AC/map', { openNewTask });
    expect(await screen.findByText(t('map.firstUse.body'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('map.firstUse.newTheme') }));
    expect(openNewTask).toHaveBeenCalledWith({ kind: 'theme' });
  });

  it('leaves the new-theme button out without the right to create cards, and the bar once a theme exists', async () => {
    const project = mockProject();
    const { unmount } = project.render(routes, '/p/AC/map', { can: { createTasks: false } });
    await screen.findByText(t('map.firstUse.body'));
    expect(screen.queryByRole('button', { name: t('map.firstUse.newTheme') })).toBeNull();
    unmount();

    const { project: withTheme } = themed();
    withTheme.render(routes, '/p/AC/map');
    await tileOf('Webshop epic');
    expect(screen.queryByText(t('map.firstUse.body'))).toBeNull();
  });

  it('shows the empty state of a project without an open card, with "Új feladat" for those who may create one', async () => {
    const project = mockProject();
    for (const task of project.backend.tasks) task.status = 'done';
    const openNewTask = vi.fn();
    project.render(routes, '/p/AC/map', { openNewTask });
    expect(await screen.findByRole('heading', { name: t('map.empty.title') })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('map.empty.newTask') }));
    expect(openNewTask).toHaveBeenCalledWith();
  });

  it('shows the error state with a retry that asks the board again', async () => {
    const project = mockProject();
    let failing = true;
    const answer = (await import('../../test/mockProject')).createMockFetch(project.backend);
    setFetchImplementation(async (input, init) =>
      failing && String(input).includes('/board')
        ? new Response(JSON.stringify({ error: { code: 'boom', message: 'Boom' } }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          })
        : answer(String(input), init),
    );
    project.render(routes, '/p/AC/map');
    const alert = await screen.findByRole('alert');
    failing = false;
    fireEvent.click(within(alert).getByRole('button', { name: t('app.retry') }));
    await tileOf(t('map.other'));
  });

  it('shows a busy skeleton while the board loads', () => {
    const project = mockProject();
    project.render(routes, '/p/AC/map');
    const list = screen.getByRole('list', { name: t('map.groups'), hidden: true });
    expect(list.getAttribute('aria-busy')).toBe('true');
  });

  it('updates a tile when a new question arrives, without a reload, and flashes it once', async () => {
    const { project, backend, hosting } = themed();
    const { client } = project.render(routes, '/p/AC/map');
    const hostingTile = await tileOf('Hosting epic');
    expect(within(hostingTile).queryByText(t('map.signals.needsYou', { count: 1 }))).toBeNull();

    const question: InboxItem = {
      ...fixtures.inbox[0]!,
      id: 'inb_map_live',
      taskKey: 'AC-18',
      title: 'A new question',
    };
    act(() => backend.upsertInbox(question));
    await act(() => client.invalidateQueries());

    const updated = await tileOf('Hosting epic');
    await waitFor(() =>
      expect(within(updated).getByText(t('map.signals.needsYou', { count: 1 }))).toBeTruthy(),
    );
    const item = screen.getByRole('link', { name: /Hosting epic/ }).closest('li')!;
    expect(item.getAttribute('data-group')).toBe(hosting.key);
    // The group moved up: it now waits for the owner, like the webshop group, and it lit up once.
    expect(titlesOf().slice(0, 2).join(' ')).toContain('Hosting epic');
    expect(item.className).toMatch(/flash/);
    await waitFor(() => expect(item.className).not.toMatch(/flash/), { timeout: 2000 });
  });
});

describe('the map in the navigation', () => {
  it('has a menu item after the board, active on the map, leading to the overview', async () => {
    const project = mockProject();
    project.render(
      <MeContext.Provider value={project.context.me}>
        <Routes>
          <Route path="/p/:projectKey" element={<ProjectLayout />}>
            <Route index element={<p>board</p>} />
            <Route path="map" element={<MapPage />}>
              <Route index element={<MapOverview />} />
            </Route>
          </Route>
        </Routes>
      </MeContext.Provider>,
      '/p/AC',
    );
    const item = await screen.findByRole('link', { name: t('nav.map') });
    expect(item.getAttribute('href')).toBe('/p/AC/map');
    expect(item.getAttribute('aria-current')).toBeNull();
    fireEvent.click(item);
    expect(await screen.findByRole('heading', { level: 1, name: t('map.title') })).toBeTruthy();
    expect(screen.getByRole('link', { name: t('nav.map') }).getAttribute('aria-current')).toBe('page');
  });
});
