import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Task } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import type { MockBackend } from '../../mocks/backend';
import { createMockFetch, mockProject } from '../../test/mockProject';
import { TaskDrawer } from '../board/TaskDrawer';
import { MapGroupView } from './MapGroupView';
import { MapOverview } from './MapOverview';
import { MapPage } from './MapPage';

afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

const base = '/api/projects/AC/tasks';
const create = (backend: MockBackend, title: string, extra: object = {}) =>
  Task.parse(backend.handle('POST', base, { title, ...extra }).body);

/** AC-21 waits for the owner (Átnézés column), AC-17 stands in the Merge stage (Élesítésre vár). */
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

/** `key` needs `prerequisite` before it can finish. */
const needs = (backend: MockBackend, key: string, prerequisite: string) =>
  backend.handle('PATCH', `${base}/${key}`, {
    relations: { add: [{ kind: 'prerequisite', key: prerequisite }] },
  });

function Where() {
  const { pathname, search } = useLocation();
  return <output data-testid="where">{pathname + search}</output>;
}

const routes = (
  <>
    <Routes>
      <Route path="/p/:projectKey/map" element={<MapPage />}>
        <Route index element={<MapOverview />} />
        <Route path=":groupKey" element={<MapGroupView />}>
          <Route path="tasks/:taskKey/*" element={<TaskDrawer />} />
        </Route>
      </Route>
    </Routes>
    <Where />
  </>
);

const where = () => screen.getByTestId('where').textContent;

function card(key: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-card-key="${key}"]`);
  if (!element) throw new Error(`no card ${key} on the map`);
  return element;
}
const cardLink = (key: string) => within(card(key)).getAllByRole('link')[0]!;
const columnOf = (key: string) => card(key).closest('ul')?.getAttribute('aria-label');
const edges = () =>
  Array.from(document.querySelectorAll<SVGPathElement>('[data-edge]')).map(
    (edge) => `${edge.dataset.from}>${edge.dataset.to}`,
  );
const back = () => screen.getByRole('link', { name: new RegExp(t('map.back')) });
const taskDrawer = () => screen.findByRole('complementary', { name: t('task.drawerLabel') });
const themeDrawer = () => screen.findByRole('complementary', { name: t('theme.drawerLabel') });
const heading = (name: string) => screen.findByRole('heading', { level: 1, name });

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

describe('the zoomed group view (PM-407)', () => {
  it('opens by its URL: the theme header, the lane without a collecting card, the cards in their columns', async () => {
    const { project, webshop } = themed();
    project.render(routes, `/p/AC/map/${webshop.key}`);

    await heading('Webshop epic');
    expect(screen.getByText(t('map.kind.theme'))).toBeTruthy();
    expect(screen.getByText(webshop.key)).toBeTruthy();
    expect(screen.getByText(t('map.progress', { done: 0, total: 2 }))).toBeTruthy();
    expect(screen.getByRole('link', { name: t('map.openTheme') }).getAttribute('href')).toBe(
      `/p/AC/map/${webshop.key}/tasks/${webshop.key}`,
    );

    const lane = screen.getByRole('region', { name: new RegExp(t('map.lane.loose')) });
    expect(within(lane).getByText(t('map.laneCount', { open: 2, done: 0 }))).toBeTruthy();
    expect(columnOf('AC-21')).toBe(t('map.columnCount', { column: 'Átnézés', count: 1 }));
    expect(columnOf('AC-17')).toBe(t('map.columnCount', { column: 'Élesítésre vár', count: 1 }));
    // The card names its state, and opens its drawer over the map.
    expect(cardLink('AC-21').getAttribute('href')).toBe(`/p/AC/map/${webshop.key}/tasks/AC-21`);
    expect(within(card('AC-21')).getByText(project.backend.findTask('AC-21')!.title)).toBeTruthy();
  });

  it('gives the focus to "‹ Térkép", which leads back to the overview with the filters and the tile', async () => {
    const { project, webshop } = themed();
    project.render(routes, '/p/AC/map?show=needsYou');

    fireEvent.click(await screen.findByRole('link', { name: new RegExp(`^[^:]+: Webshop epic\\.`) }));
    await heading('Webshop epic');
    await waitFor(() => expect(document.activeElement).toBe(back()));
    expect(where()).toBe(`/p/AC/map/${webshop.key}`);

    fireEvent.click(back());
    await screen.findByRole('list', { name: t('map.groups') });
    expect(where()).toBe('/p/AC/map');
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('href')).toBe(`/p/AC/map/${webshop.key}`),
    );
  });

  it('draws the done count of each lane in the "Kész" column and leaves the done cards out', async () => {
    const { project, backend, webshop } = themed();
    backend.updateTask('AC-16', { themeKey: webshop.key });
    project.render(routes, `/p/AC/map/${webshop.key}`);

    await heading('Webshop epic');
    const lane = screen.getByRole('region', { name: new RegExp(t('map.lane.loose')) });
    expect(within(lane).getByText(t('map.laneCount', { open: 2, done: 1 }))).toBeTruthy();
    expect(within(lane).getByText(t('map.columnCount', { column: t('map.done'), count: 1 }))).toBeTruthy();
    expect(screen.getByText(t('map.progress', { done: 1, total: 3 }))).toBeTruthy();
    expect(document.querySelector('[data-card-key="AC-16"]')).toBeNull();
  });

  it('has a lane per collecting card in a theme, "Részei" in a collecting card and "Csoport nélküli kártyák" in "Egyéb"', async () => {
    const { project, backend, webshop } = themed();
    const collector = create(backend, 'Fizetési csomag', {});
    backend.updateTask('AC-20', { parentKey: collector.key, themeKey: webshop.key });
    backend.updateTask('AC-22', { parentKey: collector.key, themeKey: webshop.key });
    backend.updateTask(collector.key, { themeKey: webshop.key });
    const view = project.render(routes, `/p/AC/map/${webshop.key}`);

    await heading('Webshop epic');
    // The collecting card's own lane is headed by a link to its drawer; the loose cards come after.
    const headed = screen.getByRole('region', { name: new RegExp(collector.key) });
    const laneTitle = within(headed).getByRole('heading', { level: 2 });
    expect(within(laneTitle).getByRole('link').getAttribute('href')).toBe(
      `/p/AC/map/${webshop.key}/tasks/${collector.key}`,
    );
    expect(card('AC-20')).toBeTruthy();
    expect(headed.contains(card('AC-20'))).toBe(true);
    expect(
      screen.getByRole('region', { name: new RegExp(t('map.lane.loose')) }).contains(card('AC-21')),
    ).toBe(true);
    view.unmount();

    const alone = mockProject();
    const own = create(alone.backend, 'Gyűjtő', {});
    alone.backend.updateTask('AC-20', { parentKey: own.key });
    alone.render(routes, `/p/AC/map/${own.key}`);
    await heading('Gyűjtő');
    expect(screen.getByText(t('map.kind.collector'))).toBeTruthy();
    expect(screen.getByRole('link', { name: t('map.openCollector') })).toBeTruthy();
    expect(screen.getByRole('region', { name: t('map.lane.parts') }).contains(card('AC-20'))).toBe(true);
  });

  it('shows "Egyéb" with its lane and no link to open', async () => {
    const { project } = themed();
    project.render(routes, '/p/AC/map/other');

    await heading(t('map.other'));
    expect(screen.getByText(t('map.kind.other'))).toBeTruthy();
    expect(screen.getByRole('region', { name: t('map.lane.other') })).toBeTruthy();
    expect(screen.queryByRole('link', { name: t('map.openTheme') })).toBeNull();
    expect(screen.queryByRole('link', { name: t('map.openCollector') })).toBeNull();
  });

  describe('the arrows and the "Vár erre" rows', () => {
    it('draws one arrow from the prerequisite to the waiting card, and says it in a hidden text', async () => {
      const { project, backend, webshop } = themed();
      needs(backend, 'AC-21', 'AC-17');
      project.render(routes, `/p/AC/map/${webshop.key}`);

      await heading('Webshop epic');
      await waitFor(() => expect(edges()).toEqual(['AC-17>AC-21']));
      const layer = document.querySelector('[data-edge-layer]');
      expect(layer?.getAttribute('aria-hidden')).toBe('true');
      expect(within(card('AC-21')).getByText(t('map.waitsFor', { keys: 'AC-17' })).className).toContain(
        'visually-hidden',
      );
      // Nothing to read twice: no row, no key to click, for a prerequisite the arrow shows.
      expect(within(card('AC-21')).queryByRole('button')).toBeNull();
      expect(card('AC-21').querySelector('p')).toBeNull();
    });

    it('draws no arrow for a closed prerequisite and no row either', async () => {
      const { project, backend, webshop } = themed();
      needs(backend, 'AC-21', 'AC-16');
      project.render(routes, `/p/AC/map/${webshop.key}`);

      await heading('Webshop epic');
      expect(edges()).toEqual([]);
      expect(card('AC-21').querySelector('p')).toBeNull();
    });

    it('draws no arrow to a prerequisite in another group; a row names it and its group instead', async () => {
      const { project, backend, webshop } = themed();
      needs(backend, 'AC-21', 'AC-18');
      project.render(routes, `/p/AC/map/${webshop.key}`);

      await heading('Webshop epic');
      expect(edges()).toEqual([]);
      const row = card('AC-21').querySelector('p');
      expect(row?.textContent).toContain(t('map.waitsFor', { keys: 'AC-18' }));
      expect(row?.textContent).toContain(t('map.otherGroup'));
      expect(within(card('AC-21')).getByRole('link', { name: 'AC-18' }).getAttribute('href')).toBe(
        `/p/AC/map/${webshop.key}/tasks/AC-18`,
      );
    });

    it('does not repeat the prerequisite the state label already names', async () => {
      const { project, backend, webshop } = themed();
      backend.updateTask('AC-24', { themeKey: webshop.key });
      needs(backend, 'AC-24', 'AC-17');
      needs(backend, 'AC-24', 'AC-18');
      project.render(routes, `/p/AC/map/${webshop.key}`);

      await heading('Webshop epic');
      const waiting = card('AC-24');
      expect(waiting.textContent).toContain('AC-17 +1');
      // AC-17 is the one the label names, and it is on the map: arrow only. AC-18 is the row's.
      await waitFor(() => expect(edges()).toEqual(['AC-17>AC-24']));
      expect(waiting.querySelector('p')?.textContent).toContain('AC-18');
      expect(waiting.querySelector('p')?.textContent).not.toContain('AC-17');
      expect(within(waiting).queryByText(t('map.waitsFor', { keys: 'AC-17' }))).toBeNull();
    });
  });

  describe('the card drawer over the map', () => {
    it('opens on a click and closes back to the zoom with the filter query, the focus on the card', async () => {
      const { project, webshop } = themed();
      project.render(routes, `/p/AC/map/${webshop.key}?show=needsYou`);
      await heading('Webshop epic');

      fireEvent.click(cardLink('AC-21'));
      const dialog = await taskDrawer();
      expect(where()).toBe(`/p/AC/map/${webshop.key}/tasks/AC-21?show=needsYou`);
      // The map stays under the drawer.
      expect(screen.getByRole('heading', { level: 1, name: 'Webshop epic' })).toBeTruthy();

      fireEvent.click(within(dialog).getByRole('button', { name: t('common.close') }));
      await waitFor(() =>
        expect(screen.queryByRole('complementary', { name: t('task.drawerLabel') })).toBeNull(),
      );
      expect(where()).toBe(`/p/AC/map/${webshop.key}?show=needsYou`);
      await waitFor(() => expect(document.activeElement).toBe(cardLink('AC-21')));
    });

    it('closes on Escape to the zoom, and its card links stay on the map', async () => {
      const { project, backend, webshop } = themed();
      needs(backend, 'AC-21', 'AC-17');
      project.render(routes, `/p/AC/map/${webshop.key}/tasks/AC-21`);

      const dialog = await taskDrawer();
      await heading('Webshop epic');
      // Opened with the page, the drawer keeps the focus: "‹ Térkép" does not take it.
      expect(document.activeElement).not.toBe(back());
      const relation = await within(dialog).findByRole('link', {
        name: new RegExp(backend.findTask('AC-17')!.title),
      });
      expect(relation.getAttribute('href')).toBe(`/p/AC/map/${webshop.key}/tasks/AC-17`);

      fireEvent.keyDown(document, { key: 'Escape' });
      await waitFor(() => expect(where()).toBe(`/p/AC/map/${webshop.key}`));
    });

    it('opens the theme card in the drawer from the header', async () => {
      const { project, webshop } = themed();
      project.render(routes, `/p/AC/map/${webshop.key}`);
      await heading('Webshop epic');

      fireEvent.click(screen.getByRole('link', { name: t('map.openTheme') }));
      await themeDrawer();
      expect(where()).toBe(`/p/AC/map/${webshop.key}/tasks/${webshop.key}`);
    });

    it("offers the theme's own zoom from the theme drawer on the board", async () => {
      const { project, webshop } = themed();
      project.render(routes, `/p/AC/map/${webshop.key}/tasks/${webshop.key}`);

      const dialog = await themeDrawer();
      const open = await within(dialog).findByRole('link', { name: t('theme.openOnMap') });
      expect(open.getAttribute('href')).toBe(`/p/AC/map/${webshop.key}`);
    });
  });

  describe('a group that is not there, and the quiet states', () => {
    it('says the group is not found, whatever the key, and leads back with the filters', async () => {
      const { project } = themed();
      project.render(routes, '/p/AC/map/AC-9999?show=blocked');

      expect(
        await screen.findByRole('heading', { level: 1, name: t('map.group.notFound.title') }),
      ).toBeTruthy();
      const link = screen.getByRole('link', { name: t('map.group.notFound.back') });
      expect(link.getAttribute('href')).toBe('/p/AC/map?show=blocked');
    });

    it('does not call a group missing because a filter hides every card of it', async () => {
      const { project, webshop } = themed();
      project.render(routes, `/p/AC/map/${webshop.key}?show=blocked`);

      expect(
        await screen.findByRole('heading', { level: 2, name: t('map.group.emptyFilter.blocked') }),
      ).toBeTruthy();
      expect(screen.getByRole('heading', { level: 1, name: 'Webshop epic' })).toBeTruthy();
      expect(screen.queryByText(t('map.group.notFound.title'))).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: t('map.clearFilters') }));
      await waitFor(() => expect(where()).toBe(`/p/AC/map/${webshop.key}`));
      await waitFor(() => expect(document.querySelector('[data-card-key="AC-21"]')).toBeTruthy());
    });

    it('says "Minden kész" for a group with nothing open and "nincs kártya" for one with none at all', async () => {
      const { project, backend } = themed();
      const finished = create(backend, 'Kész epic', { kind: 'theme' });
      backend.updateTask('AC-16', { themeKey: finished.key });
      const empty = create(backend, 'Üres epic', { kind: 'theme' });
      const view = project.render(routes, `/p/AC/map/${finished.key}`);

      expect(await screen.findByRole('heading', { level: 2, name: t('map.group.allDone') })).toBeTruthy();
      view.unmount();

      project.render(routes, `/p/AC/map/${empty.key}`);
      expect(await screen.findByRole('heading', { level: 2, name: t('map.group.noCards') })).toBeTruthy();
    });

    it('shows a busy skeleton of eight cards while the board loads', () => {
      const { project, webshop } = themed();
      project.render(routes, `/p/AC/map/${webshop.key}`);

      const busy = document.querySelector('[aria-busy="true"]');
      expect(busy).toBeTruthy();
      expect(busy?.querySelectorAll('li')).toHaveLength(8);
      // "‹ Térkép" is there at once.
      expect(back()).toBeTruthy();
    });

    it('shows the error state with a retry', async () => {
      const { project, webshop } = themed();
      let failing = true;
      const answer = createMockFetch(project.backend);
      setFetchImplementation(async (input, init) =>
        failing && String(input).includes('/board')
          ? new Response(JSON.stringify({ error: { code: 'boom', message: 'Boom' } }), {
              status: 500,
              headers: { 'content-type': 'application/json' },
            })
          : answer(String(input), init),
      );
      project.render(routes, `/p/AC/map/${webshop.key}`);

      const alert = await screen.findByRole('alert');
      failing = false;
      fireEvent.click(within(alert).getByRole('button', { name: t('app.retry') }));
      await heading('Webshop epic');
    });
  });

  describe('on a phone', () => {
    it('lists the cards by lane without arrows, with the column beside the key', async () => {
      phone();
      const { project, backend, webshop } = themed();
      needs(backend, 'AC-21', 'AC-17');
      project.render(routes, `/p/AC/map/${webshop.key}`);

      await heading('Webshop epic');
      await waitFor(() => expect(document.querySelector('[data-card-key="AC-21"]')).toBeTruthy());
      expect(document.querySelector('[data-edge-layer]')).toBeNull();
      expect(edges()).toEqual([]);
      const list = screen.getByRole('list', { name: t('map.cards') });
      expect(list.contains(card('AC-21'))).toBe(true);
      expect(within(card('AC-21')).getByText('Átnézés')).toBeTruthy();
      expect(within(card('AC-17')).getByText('Élesítésre vár')).toBeTruthy();
    });

    it('turns the arrow into a "Vár erre" row: a key on the map scrolls to the card, one off the map opens the drawer', async () => {
      phone();
      const { project, backend, webshop } = themed();
      needs(backend, 'AC-21', 'AC-17');
      needs(backend, 'AC-21', 'AC-18');
      project.render(routes, `/p/AC/map/${webshop.key}`);

      await heading('Webshop epic');
      await waitFor(() => expect(document.querySelector('[data-card-key="AC-21"]')).toBeTruthy());
      const row = card('AC-21').querySelector('p');
      expect(row?.textContent).toContain('AC-17');
      expect(row?.textContent).toContain(`AC-18 ${t('map.otherGroup')}`);

      fireEvent.click(within(card('AC-21')).getByRole('button', { name: 'AC-17' }));
      expect(document.activeElement).toBe(cardLink('AC-17'));

      fireEvent.click(within(card('AC-21')).getByRole('link', { name: 'AC-18' }));
      await taskDrawer();
      expect(where()).toBe(`/p/AC/map/${webshop.key}/tasks/AC-18`);
    });
  });
});
