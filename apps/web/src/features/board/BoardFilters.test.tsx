import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { withoutTeamStrip } from '../../test/boardCards';
import { mockProject } from '../../test/mockProject';
import { BoardPage } from './BoardPage';

afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
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

const keyOf = (link: HTMLElement) => /(AC-\d+)/.exec(link.getAttribute('href') ?? '')?.[1] ?? '';

/** The keys of the cards on the board, in the order they are on the page. */
function cardKeys(): string[] {
  return withoutTeamStrip(screen.queryAllByRole('link'))
    .map(keyOf)
    .filter((key) => key !== '');
}

async function renderBoard(
  project: ReturnType<typeof mockProject>,
  overrides: Parameters<ReturnType<typeof mockProject>['render']>[2] = {},
  ui: ReactElement = <BoardPage />,
) {
  const view = project.render(ui, '/', overrides);
  await screen.findByRole('group', { name: t('board.filtersLabel') });
  await waitFor(() => expect(cardKeys().length).toBeGreaterThan(0));
  return view;
}

function cardLink(key: string): HTMLElement {
  const link = withoutTeamStrip(screen.getAllByRole('link')).find((entry) => keyOf(entry) === key);
  if (!link) throw new Error(`no card ${key}`);
  return link;
}

const doneGroup = () => screen.getByRole('region', { name: t('board.groups.done') });
const keysIn = (container: HTMLElement) => within(container).getAllByRole('link').map(keyOf);

describe('the card header', () => {
  it('shows the key and the avatar of the responsible member on the desktop', async () => {
    const project = mockProject();
    await renderBoard(project);
    const card = cardLink('AC-20');
    expect(within(card).getByText('AC-20')).toBeTruthy();
    expect(
      within(card).getByRole('img', { name: t('board.assigneeLabel', { name: 'Backend fejlesztő' }) }),
    ).toBeTruthy();
  });

  it('shows no avatar on a card nobody is responsible for', async () => {
    const project = mockProject();
    await renderBoard(project);
    expect(within(cardLink('AC-24')).queryByRole('img', { name: /^Felelős: / })).toBeNull();
  });

  it('names a responsible member who is gone by the handle, and the viewer as "Te"', async () => {
    const project = mockProject();
    project.backend.updateTask('AC-24', { assignee: 'ghost-1' });
    project.backend.updateTask('AC-23', { assignee: 'owner' });
    await renderBoard(project);
    expect(
      within(cardLink('AC-24')).getByRole('img', { name: t('board.assigneeLabel', { name: 'ghost-1' }) }),
    ).toBeTruthy();
    const mine = within(cardLink('AC-23')).getByRole('img', {
      name: t('board.assigneeLabel', { name: t('common.you') }),
    });
    expect(mine.textContent).toBe(t('common.youInitials'));
  });

  it('shows the key once on the phone, and the column name alone beside the status', async () => {
    phone();
    const project = mockProject();
    await renderBoard(project);
    const card = cardLink('AC-20');
    expect(within(card).getAllByText('AC-20')).toHaveLength(1);
    expect(card.textContent).not.toContain('·');
  });

  it('says "Válaszra vár" once: the status line has it, the chips do not repeat it', async () => {
    const project = mockProject();
    await renderBoard(project);
    const name = project.backend.config.pipeline.labels.find((label) => label.id === 'waiting-answer')!.name;
    expect(within(cardLink('AC-19')).getAllByText(name)).toHaveLength(1);
  });
});

describe('the finished column on the desktop', () => {
  it('shows the newest three, counts them all and opens on request', async () => {
    const project = mockProject();
    await renderBoard(project);
    const done = doneGroup();
    expect(keysIn(done)).toEqual(['AC-16', 'AC-15', 'AC-14']);
    expect(within(done).getByLabelText(t('board.columnCount', { count: 4 }))).toBeTruthy();
    const all = within(done).getByRole('button', { name: t('board.doneAll', { count: 4 }) });
    expect(all.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(all);
    expect(keysIn(done)).toEqual(['AC-16', 'AC-15', 'AC-14', 'AC-13']);
    const fewer = within(done).getByRole('button', { name: t('board.doneFewer') });
    expect(fewer.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(fewer);
    expect(keysIn(done)).toHaveLength(3);
  });

  it('orders by the time of closing, and the newer key first when the times are the same', async () => {
    const project = mockProject();
    const closedAt = '2026-09-20T10:00:00.000Z';
    for (const key of ['AC-13', 'AC-14', 'AC-15']) project.backend.updateTask(key, { closedAt });
    project.backend.updateTask('AC-16', { closedAt: '2026-09-19T10:00:00.000Z' });
    await renderBoard(project);
    fireEvent.click(within(doneGroup()).getByRole('button', { name: t('board.doneAll', { count: 4 }) }));
    expect(keysIn(doneGroup())).toEqual(['AC-15', 'AC-14', 'AC-13', 'AC-16']);
  });

  it('shows no fold while there are three finished cards or fewer', async () => {
    const project = mockProject();
    project.backend.updateTask('AC-13', { stageId: 'dev', status: 'active', closedAt: null });
    await renderBoard(project);
    expect(keysIn(doneGroup())).toHaveLength(3);
    expect(within(doneGroup()).queryByRole('button')).toBeNull();
  });

  it('shows every finished match while searching, with no fold', async () => {
    const project = mockProject();
    await renderBoard(project, { search: 'AC-' });
    expect(keysIn(doneGroup())).toHaveLength(4);
    expect(within(doneGroup()).queryByRole('button')).toBeNull();
  });

  it('counts the finished column after the filters', async () => {
    const project = mockProject();
    await renderBoard(project);
    fireEvent.change(screen.getByLabelText(t('board.filterMember')), { target: { value: 'be-1' } });
    expect(keysIn(doneGroup())).toEqual(['AC-16', 'AC-13']);
    expect(within(doneGroup()).getByLabelText(t('board.columnCount', { count: 2 }))).toBeTruthy();
    expect(within(doneGroup()).queryByRole('button')).toBeNull();
  });
});

describe('the member and label filters on the desktop', () => {
  it('filters by named priority and unset, preserving the card order and describing the filter', async () => {
    const project = mockProject();
    project.backend.updateTask('AC-20', { priority: 'high' });
    await renderBoard(project);
    const before = cardKeys();
    const priority = screen.getByLabelText(t('board.filterPriority'));
    fireEvent.change(priority, { target: { value: 'high' } });
    expect(cardKeys()).toEqual(before.filter((key) => project.backend.findTask(key)!.priority === 'high'));
    expect(
      screen.getByText(new RegExp(t('board.filterPriorityValue', { level: t('priority.levels.high') }))),
    ).toBeTruthy();
    fireEvent.change(priority, { target: { value: '@none' } });
    expect(cardKeys().every((key) => project.backend.findTask(key)!.priority === null)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: t('board.clearFilters') }));
    expect((priority as HTMLSelectElement).value).toBe('');
  });

  it('hides priority on first use, but keeps a selected filter available to clear', async () => {
    const project = mockProject();
    for (const task of project.backend.tasks) project.backend.updateTask(task.key, { priority: null });
    const view = await renderBoard(project);
    expect(screen.queryByLabelText(t('board.filterPriority'))).toBeNull();
    view.unmount();
    project.render(<BoardPage />, '/', {
      boardFilters: { phase: 'all', assignee: '', label: '', priority: 'high' },
    });
    expect(await screen.findByLabelText(t('board.filterPriority'))).toBeTruthy();
  });
  const member = () => screen.getByLabelText(t('board.filterMember')) as HTMLSelectElement;
  const label = () => screen.getByLabelText(t('board.filterLabel')) as HTMLSelectElement;
  const optionLabels = (select: HTMLSelectElement) => [...select.options].map((option) => option.text);

  it('offers "Mind", nobody, yourself, then the other members who are responsible for a card', async () => {
    const project = mockProject();
    project.backend.updateTask('AC-23', { assignee: 'owner' });
    await renderBoard(project);
    const options = optionLabels(member());
    expect(options.slice(0, 3)).toEqual([t('board.filterAny'), t('board.filterNoAssignee'), t('common.you')]);
    expect(options.slice(3).sort()).toEqual([
      'Backend fejlesztő',
      'Frontend fejlesztő',
      'Általános fejlesztő',
    ]);
  });

  it('offers the defined labels in the order of their list, then the plain tags alphabetically', async () => {
    const project = mockProject();
    await renderBoard(project);
    const used = new Set(project.backend.tasks.flatMap((task) => task.labels));
    const defined = project.backend.config.pipeline.labels
      .filter((entry) => used.has(entry.id))
      .map((entry) => entry.name);
    const options = optionLabels(label());
    expect(options.slice(0, 1 + defined.length)).toEqual([t('board.filterAny'), ...defined]);
    const plain = options.slice(1 + defined.length);
    expect(plain).toContain('Új');
    expect(plain).toEqual([...plain].sort((a, b) => a.localeCompare(b)));
  });

  it('shows the cards of one member, and those of nobody', async () => {
    const project = mockProject();
    await renderBoard(project);
    fireEvent.change(member(), { target: { value: 'be-1' } });
    expect(cardKeys().sort()).toEqual(['AC-13', 'AC-16', 'AC-17', 'AC-20', 'AC-25']);
    fireEvent.change(member(), { target: { value: '@none' } });
    expect(cardKeys().sort()).toEqual(['AC-23', 'AC-24']);
  });

  it('filters by a plain tag as by a defined label', async () => {
    const project = mockProject();
    await renderBoard(project);
    fireEvent.change(label(), { target: { value: 'Új' } });
    expect(cardKeys()).toEqual(['AC-24']);
    fireEvent.change(label(), { target: { value: 'qa-ok' } });
    expect(cardKeys().sort()).toEqual(['AC-16', 'AC-17', 'AC-18', 'AC-19', 'AC-27', 'AC-28']);
  });

  it('holds the member, the label, the state and the search at once, and counts by them', async () => {
    const project = mockProject();
    await renderBoard(project);
    fireEvent.change(member(), { target: { value: 'fe-1' } });
    fireEvent.change(label(), { target: { value: 'qa-ok' } });
    expect(cardKeys().sort()).toEqual(['AC-19', 'AC-27', 'AC-28']);
    const states = within(screen.getByRole('group', { name: t('board.filtersLabel') }));
    expect(
      states.getByRole('button', { name: new RegExp(`^${t('board.filters.all')}`) }).textContent,
    ).toContain('3');
    fireEvent.click(states.getByRole('button', { name: new RegExp(t('board.filters.waiting')) }));
    const waiting = cardKeys();
    expect(waiting.length).toBeGreaterThan(0);
    expect(waiting.every((key) => ['AC-19', 'AC-27', 'AC-28'].includes(key))).toBe(true);
    // The search narrows further, still inside the others.
    fireEvent.click(states.getByRole('button', { name: new RegExp(`^${t('board.filters.all')}`) }));
    expect(screen.getAllByText(t('board.columnEmpty')).length).toBeGreaterThan(0);
  });

  it('keeps the search with the filters', async () => {
    const project = mockProject();
    await renderBoard(project, { search: project.backend.findTask('AC-20')!.title });
    expect(cardKeys()).toEqual(['AC-20']);
    fireEvent.change(member(), { target: { value: 'be-1' } });
    expect(cardKeys()).toEqual(['AC-20']);
    fireEvent.change(label(), { target: { value: 'Új' } });
    expect(cardKeys()).toEqual([]);
  });

  it('says so, and offers the way back, when no card is left', async () => {
    const project = mockProject();
    await renderBoard(project);
    fireEvent.change(member(), { target: { value: 'be-1' } });
    fireEvent.change(label(), { target: { value: 'Új' } });
    expect(cardKeys()).toEqual([]);
    const empty = screen.getByText(t('board.filteredEmpty'));
    expect(
      screen.getByText(t('board.subtitleFiltered', { values: 'Backend fejlesztő, Új', count: 0 })),
    ).toBeTruthy();
    const clear = within(empty.parentElement!.parentElement!).getByRole('button', {
      name: t('board.clearFilters'),
    });
    fireEvent.click(clear);
    expect(screen.queryByText(t('board.filteredEmpty'))).toBeNull();
    expect(member().value).toBe('');
    expect(label().value).toBe('');
    expect(cardKeys().length).toBeGreaterThan(10);
  });

  it('shows the clear button only while a filter is set', async () => {
    const project = mockProject();
    await renderBoard(project);
    expect(screen.queryByRole('button', { name: t('board.clearFilters') })).toBeNull();
    fireEvent.change(member(), { target: { value: 'be-1' } });
    fireEvent.click(screen.getByRole('button', { name: t('board.clearFilters') }));
    expect(screen.queryByRole('button', { name: t('board.clearFilters') })).toBeNull();
    expect(member().value).toBe('');
  });

  it('asks the server for nothing when a filter is set', async () => {
    const project = mockProject();
    await renderBoard(project);
    const before = project.requests.length;
    fireEvent.change(member(), { target: { value: 'be-1' } });
    fireEvent.change(label(), { target: { value: 'qa-ok' } });
    expect(project.requests.length).toBe(before);
  });

  it('filters by the member who is responsible, whatever the card is doing', async () => {
    const project = mockProject();
    await renderBoard(project);
    fireEvent.change(member(), { target: { value: 'dev-1' } });
    expect(cardKeys().sort()).toEqual(['AC-15', 'AC-18', 'AC-22']);
  });
});

describe('the filters on the phone', () => {
  it('counts priority, shows a removable chip and filters by unset from the sheet', async () => {
    phone();
    const project = mockProject();
    await renderBoard(project);
    fireEvent.click(screen.getByRole('button', { name: t('board.filterButton') }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(t('board.filterPriority')), { target: { value: 'high' } });
    expect(cardKeys()).toEqual(['AC-24']);
    fireEvent.click(within(dialog).getByRole('button', { name: t('board.filterShow', { count: 1 }) }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: t('board.filterButtonActive', { count: 1 }) })).toBeTruthy();
    const value = t('board.filterPriorityValue', { level: t('priority.levels.high') });
    fireEvent.click(screen.getByRole('button', { name: t('board.filterChipRemove', { value }) }));
    expect(screen.getByRole('button', { name: t('board.filterButton') })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('board.filterButton') }));
    const sheet = await screen.findByRole('dialog');
    fireEvent.change(within(sheet).getByLabelText(t('board.filterPriority')), { target: { value: '@none' } });
    expect(cardKeys().every((key) => project.backend.findTask(key)!.priority === null)).toBe(true);
    fireEvent.click(within(sheet).getByRole('button', { name: t('board.clearFilters') }));
    expect((within(sheet).getByLabelText(t('board.filterPriority')) as HTMLSelectElement).value).toBe('');
  });
  it('puts the member and the label in a sheet behind a button, and shows what is set as chips', async () => {
    phone();
    const project = mockProject();
    await renderBoard(project);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('board.filterButton') }));
    const dialog = await screen.findByRole('dialog', { name: t('board.filterSheetTitle') });
    fireEvent.change(within(dialog).getByLabelText(t('board.filterMember')), { target: { value: 'be-1' } });
    expect(cardKeys().sort()).toEqual(['AC-13', 'AC-16', 'AC-17', 'AC-20', 'AC-25']);
    const show = within(dialog).getByRole('button', { name: t('board.filterShow', { count: 5 }) });
    fireEvent.click(show);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    expect(screen.getByRole('button', { name: t('board.filterButtonActive', { count: 1 }) })).toBeTruthy();
    const chip = screen.getByRole('button', {
      name: t('board.filterChipRemove', { value: 'Backend fejlesztő' }),
    });
    fireEvent.click(chip);
    expect(
      screen.queryByRole('button', { name: t('board.filterChipRemove', { value: 'Backend fejlesztő' }) }),
    ).toBeNull();
    expect(screen.getByRole('button', { name: t('board.filterButton') })).toBeTruthy();
    expect(cardKeys().length).toBeGreaterThan(10);
  });

  it('clears the filters from the sheet', async () => {
    phone();
    const project = mockProject();
    await renderBoard(project);
    fireEvent.click(screen.getByRole('button', { name: t('board.filterButton') }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(t('board.filterLabel')), { target: { value: 'Új' } });
    expect(cardKeys()).toEqual(['AC-24']);
    fireEvent.click(within(dialog).getByRole('button', { name: t('board.clearFilters') }));
    expect(cardKeys().length).toBeGreaterThan(10);
  });

  it('says so when no card is left, with the way back', async () => {
    phone();
    const project = mockProject();
    await renderBoard(project);
    fireEvent.click(screen.getByRole('button', { name: t('board.filterButton') }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(t('board.filterMember')), { target: { value: 'be-1' } });
    fireEvent.change(within(dialog).getByLabelText(t('board.filterLabel')), { target: { value: 'Új' } });
    fireEvent.click(within(dialog).getByRole('button', { name: t('board.filterShow', { count: 0 }) }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const empty = screen.getByText(t('board.filteredEmpty'));
    fireEvent.click(
      within(empty.parentElement!.parentElement!).getByRole('button', { name: t('board.clearFilters') }),
    );
    expect(cardKeys().length).toBeGreaterThan(10);
  });

  it('folds the finished group to the newest three', async () => {
    phone();
    const project = mockProject();
    await renderBoard(project);
    expect(keysIn(doneGroup())).toHaveLength(3);
    expect(within(doneGroup()).getByRole('button', { name: t('board.doneAll', { count: 4 }) })).toBeTruthy();
  });
});
