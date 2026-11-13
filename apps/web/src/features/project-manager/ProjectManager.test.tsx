import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ConfigChangeRow,
  ProjectManagerRequestView,
  ProjectManagerSignal,
  ProjectManagerStep,
  UiPlace,
} from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { MeContext } from '../../app/contexts';
import { ProjectLayout } from '../../app/ProjectLayout';
import { ToastProvider } from '../../components/Toast';
import { t } from '../../i18n/t';
import { showOnScreen } from '../../test/intersection';
import { createMockFetch, mockProject } from '../../test/mockProject';
import { projectManagerSummaryFixture } from '../../mocks/fixtures';
import { TaskDrawer } from '../board/TaskDrawer';
import { HistorySection } from '../settings/sections/HistorySection';
import { TeamPage } from '../team/TeamPage';
import { ProjectManagerSignalCard } from './ProjectManagerSignalCard';
import { ProjectManagerSignalList } from './ProjectManagerSignalList';
import { ProjectManagerSignalGroup } from './ProjectManagerSignalGroup';

/**
 * The Operator in the top right corner (PM-447), against the fake backend: who has the button and the badge of
 * open signals, the panel with the viewer's own conversation, the server's steps, the signal cards, the Rád vár
 * approvals, the history entry and the Team restrictions of the built-in member.
 */
afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

type Project = ReturnType<typeof mockProject>;

/** `owner` is the project's owner; `kata` a client (another person, not an owner); `admin` only changes the access the page sees. */
function renderLayout(
  project: Project,
  route = '/p/AC',
  options: {
    viewer?: 'owner' | 'kata';
    access?: 'owner' | 'admin' | 'developer' | 'client';
    contacts?: string[];
  } = {},
) {
  const viewer = options.viewer ?? 'owner';
  const access = options.access ?? (viewer === 'owner' ? 'owner' : 'client');
  project.backend.viewerHandle = viewer;
  // A client writes only to the contacts; the project manager is one (PM-985).
  project.backend.config.team.contacts = options.contacts ?? ['pm'];
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
            <Route path="tasks/:taskKey" element={<p>card</p>} />
            <Route path="inbox" element={<p>inbox</p>} />
          </Route>
        </Routes>
      </MeContext.Provider>
    </ToastProvider>,
    route,
  );
}

const button = () =>
  screen.findByRole('button', { name: new RegExp(`^${t('operator.button.aria', { status: '' })}`) });
const projectManagerName = (project: Project) => project.backend.findMember('pm')!.displayName;
const posted = (project: Project, suffix: string) =>
  project.requests.filter((r) => r.method === 'POST' && r.path.endsWith(suffix));

function step(
  partial: Partial<ProjectManagerStep> & Pick<ProjectManagerStep, 'id' | 'action' | 'status'>,
): ProjectManagerStep {
  return {
    requestId: 'req_1',
    at: '2026-10-10T09:00:00.000Z',
    taskKey: null,
    member: null,
    changes: [],
    configVersion: null,
    inboxItemId: null,
    signalId: null,
    refusal: null,
    ...partial,
  };
}

function request(
  steps: ProjectManagerStep[],
  messageId: string | null,
  quote = 'Állítsd át a szövegírót',
): ProjectManagerRequestView {
  return { id: 'req_1', messageId, quote, openedAt: '2026-10-10T09:00:00.000Z', closedAt: null, steps };
}

function signal(
  partial: Partial<ProjectManagerSignal> & Pick<ProjectManagerSignal, 'id' | 'kind'>,
): ProjectManagerSignal {
  return {
    state: 'open',
    actionable: true,
    taskKey: 'AC-20',
    subject: null,
    inboxItemId: null,
    messageId: null,
    raisedAt: '2026-10-10T08:00:00.000Z',
    decidedBy: null,
    decidedAt: null,
    resolvedAt: null,
    ...partial,
  };
}

const CHANGE: ConfigChangeRow = {
  area: 'member',
  target: 'dev-1',
  field: 'permissionMode',
  before: 'default',
  after: 'bypassPermissions',
  level: 'approval',
};

describe('the Operator button', () => {
  it('shows who can answer in its name, for an owner', async () => {
    const project = mockProject();
    renderLayout(project);
    const operator = await button();
    await waitFor(() =>
      expect(operator.getAttribute('aria-label')).toBe(
        t('operator.button.aria', { status: t('operator.status.available') }),
      ),
    );
    expect(operator.getAttribute('aria-haspopup')).toBe('dialog');
    expect(operator.getAttribute('aria-expanded')).toBe('false');
  });

  it('counts the owner open signals on the button, and keeps the count out of a guest button', async () => {
    const project = mockProject();
    project.backend.projectManagerSignals = [
      signal({ id: 'sig_1', kind: 'outage', taskKey: null }),
      signal({ id: 'sig_2', kind: 'merge_blocked' }),
      signal({ id: 'sig_3', kind: 'silent', state: 'dismissed' }),
    ];
    renderLayout(project);
    const operator = await button();
    await waitFor(() =>
      expect(operator.getAttribute('aria-label')).toContain(t('operator.button.signals', { count: 2 })),
    );
    expect(within(operator).getByTestId('operator-signals-count').textContent).toBe('2');
  });

  it('is there for a client, with no signal count and no signal cards', async () => {
    const project = mockProject();
    project.backend.projectManagerSignals = [signal({ id: 'sig_1', kind: 'merge_blocked' })];
    renderLayout(project, '/p/AC', { viewer: 'kata' });
    const operator = await button();
    await waitFor(() =>
      expect(operator.getAttribute('aria-label')).toBe(
        t('operator.button.aria', { status: t('operator.status.available') }),
      ),
    );
    expect(screen.queryByTestId('operator-signals-count')).toBeNull();
    fireEvent.click(operator);
    const panel = await screen.findByRole('dialog');
    await within(panel).findByRole('textbox', { name: t('operator.composer.label') });
    expect(within(panel).queryByRole('heading', { name: /elakadt a beolvasztás/ })).toBeNull();
  });

  it('is not there for a client while the Operator is not a contact (PM-985)', async () => {
    const project = mockProject();
    renderLayout(project, '/p/AC', { viewer: 'kata', contacts: ['fe-1'] });
    await screen.findByText('board');
    await waitFor(() => expect(project.requests.some((r) => r.path.endsWith('/config'))).toBe(true));
    expect(
      screen.queryByRole('button', { name: new RegExp(`^${t('operator.button.aria', { status: '' })}`) }),
    ).toBeNull();
  });
});

describe('the project manager on leave', () => {
  it('says so in a band, links the profile for an owner and still takes a message', async () => {
    const project = mockProject();
    const pm = project.backend.config.team.members.find((member) => member.handle === 'pm');
    if (pm?.kind !== 'ai') throw new Error('The fixture has no project manager');
    pm.onLeave = true;
    renderLayout(project);
    const operator = await button();
    await waitFor(() =>
      expect(operator.getAttribute('aria-label')).toBe(
        t('operator.button.aria', { status: t('operator.status.on_leave') }),
      ),
    );
    fireEvent.click(operator);
    const panel = await screen.findByRole('dialog');
    expect(await within(panel).findByText(t('operator.banner.onLeave'))).toBeTruthy();
    expect(
      within(panel)
        .getByRole('link', { name: new RegExp(t('operator.banner.profile')) })
        .getAttribute('href'),
    ).toBe('/p/AC/team/pm');
    const composer = within(panel).getByRole('textbox', { name: t('operator.composer.label') });
    fireEvent.change(composer, { target: { value: 'Várom a visszatérést' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => expect(posted(project, '/messages')[0]?.body).toMatchObject({ to: ['pm'] }));
  });
});

describe('the Operator panel', () => {
  it('opens beside the page with the focus in the composer and closes with Escape, back to the button', async () => {
    const project = mockProject();
    renderLayout(project);
    const operator = await button();
    fireEvent.click(operator);
    const panel = await screen.findByRole('dialog', { name: projectManagerName(project) });
    expect(panel.getAttribute('aria-modal')).toBe('false');
    expect(operator.getAttribute('aria-expanded')).toBe('true');
    const composer = await within(panel).findByRole('textbox', { name: t('operator.composer.label') });
    await waitFor(() => expect(document.activeElement).toBe(composer));

    fireEvent.keyDown(composer, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(operator);
  });

  it('marks a reply read only when it has been on the screen, not when the panel opens (PM-1386)', async () => {
    const project = mockProject();
    project.backend.messages = [];
    project.backend.sendTeamMessage('pm', ['owner'], null, 'Summary below the fold');
    renderLayout(project);
    fireEvent.click(await button());
    const panel = await screen.findByRole('dialog', { name: projectManagerName(project) });
    await within(panel).findByText('Summary below the fold');
    // The label sits at the start of the message, not in an empty strip before it.
    const markOf = () => within(panel).queryByText(t('messages.thread.unread'));
    const reads = () =>
      project.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/messages/read'));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(reads()).toHaveLength(0);
    showOnScreen(markOf()!);
    await waitFor(() => expect(reads()).toHaveLength(1), { timeout: 3000 });
    await waitFor(() => expect(markOf()).toBeNull());
  });

  it('has no call-back button: the Operator is never on leave', async () => {
    const project = mockProject();
    renderLayout(project);
    fireEvent.click(await button());
    const panel = await screen.findByRole('dialog');
    await within(panel).findByRole('textbox', { name: t('operator.composer.label') });
    expect(within(panel).queryByRole('button', { name: /Visszahív/ })).toBeNull();
  });

  it('sends the message to the Operator and shows it in the thread', async () => {
    const project = mockProject();
    renderLayout(project);
    fireEvent.click(await button());
    const composer = await screen.findByRole('textbox', { name: t('operator.composer.label') });
    fireEvent.change(composer, { target: { value: 'Mi az állás?' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() =>
      expect(posted(project, '/messages')[0]?.body).toEqual({
        clientRequestId: expect.any(String),
        to: ['pm'],
        text: 'Mi az állás?',
        location: { page: 'board' },
      }),
    );
    const log = await screen.findByRole('log', { name: t('operator.thread.label') });
    expect(await within(log).findByText('Mi az állás?')).toBeTruthy();
  });

  it('adds the open card as the message context until it is taken off', async () => {
    const project = mockProject();
    renderLayout(project, '/p/AC/tasks/AC-20');
    fireEvent.click(await button());
    const panel = await screen.findByRole('dialog');
    const title = project.backend.tasks.find((task) => task.key === 'AC-20')!.title;
    const chip = await within(panel).findByText(t('operator.context.label', { key: 'AC-20' }));
    expect(chip.getAttribute('title')).toBe(t('operator.context.title', { key: 'AC-20', title }));
    expect(within(panel).getByText(t('operator.context.hint'))).toBeTruthy();
    expect(
      within(panel).getByRole('link', { name: t('operator.context.open', { key: 'AC-20' }) }),
    ).toBeTruthy();

    const composer = within(panel).getByRole('textbox', { name: t('operator.composer.label') });
    fireEvent.change(composer, { target: { value: 'Nézd meg ezt' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() =>
      expect(posted(project, '/messages')[0]?.body).toEqual({
        clientRequestId: expect.any(String),
        to: ['pm'],
        text: 'Nézd meg ezt',
        taskKey: 'AC-20',
        location: { page: 'board', taskKey: 'AC-20', view: 'card' },
      }),
    );
  });

  it('sends no card key once the chip is taken off, and the place stays what it is', async () => {
    const project = mockProject();
    renderLayout(project, '/p/AC/tasks/AC-20');
    fireEvent.click(await button());
    const panel = await screen.findByRole('dialog');
    fireEvent.click(await within(panel).findByRole('button', { name: t('operator.context.remove') }));

    const composer = within(panel).getByRole('textbox', { name: t('operator.composer.label') });
    fireEvent.change(composer, { target: { value: 'Általában kérdezek' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() =>
      expect(posted(project, '/messages')[0]?.body).toEqual({
        clientRequestId: expect.any(String),
        to: ['pm'],
        text: 'Általában kérdezek',
        location: { page: 'board', taskKey: 'AC-20', view: 'card' },
      }),
    );
  });

  it('keeps the context hint after the chip is taken off, and shows only the pm’s own row of a message', async () => {
    const project = mockProject();
    project.backend.sendTeamMessage('owner', ['pm', 'be-1'], null, 'Kettőnek szól');
    renderLayout(project, '/p/AC/tasks/AC-20');
    fireEvent.click(await button());
    const panel = await screen.findByRole('dialog');
    const lines = await within(panel).findAllByRole('list', { name: t('processing.list') });
    expect(lines).toHaveLength(1);
    const names = within(lines[0]!)
      .getAllByRole('listitem')
      .map((row) => row.textContent);
    expect(names).toHaveLength(1);
    expect(names[0]).not.toContain(project.backend.findMember('be-1')!.displayName);

    fireEvent.click(await within(panel).findByRole('button', { name: t('operator.context.remove') }));
    expect(within(panel).getByText(t('operator.context.hint'))).toBeTruthy();
  });

  describe('the places the Operator offers (PM-1071)', () => {
    const offer = (project: Project, places: UiPlace[]) =>
      project.backend.sendTeamMessage(
        'pm',
        ['owner'],
        null,
        'Itt találod.',
        undefined,
        undefined,
        undefined,
        undefined,
        {
          places,
        },
      );
    const openPanel = async () => {
      fireEvent.click(await button());
      return screen.findByRole('dialog');
    };
    const titleOf = (project: Project, key: string) =>
      project.backend.tasks.find((task) => task.key === key)!.title;

    it('offers a button that goes there on click, and nowhere before', async () => {
      const project = mockProject();
      offer(project, [{ page: 'card', taskKey: 'AC-20' }]);
      renderLayout(project);
      const panel = await openPanel();
      expect(screen.getByText('board')).toBeTruthy();

      const name = t('operator.place.go', { place: `AC-20 · ${titleOf(project, 'AC-20')}` });
      const link = await within(panel).findByRole('link', { name });
      expect(link.getAttribute('href')).toBe('/p/AC/tasks/AC-20');
      fireEvent.click(link);
      expect(await screen.findByText('card')).toBeTruthy();
    });

    it('marks the place the reader is at instead of offering it', async () => {
      const project = mockProject();
      offer(project, [{ page: 'card', taskKey: 'AC-20' }]);
      renderLayout(project, '/p/AC/tasks/AC-20');
      const panel = await openPanel();
      const here = await within(panel).findByText(
        t('operator.place.here', { place: `AC-20 · ${titleOf(project, 'AC-20')}` }),
      );
      expect(here.closest('[aria-current="page"]')).toBeTruthy();
      expect(within(panel).queryByRole('link', { name: /AC-20 ·/ })).toBeNull();
    });

    it('opens a card over the page the reader is on', async () => {
      const project = mockProject();
      offer(project, [{ page: 'card', taskKey: 'AC-20' }]);
      renderLayout(project, '/p/AC/inbox');
      const panel = await openPanel();
      const link = await within(panel).findByRole('link', { name: /AC-20 ·/ });
      expect(link.getAttribute('href')).toBe('/p/AC/inbox/tasks/AC-20');
    });

    it.each([
      ['a settings part the reader does not see', { page: 'settings', section: 'email' } as UiPlace],
      ['a card that is gone', { page: 'card', taskKey: 'AC-9999' } as UiPlace],
    ])('says %s is not available, with no button', async (_name, place) => {
      const project = mockProject();
      offer(project, [place]);
      renderLayout(project, '/p/AC', { access: 'developer' });
      const panel = await openPanel();
      expect(await within(panel).findByText(t('operator.place.unavailable'))).toBeTruthy();
      expect(within(panel).queryByRole('link', { name: /^Ugrás ide/ })).toBeNull();
    });
  });

  it('introduces itself on first use and puts a picked example into the box', async () => {
    const project = mockProject();
    renderLayout(project);
    fireEvent.click(await button());
    const panel = await screen.findByRole('dialog');
    expect(await within(panel).findByText(t('operator.intro.title'))).toBeTruthy();

    const composer = within(panel).getByRole<HTMLTextAreaElement>('textbox', {
      name: t('operator.composer.label'),
    });
    fireEvent.click(within(panel).getByRole('button', { name: t('operator.intro.examples.status') }));
    await waitFor(() => expect(composer.value).toBe(t('operator.intro.examples.status')));
    expect(document.activeElement).toBe(composer);
    expect(posted(project, '/messages')).toHaveLength(0);
  });

  it('gives a person who is not an owner a read-only introduction, and says who else can see the conversation', async () => {
    const project = mockProject();
    renderLayout(project, '/p/AC', { viewer: 'kata' });
    fireEvent.click(await button());
    const panel = await screen.findByRole('dialog');
    expect(await within(panel).findByText(t('operator.intro.other.readOnly'))).toBeTruthy();
    expect(within(panel).getByText(t('operator.panel.observers'))).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: t('operator.intro.examples.writer') })).toBeNull();
  });

  it('tells the truth while the team is paused instead of promising an answer', async () => {
    const project = mockProject();
    project.backend.pauses.pauseProject();
    renderLayout(project);
    fireEvent.click(await button());
    const panel = await screen.findByRole('dialog');
    expect(await within(panel).findByText(t('operator.banner.paused'))).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: t('operator.banner.resume') }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: projectManagerName(project) })).toBeNull(),
    );
    expect(posted(project, '/pause/resume')).toHaveLength(0);
  });

  it('says there is no Operator when the project has none', async () => {
    const project = mockProject();
    const config = project.backend.config;
    config.team.members = config.team.members.filter((member) => member.handle !== 'pm');
    renderLayout(project);
    fireEvent.click(await button());
    expect(await screen.findByText(t('operator.missing.title'))).toBeTruthy();
  });

  it('links the full session for an admin or an owner, not for a developer', async () => {
    const project = mockProject();
    const base = project.backend.sessions[0]!;
    project.backend.sessions.push({
      ...base,
      id: 'ses_pm',
      member: 'pm',
      workItem: { type: 'general' },
      state: 'idle',
    });
    const { unmount } = renderLayout(project, '/p/AC', { access: 'admin' });
    fireEvent.click(await button());
    const panel = await screen.findByRole('dialog');
    const link = await within(panel).findByRole('link', {
      name: new RegExp(t('operator.panel.fullSession')),
    });
    expect(link.getAttribute('href')).toBe('/p/AC/sessions/ses_pm');
    unmount();

    renderLayout(project, '/p/AC', { access: 'developer' });
    fireEvent.click(await button());
    const second = await screen.findByRole('dialog');
    await within(second).findByRole('textbox', { name: t('operator.composer.label') });
    expect(
      within(second).queryByRole('link', { name: new RegExp(t('operator.panel.fullSession')) }),
    ).toBeNull();
  });
});

describe('the steps of a request', () => {
  it('lists what the Operator did in three groups under the request, with the server reason of a refusal', async () => {
    const project = mockProject();
    const asked = project.backend.sendTeamMessage('owner', ['pm'], null, 'Állítsd át a szövegírót');
    project.backend.projectManagerRequests = [
      request(
        [
          step({ id: 'stp_1', action: 'task_move', status: 'done', taskKey: 'AC-20' }),
          step({ id: 'stp_2', action: 'member_change', status: 'awaiting_approval', member: 'dev-1' }),
          step({
            id: 'stp_3',
            action: 'member_retire',
            status: 'refused',
            member: 'pm',
            refusal: { code: 'operator_never', message: 'never' },
          }),
        ],
        asked.id,
      ),
    ];
    renderLayout(project);
    fireEvent.click(await button());
    const steps = await screen.findByRole('region', { name: t('operator.steps.label') });
    for (const group of ['done', 'awaiting', 'refused'] as const)
      expect(within(steps).getByRole('heading', { name: t(`operator.steps.${group}`) })).toBeTruthy();
    // The icon never carries the state alone.
    expect(within(steps).getByText(t('operator.steps.iconDone'))).toBeTruthy();
    expect(within(steps).getByText(t('operator.steps.iconAwaiting'))).toBeTruthy();
  });

  it('shows what a done step changed, with a link to the history when it made a configuration version', async () => {
    const project = mockProject();
    const asked = project.backend.sendTeamMessage('owner', ['pm'], null, 'Kapcsold ki a szabadságot');
    project.backend.projectManagerRequests = [
      request(
        [
          step({
            id: 'stp_1',
            action: 'member_change',
            status: 'done',
            member: 'dev-1',
            changes: [{ ...CHANGE, field: 'onLeave', before: 'true', after: 'false' }],
            configVersion: 'cfg0001',
          }),
        ],
        asked.id,
      ),
    ];
    renderLayout(project);
    fireEvent.click(await button());
    const steps = await screen.findByRole('region', { name: t('operator.steps.label') });
    expect(within(steps).getByRole('region', { name: t('operator.approval.changes') })).toBeTruthy();
    const history = within(steps).getByRole('link', { name: new RegExp(t('operator.steps.history')) });
    expect(history.getAttribute('href')).toBe('/p/AC/settings/history');
  });

  it.each([
    { owners: 1, name: 'writeToOwner', href: '/p/AC/messages/with/owner' },
    { owners: 2, name: 'writeToAnOwner', href: '/p/AC/team' },
  ] as const)(
    'links a refused owner-only step to $href with $owners owner(s)',
    async ({ owners, name, href }) => {
      const project = mockProject();
      if (owners > 1) {
        const owner = project.backend.members.find((member) => member.handle === 'owner')!;
        project.backend.members.push({ ...owner, handle: 'owner-2', displayName: 'Második' });
      }
      const asked = project.backend.sendTeamMessage('kata', ['pm'], null, 'Töröld a szövegírót');
      project.backend.projectManagerRequests = [
        request(
          [
            step({
              id: 'stp_1',
              action: 'member_retire',
              status: 'refused',
              member: 'pm',
              refusal: { code: 'operator_owner_only', message: 'owner only' },
            }),
          ],
          asked.id,
        ),
      ];
      renderLayout(project, '/p/AC', { viewer: 'kata' });
      fireEvent.click(await button());
      const steps = await screen.findByRole('region', { name: t('operator.steps.label') });
      const link = within(steps).getByRole('link', { name: new RegExp(t(`operator.steps.${name}`)) });
      expect(link.getAttribute('href')).toBe(href);
    },
  );
});

describe('unanchored Operator signals', () => {
  function setup(count = 55) {
    const project = mockProject();
    project.backend.projectManagerSignals = Array.from({ length: count }, (_, index) =>
      signal({
        id: `sig_${index}`,
        kind: 'merge_blocked',
        raisedAt: `2026-10-10T08:${String(index).padStart(2, '0')}:00.000Z`,
      }),
    );
    const question = project.backend.sendTeamMessage('owner', ['pm'], null, 'Question');
    question.createdAt = '2026-10-10T09:00:00.000Z';
    const reply = project.backend.sendTeamMessage('pm', ['owner'], null, 'Latest reply');
    reply.createdAt = '2026-10-10T09:01:00.000Z';
    return project;
  }
  const groupButton = (count: number) =>
    screen.findByRole('button', { name: new RegExp(`^${t('operator.signal.pending', { count })}`) });

  it('keeps 55 earlier signals collapsed before the question and latest reply, and retains a dismissed row with focus', async () => {
    const project = setup();
    renderLayout(project);
    fireEvent.click(await button());
    const toggle = await groupButton(55);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const log = screen.getByRole('log');
    // jsdom has no layout: model the height change while the reader is at the bottom.
    Object.defineProperties(log, {
      scrollHeight: {
        configurable: true,
        get: () => (toggle.getAttribute('aria-expanded') === 'true' ? 6000 : 800),
      },
      clientHeight: { configurable: true, value: 600 },
    });
    log.scrollTop = 200;
    fireEvent.scroll(log);
    expect(log.lastElementChild?.textContent).toContain('Latest reply');
    expect(screen.queryByRole('button', { name: t('operator.signal.dismiss') })).toBeNull();
    fireEvent.click(toggle);
    expect(log.scrollTop).toBe(200);
    const rows = within(toggle.closest('section')!).getAllByRole('listitem');
    expect(rows).toHaveLength(55);
    fireEvent.click(within(rows[0]!).getByRole('button', { name: t('operator.signal.dismiss') }));
    await within(rows[0]!).findByText(new RegExp(t('operator.signal.dismissed')));
    await groupButton(54);
    expect(rows[0]!.getAttribute('data-state')).toBe('dismissed');
    expect(document.activeElement).toBe(
      within(rows[1]!).getByRole('button', { name: t('operator.signal.accept') }),
    );
    expect(posted(project, '/operator/signals/sig_0/dismiss')).toHaveLength(1);
    expect(log.lastElementChild?.textContent).toContain('Latest reply');
    expect(log.scrollTop).toBe(200);
  });

  it('places a single signal after an equally timed reply, with its own day heading when needed', async () => {
    const project = setup(1);
    project.backend.projectManagerSignals[0]!.raisedAt = '2026-10-10T09:01:00.000Z';
    renderLayout(project);
    fireEvent.click(await button());
    await screen.findByRole('heading', { name: 'AC-20: elakadt a beolvasztás' });
    const log = screen.getByRole('log');
    expect(log.lastElementChild?.querySelector('[data-signal="merge_blocked"]')).toBeTruthy();
    expect(log.lastElementChild?.previousElementSibling?.textContent).toContain('Latest reply');
  });

  it('splits signal groups at midnight and at messages and puts day headings before signals', async () => {
    const project = setup(5);
    const times = [
      '2026-10-09T08:00:00Z',
      '2026-10-09T08:01:00Z',
      '2026-10-10T08:00:00Z',
      '2026-10-10T08:01:00Z',
      '2026-10-10T09:02:00Z',
    ];
    project.backend.projectManagerSignals.forEach((signal, index) => {
      signal.raisedAt = times[index]!;
    });
    renderLayout(project);
    fireEvent.click(await button());
    const toggles = await screen.findAllByRole('button', {
      name: new RegExp(`^${t('operator.signal.pending', { count: 2 })}`),
    });
    expect(toggles).toHaveLength(2);
    for (const toggle of toggles)
      expect(toggle.closest('section')!.previousElementSibling?.getAttribute('role')).toBe('separator');
    expect(screen.getByRole('log').lastElementChild?.querySelector('[data-signal]')).toBeTruthy();
  });

  it('confirms bulk dismissal, cancels with focus, and treats already closed signals as success', async () => {
    const project = setup(6);
    renderLayout(project);
    fireEvent.click(await button());
    const toggle = await groupButton(6);
    fireEvent.click(toggle);
    const bulk = () => screen.getByRole('button', { name: t('operator.signal.dismissAll', { count: 6 }) });
    fireEvent.click(bulk());
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: t('operator.signal.dismissAllYes') }),
    );
    expect(project.requests.filter((r) => r.path.endsWith('/dismiss'))).toHaveLength(0);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(document.activeElement).toBe(bulk());
    fireEvent.click(bulk());
    fireEvent.click(screen.getByRole('button', { name: t('operator.signal.dismissAllCancel') }));
    expect(project.requests.filter((r) => r.path.endsWith('/dismiss'))).toHaveLength(0);
    project.backend.projectManagerSignals[0]!.state = 'resolved';
    const refreshes = project.requests.filter((r) => r.path.endsWith('/project-manager')).length;
    fireEvent.click(bulk());
    fireEvent.click(screen.getByRole('button', { name: t('operator.signal.dismissAllYes') }));
    const settled = await screen.findByRole('button', { name: new RegExp(t('operator.signal.pendingNone')) });
    await waitFor(() => expect(settled.getAttribute('aria-expanded')).toBe('false'));
    expect(project.requests.filter((r) => r.path.endsWith('/dismiss'))).toHaveLength(6);
    expect(project.requests.filter((r) => r.path.endsWith('/project-manager')).length - refreshes).toBe(1);
    expect(document.activeElement).toBe(settled);
    fireEvent.click(settled);
    // The owner's own question carries a delivery line (a list item of its own); the signals are the rest.
    const signals = screen
      .getAllByRole('listitem')
      .filter((item) => item.closest('ul')?.getAttribute('aria-label') !== t('processing.list'));
    expect(signals).toHaveLength(6);
  });

  it('limits bulk requests to four, disables decisions during progress, and retries only failures', async () => {
    const project = setup(6);
    const fetch = createMockFetch(project.backend, project.requests);
    let active = 0;
    let peak = 0;
    let fail = true;
    const release: Array<() => void> = [];
    setFetchImplementation(async (path, init) => {
      if (!path.endsWith('/dismiss')) return fetch(path, init);
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => {
        release.push(resolve);
      });
      active--;
      if (path.endsWith('/sig_1/dismiss') && fail) {
        project.requests.push({ path, method: 'POST', body: undefined });
        return new Response(JSON.stringify({ error: { code: 'internal', message: 'Failed' } }), {
          status: 500,
        });
      }
      return fetch(path, init);
    });
    renderLayout(project);
    fireEvent.click(await button());
    const toggle = await groupButton(6);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: t('operator.signal.dismissAll', { count: 6 }) }));
    fireEvent.click(screen.getByRole('button', { name: t('operator.signal.dismissAllYes') }));
    await waitFor(() => expect(release).toHaveLength(4));
    expect(toggle).toHaveProperty('disabled', true);
    expect(
      screen
        .getAllByRole('button', { name: t('operator.signal.dismiss') })
        .every((b) => (b as HTMLButtonElement).disabled),
    ).toBe(true);
    release.splice(0).forEach((resolve) => resolve());
    await waitFor(() => expect(release).toHaveLength(2));
    release.splice(0).forEach((resolve) => resolve());
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      t('operator.signal.dismissAllFailed', { count: 1 }),
    );
    const retry = screen.getByRole('button', { name: t('operator.signal.dismissAllRetry') });
    expect(document.activeElement).toBe(retry);
    expect(peak).toBe(4);
    fail = false;
    fireEvent.click(retry);
    await waitFor(() => expect(release).toHaveLength(1));
    release.splice(0).forEach((resolve) => resolve());
    await screen.findByRole('button', { name: new RegExp(t('operator.signal.pendingNone')) });
    expect(posted(project, '/operator/signals/sig_1/dismiss')).toHaveLength(2);
    expect(project.requests.filter((r) => r.path.endsWith('/dismiss'))).toHaveLength(7);
  });

  it('lets read-only viewers expand signals without decision buttons', async () => {
    const project = setup(2);
    project.render(
      <ProjectManagerSignalGroup
        signals={project.backend.projectManagerSignals}
        projectManagerHandle="operator"
        readOnly
        onDismiss={() => {}}
      />,
    );
    fireEvent.click(await groupButton(2));
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /Mind/ })).toBeNull();
    expect(screen.queryByRole('button', { name: t('operator.signal.dismiss') })).toBeNull();
  });
});

describe('a signal the Operator raised', () => {
  const presenting = (project: Project, body = 'A kártyát most senki nem viheti.') =>
    project.backend.sendTeamMessage('pm', ['owner'], 'AC-20', body);

  it.each([false, true])(
    'hides coordinator-only cards and preserves their message (mixed: %s)',
    async (mixed) => {
      const project = mockProject();
      const message = presenting(project, 'Historical summary stays readable.');
      project.backend.projectManagerSignals = [
        ...(['pending', 'open', 'dismissed', 'resolved'] as const).flatMap((state) =>
          (['structural_pattern', 'milestone_closed'] as const).map((kind) =>
            signal({ id: `${kind}:${state}`, kind, state, messageId: message.id }),
          ),
        ),
        ...(mixed
          ? [
              signal({ id: 'visible-stalled', kind: 'stalled', messageId: message.id }),
              signal({
                id: 'visible-outage',
                kind: 'outage',
                actionable: false,
                messageId: message.id,
                inboxItemId: 'inb_outage',
              }),
            ]
          : []),
      ];
      renderLayout(project);
      const operator = await button();
      fireEvent.click(operator);
      await screen.findByText('Historical summary stays readable.');
      await waitFor(() => expect(document.querySelectorAll('[data-signal-id]').length).toBe(mixed ? 2 : 0));
      expect(
        document.querySelector('[data-signal="structural_pattern"], [data-signal-id^="structural_pattern"]'),
      ).toBeNull();
      expect(
        document.querySelector('[data-signal="milestone_closed"], [data-signal-id^="milestone_closed"]'),
      ).toBeNull();
      if (mixed) {
        expect(operator.getAttribute('aria-label')).toContain(t('operator.button.signals', { count: 2 }));
        expect(
          screen.getByRole('heading', { name: new RegExp(t('operator.signal.group')) }).textContent,
        ).toContain(t('operator.signal.groupCount', { count: 2 }));
      } else {
        expect(within(operator).queryByTestId('operator-signals-count')).toBeNull();
        expect(document.querySelector('[data-signal]')).toBeNull();
      }
    },
  );

  it('filters trailing coordinator-only cards and counts only three remaining decisions', async () => {
    const project = mockProject();
    project.backend.projectManagerSignals = [
      ...Array.from({ length: 5 }, (_, index) =>
        signal({ id: `hidden_${index}`, kind: index % 2 ? 'milestone_closed' : 'structural_pattern' }),
      ),
      ...(['stalled', 'silent', 'merge_blocked'] as const).map((kind) => signal({ id: kind, kind })),
    ];
    renderLayout(project);
    const operator = await button();
    fireEvent.click(operator);
    const group = await screen.findByRole('button', {
      name: new RegExp(`^${t('operator.signal.pending', { count: 3 })}`),
    });
    fireEvent.click(group);
    const rows = within(group.closest('section')!).getAllByRole('listitem');
    expect(rows.map((row) => row.getAttribute('data-signal-id')).sort()).toEqual([
      'merge_blocked',
      'silent',
      'stalled',
    ]);
    expect(operator.getAttribute('aria-label')).toContain(t('operator.button.signals', { count: 3 }));
    expect(
      document.querySelector('[data-signal="structural_pattern"], [data-signal="milestone_closed"]'),
    ).toBeNull();
  });

  it('groups decisions, orders actionable signals first and keeps rows in place after acceptance', async () => {
    const project = mockProject();
    const message = presenting(project, projectManagerSummaryFixture('summary').body);
    project.backend.projectManagerSignals = projectManagerSummaryFixture(message.id).signals;
    renderLayout(project);
    fireEvent.click(await button());
    const group = await screen.findByRole('heading', { name: new RegExp(t('operator.signal.group')) });
    const card = group.closest('article')!;
    const rows = () => [...card.querySelectorAll('li')];
    expect(rows().map((row) => row.getAttribute('data-signal-id'))).toEqual([
      'sig_first',
      'sig_later',
      'sig_out',
    ]);
    const accept = within(rows()[0]! as HTMLElement).getByRole('button', {
      name: t('operator.signal.accept'),
    });
    expect(accept.getAttribute('aria-describedby')).toBe(rows()[0]!.querySelector('h4')!.id);
    expect(
      within(rows()[2]! as HTMLElement).queryByRole('button', { name: t('operator.signal.accept') }),
    ).toBeNull();
    expect(
      within(rows()[2]! as HTMLElement).getByRole('button', { name: t('operator.signal.dismiss') }),
    ).toBeTruthy();
    fireEvent.click(accept);
    await waitFor(() =>
      expect(posted(project, '/messages')[0]?.body).toMatchObject({ operatorSignal: 'sig_first' }),
    );
    await within(card).findByText(new RegExp(t('operator.signal.accepted')));
    expect(rows().map((row) => row.getAttribute('data-signal-id'))).toEqual([
      'sig_first',
      'sig_later',
      'sig_out',
    ]);
    expect(group.textContent).toContain(t('operator.signal.groupCount', { count: 2 }));
    expect(document.activeElement).toBe(
      within(rows()[1]! as HTMLElement).getByRole('button', { name: t('operator.signal.accept') }),
    );
    expect(
      within(rows()[2]! as HTMLElement).getByRole('button', { name: t('operator.signal.dismiss') }),
    ).toBeTruthy();
    project.backend.projectManagerSignals.find((s) => s.id === 'sig_out')!.state = 'resolved';
    fireEvent.click(
      within(rows()[1]! as HTMLElement).getByRole('button', { name: t('operator.signal.dismiss') }),
    );
    await waitFor(() => expect(card.getAttribute('data-state')).toBe('resolved'));
    expect(within(rows()[2]! as HTMLElement).getByRole('status').textContent).toContain(
      t('operator.signal.resolved'),
    );
    expect(posted(project, '/operator/signals/sig_out/dismiss')).toHaveLength(0);
    expect(group.textContent).toBe(t('operator.signal.group'));
    expect(document.activeElement).toBe(group);
    expect(within(card).queryByRole('button')).toBeNull();
  });

  it('keeps a failed decision on its row while other rows remain actionable', async () => {
    const project = mockProject();
    const message = presenting(project);
    project.backend.projectManagerSignals = projectManagerSummaryFixture(message.id).signals;
    renderLayout(project);
    fireEvent.click(await button());
    const group = await screen.findByRole('heading', { name: new RegExp(t('operator.signal.group')) });
    const rows = [...group.closest('article')!.querySelectorAll('li')];
    project.backend.projectManagerSignals.find((s) => s.id === 'sig_first')!.state = 'resolved';
    fireEvent.click(
      within(rows[0]! as HTMLElement).getByRole('button', { name: t('operator.signal.dismiss') }),
    );
    expect(await within(rows[0]! as HTMLElement).findByRole('alert')).toHaveProperty(
      'textContent',
      t('operator.signal.closed'),
    );
    expect(within(rows[1]! as HTMLElement).queryByRole('alert')).toBeNull();
    expect(
      within(rows[1]! as HTMLElement).getByRole('button', { name: t('operator.signal.accept') }),
    ).toHaveProperty('disabled', false);
  });

  it('reads the message of a signal card once the label in its header has been on the screen (PM-1386)', async () => {
    const project = mockProject();
    const message = presenting(project);
    project.backend.projectManagerSignals = [
      signal({ id: 'sig_1', kind: 'merge_blocked', messageId: message.id }),
    ];
    renderLayout(project);
    fireEvent.click(await button());
    const card = (await screen.findByRole('button', { name: t('operator.signal.accept') })).closest(
      'article',
    )!;
    const reads = () =>
      project.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/messages/read'));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(reads()).toHaveLength(0);
    showOnScreen(within(card).getByText(t('messages.thread.unread')));
    await waitFor(() => expect(reads()).toHaveLength(1), { timeout: 3000 });
  });

  it('says yes with a visible message that names the signal', async () => {
    const project = mockProject();
    const message = presenting(project);
    project.backend.projectManagerSignals = [
      signal({ id: 'sig_1', kind: 'merge_blocked', messageId: message.id }),
    ];
    renderLayout(project);
    fireEvent.click(await button());
    fireEvent.click(await screen.findByRole('button', { name: t('operator.signal.accept') }));
    await waitFor(() =>
      expect(posted(project, '/messages')[0]?.body).toEqual({
        to: ['pm'],
        text: t('operator.signal.acceptMessage'),
        operatorSignal: 'sig_1',
        taskKey: 'AC-20',
      }),
    );
    expect(await screen.findByText(t('operator.signal.acceptMessage'))).toBeTruthy();
    expect(await screen.findByText(new RegExp(t('operator.signal.accepted')))).toBeTruthy();
    expect(posted(project, '/dismiss')).toHaveLength(0);
  });

  it.each(['summary', 'single', 'no message'] as const)(
    'dismisses a non-actionable signal with no acceptance button (%s)',
    async (presentation) => {
      const project = mockProject();
      const message = presentation === 'no message' ? null : presenting(project);
      project.backend.projectManagerSignals = [
        signal({ id: 'sig_1', kind: 'silent', actionable: false, messageId: message?.id ?? null }),
        ...(presentation === 'summary'
          ? [signal({ id: 'sig_2', kind: 'merge_blocked', messageId: message!.id })]
          : []),
      ];
      renderLayout(project);
      const operator = await button();
      const initialCount = project.backend.projectManagerSignals.length;
      await waitFor(() =>
        expect(within(operator).getByTestId('operator-signals-count').textContent).toBe(String(initialCount)),
      );
      fireEvent.click(operator);
      const heading = await screen.findByRole('heading', { name: 'AC-20: a munkamenet nem ad jelet' });
      expect(screen.getByText(message?.body ?? t('operator.signal.bodies.silent'))).toBeTruthy();
      const row = heading.closest('li') ?? heading.closest('article')!;
      expect(within(row).queryByRole('button', { name: t('operator.signal.accept') })).toBeNull();
      const dismiss = within(row).getByRole('button', { name: t('operator.signal.dismiss') });
      expect(within(row).getAllByRole('button')).toHaveLength(1);
      if (presentation === 'summary') {
        const actionable = heading.closest('article')!.querySelector('li[data-signal-id="sig_2"]')!;
        expect(within(actionable as HTMLElement).getAllByRole('button')).toHaveLength(2);
        expect(
          within(actionable as HTMLElement).getByRole('button', { name: t('operator.signal.accept') }),
        ).toBeTruthy();
      }
      fireEvent.click(dismiss);
      await waitFor(() => expect(posted(project, '/operator/signals/sig_1/dismiss')).toHaveLength(1));
      expect(posted(project, '/operator/signals/sig_1/dismiss')[0]?.path).toBe(
        '/api/projects/AC/operator/signals/sig_1/dismiss',
      );
      expect(posted(project, '/messages')).toHaveLength(0);
      expect(await within(row).findByText(new RegExp(t('operator.signal.dismissed')))).toBeTruthy();
      expect(row.getAttribute('data-state')).toBe('dismissed');
      expect(within(row).queryByRole('button')).toBeNull();
      await waitFor(() => {
        if (initialCount === 1) expect(within(operator).queryByTestId('operator-signals-count')).toBeNull();
        else expect(within(operator).getByTestId('operator-signals-count').textContent).toBe('1');
      });
      if (presentation === 'summary') {
        const group = within(heading.closest('article')!).getByRole('heading', {
          name: new RegExp(t('operator.signal.group')),
        });
        expect(group.textContent).toContain(t('operator.signal.groupCount', { count: 1 }));
        expect(document.activeElement).toBe(
          screen.getByRole('button', { name: t('operator.signal.accept') }),
        );
      }
      if (presentation === 'no message') {
        fireEvent.click(screen.getByRole('button', { name: t('operator.panel.close') }));
        fireEvent.click(operator);
        await screen.findByRole('textbox', { name: t('operator.composer.label') });
        expect(screen.queryByRole('heading', { name: 'AC-20: a munkamenet nem ad jelet' })).toBeNull();
        expect(screen.queryByText(new RegExp(t('operator.signal.dismissed')))).toBeNull();
      }
    },
  );

  it('keeps historical and Operator dismissals without messages out of the thread', async () => {
    const project = mockProject();
    project.backend.projectManagerSignals = [
      signal({ id: 'sig_old', kind: 'silent', actionable: false, state: 'dismissed', decidedBy: 'owner' }),
      signal({
        id: 'sig_operator',
        kind: 'stalled',
        actionable: false,
        state: 'dismissed',
        decidedBy: 'operator',
      }),
      signal({ id: 'sig_open', kind: 'merge_blocked', actionable: false }),
    ];
    renderLayout(project);
    fireEvent.click(await button());
    await screen.findByRole('heading', { name: 'AC-20: elakadt a beolvasztás' });
    expect(screen.queryByRole('heading', { name: 'AC-20: a munkamenet nem ad jelet' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'AC-20: válaszra vár a munkamenet' })).toBeNull();
    expect(screen.queryByText(new RegExp(t('operator.signal.dismissed')))).toBeNull();
  });

  it.each(['summary', 'card'] as const)('hides every signal decision in a read-only %s', (presentation) => {
    const project = mockProject();
    const message = presenting(project);
    const signals = [
      signal({ id: 'sig_1', kind: 'silent', actionable: false, messageId: message.id }),
      signal({ id: 'sig_2', kind: 'merge_blocked', messageId: message.id }),
    ];
    project.render(
      presentation === 'summary' ? (
        <ProjectManagerSignalList
          signals={signals}
          message={message}
          projectManagerHandle="operator"
          readOnly
        />
      ) : (
        <>
          {signals.map((entry) => (
            <ProjectManagerSignalCard
              key={entry.id}
              signal={entry}
              message={null}
              projectManagerHandle="operator"
              readOnly
            />
          ))}
        </>
      ),
    );
    expect(screen.getByRole('heading', { name: 'AC-20: a munkamenet nem ad jelet' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'AC-20: elakadt a beolvasztás' })).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows every visible kind by its own title inside a group', async () => {
    const project = mockProject();
    const kinds = [
      'outage',
      'stalled',
      'silent',
      'merge_blocked',
      'unreleased',
      'obligation_overdue',
    ] as const;
    const withoutCard = ['outage', 'unreleased'];
    project.backend.projectManagerSignals = kinds.map((kind) =>
      signal({ id: `sig_${kind}`, kind, taskKey: withoutCard.includes(kind) ? null : 'AC-20' }),
    );
    renderLayout(project);
    fireEvent.click(await button());
    fireEvent.click(
      await screen.findByRole('button', {
        name: new RegExp(t('operator.signal.pending', { count: kinds.length })),
      }),
    );
    for (const kind of kinds) {
      const title = t(`operator.signal.kinds.${kind}`, { key: 'AC-20' });
      expect(await screen.findByRole('heading', { name: new RegExp(`^${title}`) })).toBeTruthy();
    }
    expect(screen.getAllByRole('listitem')).toHaveLength(kinds.length);
  });

  it('says on the card that the signal is no longer open, without a toast', async () => {
    const project = mockProject();
    project.backend.projectManagerSignals = [signal({ id: 'sig_1', kind: 'merge_blocked' })];
    renderLayout(project);
    fireEvent.click(await button());
    const dismiss = await screen.findByRole('button', { name: t('operator.signal.dismiss') });
    project.backend.projectManagerSignals[0]!.state = 'resolved';
    fireEvent.click(dismiss);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', t('operator.signal.closed'));
  });
});

describe('the Operator in the history of the settings', () => {
  it('shows the Operator as the author, who approved and the request it came from', async () => {
    const project = mockProject();
    const quote = 'A szövegíró legyen Sonnet, mert a jelenlegi túl lassú';
    project.backend.history.unshift({
      version: 'abc1234',
      message: 'Szövegíró: Sonnet',
      author: 'Operátor',
      at: '2026-10-10T09:00:00.000Z',
      operator: 'operator',
      request: quote,
      approvedBy: 'owner',
    });
    project.render(<HistorySection current="abc1234" canRevert />);
    // The Operator is gone from the team (decision 66): the old entry still names the handle it carries.
    expect(await screen.findByText('operator')).toBeTruthy();
    expect(screen.getByText(t('settings.history.approvedBy', { name: t('common.you') }))).toBeTruthy();
    const request = screen.getByText(t('settings.history.request', { quote }));
    expect(request.getAttribute('title')).toBe(quote);
    // A plain entry has neither.
    expect(screen.getAllByText(/Jóváhagyta/)).toHaveLength(1);
  });
});

describe('the Operator on a card and on its profile', () => {
  it('stands in the card head and opens the panel', async () => {
    const project = mockProject();
    const openProjectManager = vi.fn();
    project.render(
      <Routes>
        <Route path="/p/:key/tasks/:taskKey" element={<TaskDrawer />} />
      </Routes>,
      '/p/AC/tasks/AC-20',
      { openProjectManager },
    );
    fireEvent.click(await button());
    expect(openProjectManager).toHaveBeenCalledTimes(1);
  });
});

describe('the Operator is no member of the team (decision 66)', () => {
  it('is not offered when hiring', async () => {
    const project = mockProject();
    project.render(<TeamPage />);
    fireEvent.click(await screen.findByRole('button', { name: t('team.hire') }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText(t('hire.roles'));
    expect(within(dialog).queryByRole('radio', { name: new RegExp(t('operator.name')) })).toBeNull();
  });
});
