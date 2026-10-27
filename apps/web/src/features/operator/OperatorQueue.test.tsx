import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MEMBER_QUEUE_CLOSED_LIMIT } from '@projectman/shared';
import type { MemberQueueItem } from '@projectman/shared';
import { applyServerEvent } from '../../api/cache';
import { setFetchImplementation } from '../../api/client';
import { MeContext } from '../../app/contexts';
import { ProjectLayout } from '../../app/ProjectLayout';
import { ToastProvider } from '../../components/Toast';
import { t } from '../../i18n/t';
import { inboxItemDomId } from '../../lib/inbox';
import { createMockFetch, mockProject } from '../../test/mockProject';

/**
 * The project manager's queue in the corner (PM-890, PM-1042), against the fake backend: the count on the button,
 * the strip in the panel, and the Sor view with its open list, today's closed items and the states around them.
 */
afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

type Project = ReturnType<typeof mockProject>;
type Access = 'owner' | 'developer' | 'client';

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function item(partial: Partial<MemberQueueItem> & Pick<MemberQueueItem, 'id'>): MemberQueueItem {
  return {
    projectKey: 'AC',
    member: 'pm',
    kind: 'todo',
    source: { type: 'inbox', inboxItemId: partial.id },
    place: { type: 'general' },
    wake: true,
    state: 'queued',
    title: `Item ${partial.id}`,
    from: 'owner',
    taskKey: null,
    queuedAt: ago(5),
    startedAt: null,
    closedAt: null,
    closeReason: null,
    attempts: 0,
    restartedAt: null,
    sessionId: null,
    wait: null,
    outcome: null,
    ...partial,
  };
}

/** A closed item that ended with the given outcome, a minute ago. */
function closed(id: string, state: MemberQueueItem['state'], outcome: MemberQueueItem['outcome']) {
  return item({ id, state, outcome, queuedAt: ago(30), closedAt: ago(1), closeReason: 'finished' });
}

/** `owner` is the project's owner; `kata` another person, whose access the test sets. */
function renderLayout(project: Project, options: { viewer?: 'owner' | 'kata'; access?: Access } = {}) {
  const viewer = options.viewer ?? 'owner';
  const access = options.access ?? (viewer === 'owner' ? 'owner' : 'developer');
  project.backend.viewerHandle = viewer;
  // A client writes only to the contacts; the project manager is one (PM-985).
  project.backend.config.team.contacts = ['pm'];
  project.backend.config.team.members.forEach((member) => {
    if (member.kind === 'human' && member.handle === viewer) member.access = access;
  });
  const me = {
    ...project.context.me,
    handles: { AC: viewer },
    projects: [{ key: 'AC', name: 'Fictional project', access, roles: [] }],
  };
  return project.render(
    <ToastProvider>
      <MeContext.Provider value={me}>
        <Routes>
          <Route path="/p/:projectKey" element={<ProjectLayout />}>
            <Route index element={<p>board</p>} />
          </Route>
        </Routes>
      </MeContext.Provider>
    </ToastProvider>,
    '/p/AC',
  );
}

const button = () =>
  screen.findByRole('button', { name: new RegExp(`^${t('operator.button.aria', { status: '' })}`) });
const toggle = () => screen.findByRole('button', { name: new RegExp(`^${t('operator.queue.toggle')}`) });
const closedList = () => screen.findByRole('list', { name: t('operator.queue.closedList') });

/** Opens the panel and then the queue view; returns the query client, for the tests that push server events. */
async function openQueue(project: Project, options: Parameters<typeof renderLayout>[1] = {}) {
  const { client } = renderLayout(project, options);
  fireEvent.click(await button());
  fireEvent.click(await toggle());
  await screen.findByRole('heading', { name: t('operator.queue.title') });
  return client;
}

describe('the Operator button with a queue', () => {
  it('names the queue length and shows the count', async () => {
    const project = mockProject();
    project.backend.queueItems = [item({ id: 'q1' }), item({ id: 'q2' })];
    renderLayout(project);
    const operator = await button();
    await waitFor(() =>
      expect(operator.getAttribute('aria-label')).toContain(t('operator.button.queue', { count: 2 })),
    );
    expect(within(operator).getByTestId('operator-queue-count').textContent).toBe('2');
  });

  it('has no count for an empty queue', async () => {
    const project = mockProject();
    renderLayout(project);
    const operator = await button();
    await waitFor(() =>
      expect(operator.getAttribute('aria-label')).toContain(t('operator.status.available')),
    );
    expect(within(operator).queryByTestId('operator-queue-count')).toBeNull();
  });
});

describe('the strip in the panel', () => {
  it('names the item in work and how many more wait, and opens the queue', async () => {
    const project = mockProject();
    project.backend.queueItems = [
      item({ id: 'q1', state: 'processing', title: 'Állítsd át a szövegírót', startedAt: ago(1) }),
      item({ id: 'q2' }),
      item({ id: 'q3' }),
    ];
    renderLayout(project);
    fireEvent.click(await button());
    const strip = await screen.findByTestId('operator-queue-strip');
    expect(strip.textContent).toContain(t('operator.queue.strip.now', { title: 'Állítsd át a szövegírót' }));
    expect(strip.textContent).toContain(t('operator.queue.strip.more', { count: 2 }));
    // The visible text is the name; the purpose is the description (WCAG 2.5.3).
    expect(screen.getByRole('button', { name: new RegExp('Állítsd át a szövegírót') })).toBe(strip);
    fireEvent.click(strip);
    const heading = await screen.findByRole('heading', { name: t('operator.queue.title') });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it('is not there for an empty queue', async () => {
    const project = mockProject();
    renderLayout(project);
    fireEvent.click(await button());
    await toggle();
    expect(screen.queryByTestId('operator-queue-strip')).toBeNull();
  });

  it('is not offered to a person without developer access', async () => {
    const project = mockProject();
    project.backend.queueItems = [item({ id: 'q1' })];
    renderLayout(project, { viewer: 'kata', access: 'client' });
    fireEvent.click(await button());
    await screen.findByRole('textbox', { name: t('operator.composer.label') });
    expect(screen.queryByRole('button', { name: new RegExp(`^${t('operator.queue.toggle')}`) })).toBeNull();
    expect(screen.queryByTestId('operator-queue-strip')).toBeNull();
  });
});

describe('the Sor view', () => {
  it('lists what waits, with the item in work marked and the reason of a wait', async () => {
    const project = mockProject();
    project.backend.queueItems = [
      item({ id: 'q1', state: 'processing', title: 'Dolgozik rajta' }),
      item({
        id: 'q2',
        title: 'Vár',
        kind: 'message',
        taskKey: 'AC-12',
        wait: { code: 'team_paused', at: ago(2) },
      }),
    ];
    await openQueue(project);
    const list = await screen.findByRole('list', { name: t('operator.queue.openList') });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain(t('operator.queue.now'));
    expect(rows[1]!.textContent).toContain(t('operator.queue.wait.team_paused'));
    expect(within(rows[1]!).getByRole('link', { name: 'AC-12' }).getAttribute('href')).toBe(
      '/p/AC/tasks/AC-12',
    );
  });

  it('shows a skeleton while the queue loads', async () => {
    const project = mockProject();
    const fetch = createMockFetch(project.backend, project.requests);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setFetchImplementation(async (path, init) => {
      if (path.includes('/project-manager/queue')) await gate;
      return fetch(path, init);
    });
    await openQueue(project);
    expect(screen.getByRole('status', { name: t('app.loading') })).toBeTruthy();
    release();
    await waitFor(() => expect(screen.queryByRole('status', { name: t('app.loading') })).toBeNull());
  });

  it('says it could not load the queue and tries again on "Újra"', async () => {
    const project = mockProject();
    project.backend.queueItems = [item({ id: 'q1', title: 'Megjön' })];
    const fetch = createMockFetch(project.backend, project.requests);
    let fail = true;
    setFetchImplementation(async (path, init) => {
      if (fail && path.includes('/project-manager/queue'))
        return new Response(JSON.stringify({ error: { code: 'internal', message: 'Failed' } }), {
          status: 500,
        });
      return fetch(path, init);
    });
    await openQueue(project);
    expect(await screen.findByText(t('operator.queue.loadFailed'))).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: /Újra/ }));
    expect(await screen.findByText('Megjön')).toBeTruthy();
  });

  it('keeps the list on screen and shows one line when a reload fails', async () => {
    const project = mockProject();
    project.backend.queueItems = [item({ id: 'q1', title: 'Marad' })];
    const fetch = createMockFetch(project.backend, project.requests);
    let fail = false;
    setFetchImplementation(async (path, init) => {
      if (fail && path.includes('/project-manager/queue'))
        return new Response(JSON.stringify({ error: { code: 'internal', message: 'Failed' } }), {
          status: 500,
        });
      return fetch(path, init);
    });
    const client = await openQueue(project);
    await screen.findByText('Marad');
    fail = true;
    applyServerEvent(client, { type: 'member_queue_changed', projectKey: 'AC', member: 'pm' });
    expect(await screen.findByText(t('operator.queue.refreshFailed'))).toBeTruthy();
    expect(screen.getByText('Marad')).toBeTruthy();
  });

  it('explains the screen on first use', async () => {
    const project = mockProject();
    await openQueue(project);
    expect(await screen.findByText(t('operator.queue.first.title'))).toBeTruthy();
    expect(screen.queryByRole('list', { name: t('operator.queue.closedList') })).toBeNull();
  });

  it('says the queue is empty once the Operator has had work, and lists today closed items', async () => {
    const project = mockProject();
    project.backend.queueItems = [
      closed('c1', 'done', { summary: 'Átállította', operationIds: [], machine: false, handoff: null }),
    ];
    await openQueue(project);
    expect(await screen.findByText(t('operator.queue.summary.empty'))).toBeTruthy();
    expect((await closedList()).textContent).toContain('Átállította');
  });

  it('tells that the Operator was restarted', async () => {
    const project = mockProject();
    project.backend.queueItems = [item({ id: 'q1', state: 'processing', restartedAt: ago(2) })];
    await openQueue(project);
    expect(await screen.findByText(new RegExp(t('operator.queue.restarted', { time: '.*' })))).toBeTruthy();
  });

  it('shows the owner-addressed handoff to another member without an inbox link', async () => {
    const project = mockProject();
    project.backend.queueItems = [
      closed('c1', 'handed_off', {
        summary: '',
        operationIds: [],
        machine: false,
        handoff: { reason: 'owner_reserved', inboxItemId: 'inb_1' },
      }),
    ];
    await openQueue(project, { viewer: 'kata', access: 'developer' });
    const list = await closedList();
    expect(list.textContent).toContain(
      t('operator.queue.outcome.handedOffOwner', {
        reason: t('operator.queue.outcome.reasonsOther.owner_reserved'),
      }),
    );
    expect(
      within(list).queryByRole('link', { name: new RegExp(t('operator.queue.outcome.inbox')) }),
    ).toBeNull();
  });

  it.each<{
    name: string;
    state: MemberQueueItem['state'];
    outcome: MemberQueueItem['outcome'];
    text: () => string;
    inbox: boolean;
  }>([
    {
      name: 'done',
      state: 'done' as const,
      outcome: { summary: 'Átállította a szövegírót', operationIds: [], machine: false, handoff: null },
      text: () => 'Átállította a szövegírót',
      inbox: false,
    },
    {
      name: 'handed to the owner',
      state: 'handed_off' as const,
      outcome: {
        summary: '',
        operationIds: [],
        machine: false,
        handoff: { reason: 'no_grant' as const, inboxItemId: 'inb_7' },
      },
      text: () =>
        t('operator.queue.outcome.handedOff', { reason: t('operator.queue.outcome.reasons.no_grant') }),
      inbox: true,
    },
    {
      name: 'failed and handed over',
      state: 'handed_off' as const,
      outcome: {
        summary: '',
        operationIds: [],
        machine: false,
        handoff: { reason: 'processing_failed' as const, inboxItemId: 'inb_7' },
      },
      text: () => t('operator.queue.outcome.failed'),
      inbox: true,
    },
    {
      name: 'handed to the super side',
      state: 'handed_off',
      outcome: {
        summary: '',
        operationIds: [],
        machine: false,
        handoff: { reason: 'no_grant', inboxItemId: 'inb_7', to: 'super' },
      },
      text: () =>
        t('operator.queue.outcome.handedOffSuper', {
          reason: t('operator.queue.outcome.reasonsOther.no_grant'),
        }),
      inbox: false,
    },
    {
      name: 'failed and handed to the super side',
      state: 'handed_off',
      outcome: {
        summary: '',
        operationIds: [],
        machine: false,
        handoff: { reason: 'processing_failed', inboxItemId: 'inb_7', to: 'super' },
      },
      text: () => t('operator.queue.outcome.failedSuper'),
      inbox: false,
    },
    {
      name: 'cancelled',
      state: 'cancelled' as const,
      outcome: null,
      text: () => t('operator.queue.outcome.cancelled'),
      inbox: false,
    },
  ])('shows how a $name item ended', async ({ state, outcome, text, inbox }) => {
    const project = mockProject();
    project.backend.queueItems = [closed('c1', state, outcome)];
    await openQueue(project);
    const list = await closedList();
    expect(list.textContent).toContain(text());
    const link = within(list).queryByRole('link', { name: new RegExp(t('operator.queue.outcome.inbox')) });
    if (inbox) expect(link?.getAttribute('href')).toBe(`/p/AC/inbox#${inboxItemDomId('inb_7')}`);
    else expect(link).toBeNull();
  });

  it('reads the earlier week on "Korábbiak" and says when the list is cut', async () => {
    const project = mockProject();
    project.backend.queueItems = Array.from({ length: MEMBER_QUEUE_CLOSED_LIMIT }, (_, index) =>
      closed(`c${index}`, 'done', {
        summary: `Kész ${index}`,
        operationIds: [],
        machine: false,
        handoff: null,
      }),
    );
    await openQueue(project);
    await closedList();
    expect(screen.getByText(t('operator.queue.limit', { count: MEMBER_QUEUE_CLOSED_LIMIT }))).toBeTruthy();
    const queueRequests = () => project.requests.filter((r) => r.path.includes('/project-manager/queue'));
    const before = queueRequests().length;
    fireEvent.click(screen.getByRole('button', { name: t('operator.queue.earlier') }));
    await waitFor(() => expect(queueRequests().length).toBeGreaterThan(before));
    expect(screen.queryByRole('button', { name: t('operator.queue.earlier') })).toBeNull();
    expect(
      await screen.findByRole('heading', {
        name: new RegExp('^' + t('operator.queue.closedWeek', { count: '.*' })),
      }),
    ).toBeTruthy();
  });

  it('reads the queue again when the server says it changed', async () => {
    const project = mockProject();
    const client = await openQueue(project);
    await screen.findByText(t('operator.queue.first.title'));
    project.backend.queueItems = [item({ id: 'q1', title: 'Új tétel' })];
    applyServerEvent(client, { type: 'member_queue_changed', projectKey: 'AC', member: 'pm' });
    expect(await screen.findByText('Új tétel')).toBeTruthy();
  });
});
