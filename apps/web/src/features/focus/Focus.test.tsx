import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Task } from '@projectman/shared';
import type { ProjectFocusItem } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import type { MockBackend } from '../../mocks/backend';
import { withoutTeamStrip } from '../../test/boardCards';
import { mockProject } from '../../test/mockProject';
import { BoardPage } from '../board/BoardPage';
import { TaskDrawer } from '../board/TaskDrawer';
import { MapGroupView } from '../map/MapGroupView';
import { MapOverview } from '../map/MapOverview';
import { MapPage } from '../map/MapPage';
import { FocusProvider } from './FocusContext';

afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

const base = '/api/projects/AC/tasks';
const create = (backend: MockBackend, title: string, extra: object = {}) =>
  Task.parse(backend.handle('POST', base, { title, ...extra }).body);
const entry = (key: string): ProjectFocusItem => ({
  key,
  addedAt: '2026-10-01T10:00:00.000Z',
  addedBy: { kind: 'human', handle: 'owner' },
});
const titleOf = (backend: MockBackend, key: string) => backend.findTask(key)!.title;

/** A project whose focus holds `keys`, in that order. */
function focused(...keys: string[]) {
  const project = mockProject();
  project.backend.focusItems = keys.map(entry);
  return project;
}

type Project = ReturnType<typeof mockProject>;
type Overrides = Parameters<Project['render']>[2];

const inFocus = (ui: ReactElement) => <FocusProvider>{ui}</FocusProvider>;
const renderBoard = (project: Project, route = '/', overrides: Overrides = {}) =>
  project.render(inFocus(<BoardPage />), route, overrides);

/** The same project seen by a client: nothing of the focus may reach the page. */
function asClient(project: Project): NonNullable<Overrides> {
  return {
    me: {
      ...project.context.me,
      projects: project.context.me.projects.map((entry) => ({ ...entry, access: 'client' as const })),
    },
  };
}

const keyOf = (link: HTMLElement) => /(AC-\d+)/.exec(link.getAttribute('href') ?? '')?.[1] ?? '';
const strip = () => screen.queryByRole('region', { name: t('focus.title') });
const findStrip = () => screen.findByRole('region', { name: t('focus.title') });
/** The cards of the board, not the chips of the strip. */
const boardKeys = () =>
  withoutTeamStrip(screen.queryAllByRole('link'))
    .filter((link) => !strip()?.contains(link))
    .map(keyOf)
    .filter((key) => key !== '');
const chips = () => within(screen.getByRole('list', { name: t('focus.chipsLabel') })).getAllByRole('link');
const requests = (project: Project, method: string) =>
  project.requests.filter((request) => request.method === method && request.path.includes('/focus/'));
const focusReads = (project: Project) =>
  project.requests.filter((request) => request.method === 'GET' && /\/focus(\?|$)/.test(request.path));

async function openPanel() {
  fireEvent.click(await screen.findByRole('button', { name: /^Fókusz megnyitása/ }));
  const dialog = await screen.findByRole('dialog');
  return within(dialog);
}
const rows = (panel: ReturnType<typeof within>) =>
  within(panel.getByRole('list', { name: t('focus.listLabel') })).getAllByRole('listitem');
const rowKeys = (panel: ReturnType<typeof within>) =>
  rows(panel).map((row) => /AC-\d+/.exec(row.textContent ?? '')?.[0] ?? '');

describe('the focus strip', () => {
  it('lists the items in order and keeps the board whole until the filter is on', async () => {
    const project = focused('AC-24', 'AC-23');
    renderBoard(project);
    await findStrip();
    await waitFor(() => expect(chips()).toHaveLength(2));
    expect(chips()[0]!.textContent).toContain(titleOf(project.backend, 'AC-24'));
    expect(chips()[0]!.textContent).toContain('1');
    expect(chips()[1]!.textContent).toContain(titleOf(project.backend, 'AC-23'));
    expect(boardKeys().length).toBeGreaterThan(2);
  });

  it('narrows the board to the focus and back with "Csak a fókusz"', async () => {
    const project = focused('AC-24', 'AC-23');
    renderBoard(project);
    await findStrip();
    const toggle = await screen.findByRole('button', { name: t('focus.only') });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    await waitFor(() => expect(boardKeys().sort()).toEqual(['AC-23', 'AC-24']));
    expect(screen.getByRole('button', { name: t('focus.only') }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: t('focus.only') }));
    await waitFor(() => expect(boardKeys().length).toBeGreaterThan(2));
  });

  it('opens already narrowed on ?focus=1', async () => {
    const project = focused('AC-24');
    renderBoard(project, '/?focus=1');
    await waitFor(() => expect(boardKeys()).toEqual(['AC-24']));
  });

  it('does not empty the board while the list is unknown or could not be read', async () => {
    const project = focused('AC-24');
    project.backend.focusLoadFails = true;
    renderBoard(project, '/?focus=1');
    expect(await screen.findByText(t('focus.loadFailed'))).toBeTruthy();
    expect(boardKeys().length).toBeGreaterThan(1);
    project.backend.focusLoadFails = false;
    fireEvent.click(screen.getByRole('button', { name: t('focus.retry') }));
    await waitFor(() => expect(chips()).toHaveLength(1));
    await waitFor(() => expect(boardKeys()).toEqual(['AC-24']));
  });

  it('offers to set the focus up when it is empty and the viewer may change it', async () => {
    renderBoard(focused());
    expect(await screen.findByText(t('focus.empty'))).toBeTruthy();
    expect(screen.getByRole('button', { name: t('focus.setUp') })).toBeTruthy();
  });

  it('shows an empty focus to a viewer who may not change it as no strip at all', async () => {
    const project = focused();
    project.backend.viewerHandle = 'qa';
    renderBoard(project);
    await waitFor(() => expect(focusReads(project)).toHaveLength(1));
    await waitFor(() => expect(boardKeys().length).toBeGreaterThan(1));
    expect(strip()).toBeNull();
  });

  it('lets a viewer without the right read the list: "Részletek", no editing', async () => {
    const project = focused('AC-24');
    project.backend.viewerHandle = 'qa';
    renderBoard(project);
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(screen.getByRole('button', { name: t('focus.details') })).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('focus.edit') })).toBeNull();
  });

  it('shows a key for an item the board does not know', async () => {
    const project = focused('AC-999');
    renderBoard(project);
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(chips()[0]!.textContent).toContain('AC-999');
    expect(chips()[0]!.getAttribute('href')).toContain('AC-999');
  });
});

describe('a client', () => {
  it('asks for no focus, sees no strip, and a ?focus=1 in the address does not empty the board', async () => {
    const project = focused('AC-24');
    renderBoard(project, '/?focus=1', asClient(project));
    await waitFor(() => expect(boardKeys().length).toBeGreaterThan(1));
    expect(strip()).toBeNull();
    expect(focusReads(project)).toHaveLength(0);
    expect(screen.queryByRole('button', { name: t('focus.only') })).toBeNull();
    expect(screen.queryByRole('img', { name: /^Fókusz, / })).toBeNull();
  });
});

describe('the focus panel', () => {
  it('lists the items with their places and moves one down with the button', async () => {
    const project = focused('AC-24', 'AC-23', 'AC-22');
    renderBoard(project);
    const panel = await openPanel();
    await waitFor(() => expect(rowKeys(panel)).toEqual(['AC-24', 'AC-23', 'AC-22']));
    fireEvent.click(
      panel.getByRole('button', { name: t('focus.moveDown', { title: titleOf(project.backend, 'AC-24') }) }),
    );
    await waitFor(() => expect(rowKeys(panel)).toEqual(['AC-23', 'AC-24', 'AC-22']));
    await waitFor(() => expect(requests(project, 'PATCH')).toHaveLength(1));
    expect(requests(project, 'PATCH')[0]).toMatchObject({
      path: expect.stringContaining('/focus/items/AC-24'),
      body: { position: 2 },
    });
    expect(project.backend.focusItems.map((item) => item.key)).toEqual(['AC-23', 'AC-24', 'AC-22']);
  });

  it('moves one up, and has nothing to move above the first or below the last', async () => {
    const project = focused('AC-24', 'AC-23');
    renderBoard(project);
    const panel = await openPanel();
    await waitFor(() => expect(rows(panel)).toHaveLength(2));
    const up = (key: string) =>
      panel.getByRole('button', { name: t('focus.moveUp', { title: titleOf(project.backend, key) }) });
    const down = (key: string) =>
      panel.getByRole('button', { name: t('focus.moveDown', { title: titleOf(project.backend, key) }) });
    expect((up('AC-24') as HTMLButtonElement).disabled).toBe(true);
    expect((down('AC-23') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(up('AC-23'));
    await waitFor(() => expect(rowKeys(panel)).toEqual(['AC-23', 'AC-24']));
  });

  it('takes an item off and puts it back at its old place with "Visszavonás"', async () => {
    const project = focused('AC-24', 'AC-23', 'AC-22');
    renderBoard(project);
    const panel = await openPanel();
    await waitFor(() => expect(rows(panel)).toHaveLength(3));
    const title = titleOf(project.backend, 'AC-23');
    fireEvent.click(panel.getByRole('button', { name: t('focus.remove', { title }) }));
    await waitFor(() => expect(rowKeys(panel)).toEqual(['AC-24', 'AC-22']));
    expect(await panel.findByText(t('focus.removed', { title }))).toBeTruthy();
    expect(requests(project, 'DELETE')).toHaveLength(1);

    fireEvent.click(panel.getByRole('button', { name: t('focus.undo') }));
    await waitFor(() => expect(rowKeys(panel)).toEqual(['AC-24', 'AC-23', 'AC-22']));
    const posts = requests(project, 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({ key: 'AC-23', position: 2 });
    expect(project.backend.focusItems.map((item) => item.key)).toEqual(['AC-24', 'AC-23', 'AC-22']);
  });

  it('adds a card found by its title', async () => {
    const project = focused('AC-24');
    renderBoard(project);
    const panel = await openPanel();
    await waitFor(() => expect(rows(panel)).toHaveLength(1));
    const search = panel.getByRole('combobox', { name: t('focus.addLabel') });
    fireEvent.change(search, { target: { value: 'AC-23' } });
    fireEvent.click(await panel.findByRole('option', { name: new RegExp('AC-23') }));
    await waitFor(() => expect(rowKeys(panel)).toEqual(['AC-24', 'AC-23']));
    expect(requests(project, 'POST')[0]!.body).toEqual({ key: 'AC-23' });
  });

  it('shows what is in the list in the search, but does not offer it again', async () => {
    const project = focused('AC-24');
    renderBoard(project);
    const panel = await openPanel();
    await waitFor(() => expect(rows(panel)).toHaveLength(1));
    fireEvent.change(panel.getByRole('combobox', { name: t('focus.addLabel') }), {
      target: { value: 'AC-24' },
    });
    const option = await panel.findByRole('option', { name: new RegExp('AC-24') });
    expect(option.getAttribute('aria-disabled')).toBe('true');
    expect(option.textContent).toContain(t('focus.alreadyIn', { position: 1 }));
    fireEvent.click(option);
    expect(requests(project, 'POST')).toHaveLength(0);
  });

  it('says so when nothing matches', async () => {
    renderBoard(focused('AC-24'));
    const panel = await openPanel();
    fireEvent.change(await panel.findByRole('combobox', { name: t('focus.addLabel') }), {
      target: { value: 'no such card anywhere' },
    });
    expect(await panel.findByText(t('focus.noMatches'))).toBeTruthy();
  });

  it('puts the list back and shows the error at the top when a save is refused', async () => {
    const project = focused('AC-24', 'AC-23');
    project.backend.focusSaveError = { status: 409, code: 'focus_item_unknown' };
    renderBoard(project);
    const panel = await openPanel();
    await waitFor(() => expect(rows(panel)).toHaveLength(2));
    fireEvent.click(
      panel.getByRole('button', { name: t('focus.remove', { title: titleOf(project.backend, 'AC-24') }) }),
    );
    const banner = await panel.findByRole('alert');
    expect(banner.textContent).toContain(t('focus.saveFailed'));
    expect(banner.textContent).toContain(t('errors.codes.focus_item_unknown'));
    expect(rowKeys(panel)).toEqual(['AC-24', 'AC-23']);
    expect(project.backend.focusItems).toHaveLength(2);
  });

  it('is a read-only list for a viewer who may not change it', async () => {
    const project = focused('AC-24');
    project.backend.viewerHandle = 'qa';
    renderBoard(project);
    const panel = await openPanel();
    await waitFor(() => expect(rows(panel)).toHaveLength(1));
    expect(panel.getByText(t('focus.viewerNote'))).toBeTruthy();
    expect(panel.queryByRole('combobox')).toBeNull();
    expect(panel.queryByRole('button', { name: /^Levétel a fókuszból/ })).toBeNull();
    expect(panel.queryByRole('button', { name: /^Feljebb/ })).toBeNull();
  });

  it('turns the search off with the "full" text at 20 items', async () => {
    const project = mockProject();
    const keys = Array.from({ length: 20 }, (_, index) => create(project.backend, `Card ${index}`).key);
    project.backend.focusItems = keys.map(entry);
    renderBoard(project);
    const panel = await openPanel();
    await waitFor(() => expect(rows(panel)).toHaveLength(20));
    expect((panel.getByRole('textbox', { name: t('focus.addLabel') }) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(panel.getByText(t('errors.codes.focus_full'))).toBeTruthy();
  });

  it('lists the changes, newest first, with their texts', async () => {
    const project = focused('AC-24');
    renderBoard(project);
    const panel = await openPanel();
    await waitFor(() => expect(rows(panel)).toHaveLength(1));
    fireEvent.change(panel.getByRole('combobox', { name: t('focus.addLabel') }), {
      target: { value: 'AC-23' },
    });
    fireEvent.click(await panel.findByRole('option', { name: new RegExp('AC-23') }));
    const added = t('timeline.events.focus_added', {
      title: titleOf(project.backend, 'AC-23'),
      position: '2',
    });
    expect(await panel.findByText((content) => content.includes(added))).toBeTruthy();
  });

  it('says there is nothing to list before anything changed', async () => {
    renderBoard(focused('AC-24'));
    const panel = await openPanel();
    expect(await panel.findByText(t('focus.changesEmpty'))).toBeTruthy();
  });
});

describe('the marks', () => {
  it('names the theme a card is in the focus through, and marks the theme itself', async () => {
    const project = mockProject();
    const { backend } = project;
    const theme = create(backend, 'Webshop epic', { kind: 'theme' });
    backend.updateTask('AC-24', { themeKey: theme.key });
    backend.focusItems = [entry('AC-23'), entry(theme.key)];
    renderBoard(project);
    await waitFor(() => expect(boardKeys()).toContain('AC-24'));
    const viaTheme = t('focus.markViaTheme', { position: 2, title: 'Webshop epic' });
    await waitFor(() => expect(screen.getAllByRole('img', { name: viaTheme }).length).toBeGreaterThan(0));
    expect(screen.getAllByRole('img', { name: t('focus.mark', { position: 1 }) }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('img', { name: t('focus.mark', { position: 2 }) }).length).toBeGreaterThan(0);
  });

  it('names the card a subtask is in the focus through', async () => {
    const project = mockProject();
    const { backend } = project;
    const collector = create(backend, 'Collector card');
    create(backend, 'Open subtask', { parentKey: collector.key });
    backend.focusItems = [entry(collector.key)];
    renderBoard(project);
    const viaCard = t('focus.markViaCard', { position: 1, key: collector.key });
    await waitFor(() => expect(screen.getAllByRole('img', { name: viaCard }).length).toBeGreaterThan(0));
  });

  it('marks nothing when the focus is empty', async () => {
    renderBoard(focused());
    await waitFor(() => expect(boardKeys().length).toBeGreaterThan(1));
    expect(screen.queryByRole('img', { name: /^Fókusz, / })).toBeNull();
  });
});

describe('the "Fókusz" row of a card', () => {
  const routes = inFocus(
    <Routes>
      <Route path="/p/:key/tasks/:taskKey" element={<TaskDrawer />} />
    </Routes>,
  );
  const row = async () => (await screen.findByText(t('focus.row.label'))).parentElement!;

  it('puts the card in the focus and takes it off again', async () => {
    const project = focused('AC-23');
    project.render(routes, '/p/AC/tasks/AC-24');
    const none = await screen.findByText(t('focus.row.none'));
    expect(none).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('focus.row.add') }));
    expect(await screen.findByText(t('focus.row.place', { position: 2 }))).toBeTruthy();
    expect(project.backend.focusItems.map((item) => item.key)).toEqual(['AC-23', 'AC-24']);

    fireEvent.click(await screen.findByRole('button', { name: t('focus.row.remove') }));
    await screen.findByText(t('focus.row.none'));
    expect(project.backend.focusItems.map((item) => item.key)).toEqual(['AC-23']);
  });

  it('names the theme the card is in the focus through', async () => {
    const project = mockProject();
    const { backend } = project;
    const theme = create(backend, 'Webshop epic', { kind: 'theme' });
    backend.updateTask('AC-24', { themeKey: theme.key });
    backend.focusItems = [entry(theme.key)];
    project.render(routes, '/p/AC/tasks/AC-24');
    expect(
      await screen.findByText((content) =>
        content.includes(t('focus.row.viaTheme', { position: 1, title: 'Webshop epic' })),
      ),
    ).toBeTruthy();
    // A card that is only covered has nothing to take off.
    expect(screen.queryByRole('button', { name: t('focus.row.remove') })).toBeNull();
  });

  it('shows a refusal in the drawer and leaves the row as it was', async () => {
    const project = focused();
    project.backend.focusSaveError = { status: 409, code: 'focus_full' };
    project.render(routes, '/p/AC/tasks/AC-24');
    fireEvent.click(await screen.findByRole('button', { name: t('focus.row.add') }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(t('errors.codes.focus_full'));
    expect(screen.getByText(t('focus.row.none'))).toBeTruthy();
    expect((await row()).textContent).toContain(t('focus.row.add'));
  });

  it('disables the button with the "full" text at 20 items', async () => {
    const project = mockProject();
    project.backend.focusItems = Array.from({ length: 20 }, (_, index) =>
      entry(create(project.backend, `Card ${index}`).key),
    );
    project.render(routes, '/p/AC/tasks/AC-24');
    const button = (await screen.findByRole('button', { name: t('focus.row.add') })) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(true));
    expect(button.title).toBe(t('errors.codes.focus_full'));
  });

  it('shows the place only to a viewer who may not change it, and nothing for a card outside', async () => {
    const project = focused('AC-24');
    project.backend.viewerHandle = 'qa';
    project.render(routes, '/p/AC/tasks/AC-24');
    expect(await screen.findByText(t('focus.row.place', { position: 1 }))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('focus.row.remove') })).toBeNull();
  });

  it('has no row for a card outside the focus when the viewer may not change it', async () => {
    const project = focused('AC-24');
    project.backend.viewerHandle = 'qa';
    project.render(routes, '/p/AC/tasks/AC-23');
    await waitFor(() => expect(focusReads(project)).toHaveLength(1));
    await screen.findAllByText(titleOf(project.backend, 'AC-23'));
    expect(screen.queryByText(t('focus.row.label'))).toBeNull();
  });

  it('has no row for a client', async () => {
    const project = focused('AC-24');
    project.render(routes, '/p/AC/tasks/AC-24', asClient(project));
    await screen.findAllByText(titleOf(project.backend, 'AC-24'));
    expect(screen.queryByText(t('focus.row.label'))).toBeNull();
    expect(focusReads(project)).toHaveLength(0);
  });
});

describe('the focus on the map', () => {
  const routes = inFocus(
    <Routes>
      <Route path="/p/:projectKey/map" element={<MapPage />}>
        <Route index element={<MapOverview />} />
        <Route path=":groupKey" element={<MapGroupView />} />
      </Route>
    </Routes>,
  );
  const tiles = () => screen.queryAllByRole('link', { name: /^[^:]+: .*\./ });

  function themedMap() {
    const project = mockProject();
    const { backend } = project;
    const webshop = create(backend, 'Webshop epic', { kind: 'theme' });
    const hosting = create(backend, 'Hosting epic', { kind: 'theme' });
    backend.updateTask('AC-21', { themeKey: webshop.key });
    backend.updateTask('AC-18', { themeKey: hosting.key });
    backend.focusItems = [entry(webshop.key)];
    return { project, webshop, hosting };
  }

  it('shows the strip and narrows the groups to the focus on ?focus=1', async () => {
    const { project } = themedMap();
    project.render(routes, '/p/AC/map?focus=1');
    await findStrip();
    await waitFor(() => expect(tiles().length).toBeGreaterThan(0));
    const names = tiles().map((tile) => tile.getAttribute('aria-label') ?? '');
    expect(names.some((name) => name.includes('Webshop epic'))).toBe(true);
    expect(names.some((name) => name.includes('Hosting epic'))).toBe(false);
  });

  it('shows every group without the filter', async () => {
    const { project } = themedMap();
    project.render(routes, '/p/AC/map');
    await findStrip();
    await waitFor(() => {
      const names = tiles().map((tile) => tile.getAttribute('aria-label') ?? '');
      expect(names.some((name) => name.includes('Webshop epic'))).toBe(true);
      expect(names.some((name) => name.includes('Hosting epic'))).toBe(true);
    });
  });

  it('marks the theme in a group and the cards it covers', async () => {
    const { project, webshop } = themedMap();
    project.render(routes, `/p/AC/map/${webshop.key}`);
    await waitFor(() =>
      expect(screen.getAllByRole('img', { name: t('focus.mark', { position: 1 }) }).length).toBeGreaterThan(
        0,
      ),
    );
    const viaTheme = t('focus.markViaTheme', { position: 1, title: 'Webshop epic' });
    await waitFor(() => expect(screen.getAllByRole('img', { name: viaTheme }).length).toBeGreaterThan(0));
  });

  it('turns the filter on and off from the strip and writes it to the address', async () => {
    const { project } = themedMap();
    project.render(routes, '/p/AC/map');
    const toggle = await screen.findByRole('button', { name: t('focus.only') });
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: t('focus.only') }).getAttribute('aria-pressed')).toBe('true'),
    );
    await waitFor(() => {
      const names = tiles().map((tile) => tile.getAttribute('aria-label') ?? '');
      expect(names.some((name) => name.includes('Hosting epic'))).toBe(false);
    });
  });

  it('shows a client every group, whatever the address says', async () => {
    const { project } = themedMap();
    project.render(routes, '/p/AC/map?focus=1', asClient(project));
    await waitFor(() => {
      const names = tiles().map((tile) => tile.getAttribute('aria-label') ?? '');
      expect(names.some((name) => name.includes('Hosting epic'))).toBe(true);
    });
    expect(strip()).toBeNull();
    expect(focusReads(project)).toHaveLength(0);
  });
});
