import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HumanAccess, MemberQueueItem, WorkQueueItem } from '@projectman/shared';
import { applyServerEvent } from '../../api/cache';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { createMockFetch, mockProject } from '../../test/mockProject';
import { integratorItem, minutesAgo, queueItem } from '../../test/workQueueItems';
import { TeamPage } from '../team/TeamPage';

/**
 * Csapat → Munkasorok (PM-1297), against the fake backend: who sees which queues, the filters in the URL, the
 * long-wait mark and the states of the view.
 */
afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

/** The router's location, to assert on the URL the view writes. */
function Probe() {
  const { pathname, search, state } = useLocation();
  return (
    <output data-testid="url" data-state={JSON.stringify(state)}>
      {pathname + search}
    </output>
  );
}
const url = () => screen.getByTestId('url').textContent;

interface Setup {
  viewer?: string;
  access?: HumanAccess;
  route?: string;
  items?: MemberQueueItem[];
  integrator?: WorkQueueItem[];
  state?: unknown;
}

function setup({ viewer = 'owner', access, route = '/p/AC/team?view=queues', ...data }: Setup = {}) {
  const project = mockProject();
  const level = access ?? (viewer === 'owner' ? 'owner' : 'developer');
  project.backend.viewerHandle = viewer;
  project.backend.config.team.members.forEach((member) => {
    if (member.kind === 'human' && member.handle === viewer) member.access = level;
  });
  project.backend.queueItems = data.items ?? [];
  project.backend.integratorQueueItems = data.integrator ?? [];
  const me = {
    ...project.context.me,
    handles: { AC: viewer },
    projects: [{ key: 'AC', name: 'Fictional project', access: level, roles: [] }],
  };
  const ui = project.render(
    <>
      <TeamPage />
      <Probe />
    </>,
    data.state
      ? { pathname: route.split('?')[0]!, search: `?${route.split('?')[1] ?? ''}`, state: data.state }
      : route,
    { me, myHandle: viewer, isOwner: level === 'owner' },
  );
  return { project, ...ui };
}

const group = (name: string) => screen.findByRole('heading', { name });
const select = (name: string) => screen.findByRole('combobox', { name }) as Promise<HTMLSelectElement>;

describe('who sees the work queues', () => {
  it('shows an owner the tabs and every queue, the connected Claude included', async () => {
    setup({
      items: [queueItem({ id: 'a', title: 'Pm dolga' })],
      integrator: [integratorItem({ id: 'i1', title: 'Claude dolga' })],
    });
    const tab = await screen.findByRole('link', { name: t('workQueues.tabs.queues') });
    expect(tab.getAttribute('aria-current')).toBe('page');
    expect(
      screen.getByRole('link', { name: t('workQueues.tabs.members') }).getAttribute('aria-current'),
    ).toBeNull();
    await group(t('workQueues.integrator.name'));
    expect(await screen.findByText('Pm dolga')).toBeTruthy();
    expect(screen.getByText('Claude dolga')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: t('workQueues.queueFilter') })).toBeTruthy();
  });

  it('shows an admin the connected Claude as a header only, outside the counts', async () => {
    setup({
      viewer: 'kata',
      access: 'admin',
      items: [queueItem({ id: 'a' })],
      integrator: [integratorItem({ id: 'i1', title: 'Claude dolga' }), integratorItem({ id: 'i2' })],
    });
    expect(await screen.findByText(t('workQueues.integrator.restricted'))).toBeTruthy();
    expect(screen.queryByText('Claude dolga')).toBeNull();
    const tiles = screen.getByRole('group', { name: t('workQueues.tiles.label') });
    expect(within(tiles).getByText(t('workQueues.tiles.queued')).previousElementSibling?.textContent).toBe(
      '1',
    );
  });

  it('shows a developer only the project manager queue, with no selector', async () => {
    setup({ viewer: 'kata', access: 'developer', items: [] });
    expect(await screen.findByText(t('workQueues.group.pmEmpty'))).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: t('workQueues.queueFilter') })).toBeNull();
    expect(screen.queryByText(t('workQueues.integrator.name'))).toBeNull();
    expect(document.querySelector('summary')?.textContent).toBe(t('workQueues.closed.title'));
  });

  it.each<HumanAccess>(['client', 'viewer'])(
    'gives a %s no tab, and a typed address the forbidden state',
    async (access) => {
      const { project } = setup({ viewer: 'kata', access });
      expect(await screen.findByText(t('workQueues.forbidden'))).toBeTruthy();
      expect(screen.queryByRole('link', { name: t('workQueues.tabs.queues') })).toBeNull();
      expect(project.requests.some((request) => request.path.includes('/work-queues'))).toBe(false);
    },
  );
});

describe('the long-wait mark', () => {
  it('marks a queued item from thirty minutes on, never one still being processed', async () => {
    setup({
      items: [
        queueItem({ id: 'a', title: 'Huszonkilenc', queuedAt: minutesAgo(29) }),
        queueItem({ id: 'b', title: 'Harminc', queuedAt: minutesAgo(30) }),
        queueItem({
          id: 'c',
          title: 'Dolgozik',
          state: 'processing',
          queuedAt: minutesAgo(120),
          startedAt: minutesAgo(1),
        }),
      ],
    });
    await screen.findByText('Harminc');
    const marked = (title: string) =>
      screen.getByText(title).closest('[data-work-queue-item]')?.getAttribute('data-long');
    expect(marked('Harminc')).toBe('true');
    expect(marked('Huszonkilenc')).toBeNull();
    expect(marked('Dolgozik')).toBeNull();
  });

  it('counts the age of an item being processed from its start, with no second "processing" text', async () => {
    setup({
      items: [
        queueItem({
          id: 'c',
          title: 'Dolgozik',
          state: 'processing',
          queuedAt: minutesAgo(120),
          startedAt: minutesAgo(3),
        }),
      ],
    });
    const row = (await screen.findByText('Dolgozik')).closest('li')!;
    expect(within(row).getByText(t('time.minutesAgo', { count: 3 }))).toBeTruthy();
    expect(within(row).getAllByText(t('workQueues.item.processing'))).toHaveLength(1);
  });

  it('filters to the long waits with the checkbox and writes it into the URL', async () => {
    setup({
      items: [
        queueItem({ id: 'a', title: 'Friss' }),
        queueItem({ id: 'b', title: 'Régi', queuedAt: minutesAgo(45) }),
      ],
    });
    fireEvent.click(await screen.findByRole('checkbox', { name: t('workQueues.onlyLong') }));
    await waitFor(() => expect(screen.queryByText('Friss')).toBeNull());
    expect(screen.getByText('Régi')).toBeTruthy();
    expect(url()).toContain('long=1');
  });
});

describe('the filters in the URL', () => {
  it('reads the reason from the URL and writes a changed queue back, keeping the view', async () => {
    setup({
      route: '/p/AC/team?view=queues&reason=human',
      items: [queueItem({ id: 'a', title: 'Ember' }), queueItem({ id: 'b', title: 'Gép', wait: null })],
      integrator: [integratorItem({ id: 'i1' })],
    });
    const reasonSelect = await select(t('workQueues.reasonFilter'));
    expect(reasonSelect.value).toBe('human');
    fireEvent.change(await select(t('workQueues.queueFilter')), { target: { value: 'integrator' } });
    await waitFor(() => expect(url()).toContain('queue=integrator'));
    expect(url()).toContain('view=queues');
    expect(url()).toContain('reason=human');
  });

  it('counts the tiles over the picked queue only', async () => {
    setup({
      route: '/p/AC/team?view=queues&queue=member:pm',
      items: [queueItem({ id: 'a' }), queueItem({ id: 'b' })],
      integrator: [integratorItem({ id: 'i1' })],
    });
    await screen.findByText('Item a');
    const tiles = screen.getByRole('group', { name: t('workQueues.tiles.label') });
    expect(within(tiles).getByText(t('workQueues.tiles.queued')).previousElementSibling?.textContent).toBe(
      '2',
    );
  });

  it('shows a picked restricted queue as its header alone, with no tiles and no empty-result notice', async () => {
    setup({
      viewer: 'kata',
      access: 'admin',
      route: '/p/AC/team?view=queues&queue=integrator',
      items: [queueItem({ id: 'a' })],
      integrator: [integratorItem({ id: 'i1' })],
    });
    expect(await screen.findByText(t('workQueues.integrator.restricted'))).toBeTruthy();
    expect(screen.queryByRole('group', { name: t('workQueues.tiles.label') })).toBeNull();
    expect(screen.queryByText(t('workQueues.noMatch'))).toBeNull();
    expect(screen.queryByRole('button', { name: t('workQueues.clear') })).toBeNull();
  });

  it('drops an invalid reason or long flag from the URL without a word', async () => {
    setup({ route: '/p/AC/team?view=queues&reason=bogus&long=maybe', items: [queueItem({ id: 'a' })] });
    await screen.findByText('Item a');
    await waitFor(() => expect(url()).toBe('/p/AC/team?view=queues'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the way back to the panel across a filter change', async () => {
    setup({
      state: { fromOperator: { path: '/p/AC/inbox' } },
      items: [queueItem({ id: 'a' })],
    });
    const heading = await screen.findByRole('heading', { name: t('workQueues.title') });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    fireEvent.click(await screen.findByRole('checkbox', { name: t('workQueues.onlyLong') }));
    await waitFor(() => expect(url()).toContain('long=1'));
    expect(screen.getByTestId('url').getAttribute('data-state')).toContain('/p/AC/inbox');
    expect(screen.getByRole('link', { name: t('workQueues.back') }).getAttribute('href')).toBe('/p/AC/inbox');
  });

  it('writes the search after a pause and filters by title or card key', async () => {
    setup({
      items: [
        queueItem({ id: 'a', title: 'Zöld alma' }),
        queueItem({ id: 'b', title: 'Piros körte', taskKey: 'AC-7' }),
      ],
    });
    const search = await screen.findByRole('searchbox', { name: t('workQueues.search') });
    fireEvent.change(search, { target: { value: 'ac-7' } });
    expect(url()).not.toContain('q=');
    await waitFor(() => expect(url()).toContain('q=ac-7'));
    expect(screen.queryByText('Zöld alma')).toBeNull();
    expect(screen.getByText('Piros körte')).toBeTruthy();
  });

  it('says an unknown queue is missing and clears the filters on request', async () => {
    setup({ route: '/p/AC/team?view=queues&queue=member:ghost', items: [queueItem({ id: 'a' })] });
    expect(await screen.findByText(t('workQueues.missing'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('workQueues.clear') }));
    await waitFor(() => expect(url()).toBe('/p/AC/team?view=queues'));
    expect(await screen.findByText('Item a')).toBeTruthy();
  });
});

describe('the states of the view', () => {
  it('shows a skeleton while the queues load', async () => {
    const project = mockProject();
    const fetch = createMockFetch(project.backend, project.requests);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setFetchImplementation(async (path, init) => {
      if (path.endsWith('/work-queues')) await gate;
      return fetch(path, init);
    });
    project.render(<TeamPage />, '/p/AC/team?view=queues');
    expect(await screen.findByRole('status', { name: t('app.loading') })).toBeTruthy();
    release();
    await waitFor(() => expect(screen.queryByRole('status', { name: t('app.loading') })).toBeNull());
  });

  it('explains the screen on first use and says "empty" once something has been queued', async () => {
    const first = setup({ items: [] });
    expect(await screen.findByText(t('workQueues.first.title'))).toBeTruthy();
    first.unmount();
    setup({
      items: [
        queueItem({
          id: 'a',
          state: 'done',
          queuedAt: minutesAgo(60),
          closedAt: minutesAgo(5),
          closeReason: 'finished',
        }),
      ],
    });
    expect(await screen.findByText(t('workQueues.empty.title'))).toBeTruthy();
  });

  it('says it could not load the queues and tries again', async () => {
    const project = mockProject();
    project.backend.queueItems = [queueItem({ id: 'a', title: 'Megjön' })];
    const fetch = createMockFetch(project.backend, project.requests);
    let fail = true;
    setFetchImplementation(async (path, init) => {
      if (fail && path.endsWith('/work-queues'))
        return new Response(JSON.stringify({ error: { code: 'internal', message: 'Failed' } }), {
          status: 500,
        });
      return fetch(path, init);
    });
    project.render(<TeamPage />, '/p/AC/team?view=queues');
    expect(await screen.findByText(t('workQueues.loadFailed'))).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('app.retry')) }));
    expect(await screen.findByText('Megjön')).toBeTruthy();
  });

  it('keeps the list and says it is stale when a reload fails', async () => {
    const project = mockProject();
    project.backend.queueItems = [queueItem({ id: 'a', title: 'Marad' })];
    const fetch = createMockFetch(project.backend, project.requests);
    let fail = false;
    setFetchImplementation(async (path, init) => {
      if (fail && path.endsWith('/work-queues'))
        return new Response(JSON.stringify({ error: { code: 'internal', message: 'Failed' } }), {
          status: 500,
        });
      return fetch(path, init);
    });
    const ui = project.render(<TeamPage />, '/p/AC/team?view=queues');
    await screen.findByText('Marad');
    fail = true;
    applyServerEvent(ui.client, { type: 'member_queue_changed', projectKey: 'AC', member: 'pm' });
    expect(
      await screen.findByText(new RegExp(t('workQueues.stale', { time: '.*' }).split('.*')[0] ?? '')),
    ).toBeTruthy();
    expect(screen.getByText('Marad')).toBeTruthy();
    expect(screen.queryByText('!')).toBeNull();
  });

  it('leads the title to the inbox item and the card key to the card', async () => {
    setup({ integrator: [integratorItem({ id: 'i1', title: 'Levél', taskKey: 'AC-7' })] });
    const title = await screen.findByRole('link', { name: 'Levél' });
    expect(title.getAttribute('href')).toContain('/p/AC/inbox#');
    expect(screen.getByRole('link', { name: 'AC-7' }).getAttribute('href')).toBe('/p/AC/tasks/AC-7');
  });

  it('refreshes the list on a member_queue_changed event', async () => {
    const { project, client } = setup({ items: [queueItem({ id: 'a', title: 'Első' })] });
    await screen.findByText('Első');
    project.backend.queueItems.push(queueItem({ id: 'b', title: 'Második' }));
    applyServerEvent(client, { type: 'member_queue_changed', projectKey: 'AC', member: 'pm' });
    expect(await screen.findByText('Második')).toBeTruthy();
  });

  it('refreshes the connected Claude on an integrator inbox event', async () => {
    const { project, client } = setup({ integrator: [integratorItem({ id: 'i1', title: 'Régi' })] });
    await screen.findByText('Régi');
    project.backend.integratorQueueItems.push(integratorItem({ id: 'i2', title: 'Újabb' }));
    applyServerEvent(client, { type: 'integrator_connections_changed', projectKey: 'AC' });
    expect(await screen.findByText('Újabb')).toBeTruthy();
  });
});

describe('a group cut by the overview', () => {
  const many = (count: number, make: (index: number) => Partial<MemberQueueItem>) =>
    Array.from({ length: count }, (_, index) =>
      queueItem({ id: `m${index}`, queuedAt: minutesAgo(1000 - index), ...make(index) }),
    );

  it('loads the rest on request, moving the focus to the first new item', async () => {
    setup({ items: many(105, (index) => ({ title: `Tétel ${index}` })) });
    const more = await screen.findByRole('button', { name: t('workQueues.group.more', { count: 5 }) });
    expect(screen.getByText(t('workQueues.group.long', { count: '≥ 100' }))).toBeTruthy();
    fireEvent.click(more);
    await waitFor(() => expect(screen.queryByRole('button', { name: /További tételek/ })).toBeNull());
    await waitFor(() => expect(document.activeElement?.getAttribute('data-work-queue-item')).toBe('m100'));
    expect(screen.queryByText(t('workQueues.group.limited', { count: 500 }))).toBeNull();
  });

  it('says how many of the oldest items are on screen when even the full list is cut', async () => {
    setup({
      route: '/p/AC/team?view=queues&q=Kulcs',
      items: many(501, (index) => ({ title: index < 2 ? `Kulcs ${index}` : `Más ${index}` })),
    });
    fireEvent.click(await screen.findByRole('button', { name: t('workQueues.group.more', { count: 401 }) }));
    expect(await screen.findByText(t('workQueues.group.limited', { count: 500 }))).toBeTruthy();
  });
});

describe('the closed items', () => {
  const closedItem = (id: string, title: string) =>
    queueItem({
      id,
      title,
      state: 'done',
      queuedAt: minutesAgo(30),
      closedAt: minutesAgo(1),
      closeReason: 'finished',
      outcome: { summary: 'Átállította', operationIds: [], machine: false, handoff: null },
    });

  it('lists the closed items of the project manager queue on request', async () => {
    setup({ items: [closedItem('c1', 'Lezárt dolog')] });
    const summary = (await screen.findByText(t('workQueues.closed.title'))).closest('summary')!;
    fireEvent.click(summary);
    expect(await screen.findByText('Lezárt dolog')).toBeTruthy();
    expect(await screen.findByText(/Átállította/)).toBeTruthy();
  });

  it('says nothing was closed today', async () => {
    setup({ items: [queueItem({ id: 'a' })] });
    fireEvent.click((await screen.findByText(t('workQueues.closed.title'))).closest('summary')!);
    expect(await screen.findByText(t('workQueues.closed.emptyToday'))).toBeTruthy();
  });

  it('tells that no closing history exists for the connected Claude', async () => {
    setup({ route: '/p/AC/team?view=queues&queue=integrator', integrator: [integratorItem({ id: 'i1' })] });
    fireEvent.click((await screen.findByText(t('workQueues.closed.title'))).closest('summary')!);
    expect(await screen.findByText(t('workQueues.closed.integratorNone'))).toBeTruthy();
  });
});
