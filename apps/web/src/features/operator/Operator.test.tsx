import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ConfigChangeRow,
  InboxItem,
  OperatorApprovalPayload,
  OperatorRequestView,
  OperatorSignal,
  OperatorStep,
} from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { MeContext } from '../../app/contexts';
import { ProjectLayout } from '../../app/ProjectLayout';
import { ToastProvider } from '../../components/Toast';
import { t } from '../../i18n/t';
import { formatStamp } from '../../i18n/format';
import { createMockFetch, mockProject } from '../../test/mockProject';
import { operatorSummaryFixture, operatorMessageApprovalFixture } from '../../mocks/fixtures';
import { TaskDrawer } from '../board/TaskDrawer';
import { InboxPage } from '../inbox/InboxPage';
import { HistorySection } from '../settings/sections/HistorySection';
import { MemberProfilePage } from '../team/MemberProfilePage';
import { TeamPage } from '../team/TeamPage';
import { OperatorSignalCard } from './OperatorSignalCard';
import { OperatorSignalList } from './OperatorSignalList';
import { OperatorSignalGroup } from './OperatorSignalGroup';

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
  options: { viewer?: 'owner' | 'kata'; access?: 'owner' | 'admin' | 'developer' | 'client' } = {},
) {
  const viewer = options.viewer ?? 'owner';
  const access = options.access ?? (viewer === 'owner' ? 'owner' : 'client');
  project.backend.viewerHandle = viewer;
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
          </Route>
        </Routes>
      </MeContext.Provider>
    </ToastProvider>,
    route,
  );
}

const button = () => screen.findByRole('button', { name: new RegExp(`^${t('operator.panel.label')}`) });
const operatorName = (project: Project) => project.backend.findMember('operator')!.displayName;
const posted = (project: Project, suffix: string) =>
  project.requests.filter((r) => r.method === 'POST' && r.path.endsWith(suffix));

function step(partial: Partial<OperatorStep> & Pick<OperatorStep, 'id' | 'action' | 'status'>): OperatorStep {
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
  steps: OperatorStep[],
  messageId: string | null,
  quote = 'Állítsd át a szövegírót',
): OperatorRequestView {
  return { id: 'req_1', messageId, quote, openedAt: '2026-10-10T09:00:00.000Z', closedAt: null, steps };
}

function signal(partial: Partial<OperatorSignal> & Pick<OperatorSignal, 'id' | 'kind'>): OperatorSignal {
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

function approvalItem(
  stepId: string,
  payload: Partial<OperatorApprovalPayload> = {},
  state: InboxItem['state'] = 'open',
): InboxItem {
  const operator: OperatorApprovalPayload = {
    requestId: 'req_1',
    stepId,
    quote: 'Adj a fejlesztőnek több jogot',
    action: 'member_change',
    operation: { op: 'member_update', handle: 'dev-1', changes: { permissionMode: 'bypassPermissions' } },
    changes: [CHANGE],
    consequence: 'permission_mode',
    baseVersion: null,
    session: null,
    stale: null,
    ...payload,
  };
  return {
    id: `inb_${stepId}`,
    projectKey: 'AC',
    kind: 'approval',
    assignees: ['owner'],
    source: 'operator',
    sessionId: null,
    taskKey: null,
    title: 'Tag módosítása: dev-1',
    body: null,
    payload: { operator },
    options: operator.stale
      ? [{ id: 'dismiss', label: 'dismiss', style: 'secondary' }]
      : [
          { id: 'approve', label: 'approve', style: 'primary' },
          { id: 'reject', label: 'reject', style: 'secondary' },
        ],
    state,
    resolution: null,
    createdAt: '2026-10-10T09:00:00.000Z',
  };
}

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
    project.backend.operatorSignals = [
      signal({ id: 'sig_1', kind: 'outage', taskKey: null }),
      signal({ id: 'sig_2', kind: 'nobody' }),
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
    project.backend.operatorSignals = [signal({ id: 'sig_1', kind: 'nobody' })];
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
    expect(within(panel).queryByRole('heading', { name: /senki nem viheti/ })).toBeNull();
  });
});

describe('the Operator panel', () => {
  it('opens beside the page with the focus in the composer and closes with Escape, back to the button', async () => {
    const project = mockProject();
    renderLayout(project);
    const operator = await button();
    fireEvent.click(operator);
    const panel = await screen.findByRole('dialog', { name: operatorName(project) });
    expect(panel.getAttribute('aria-modal')).toBe('false');
    expect(operator.getAttribute('aria-expanded')).toBe('true');
    const composer = await within(panel).findByRole('textbox', { name: t('operator.composer.label') });
    await waitFor(() => expect(document.activeElement).toBe(composer));

    fireEvent.keyDown(composer, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(operator);
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
        to: ['operator'],
        text: 'Mi az állás?',
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
    expect(await within(panel).findByText(t('operator.context.label', { key: 'AC-20', title }))).toBeTruthy();

    const composer = within(panel).getByRole('textbox', { name: t('operator.composer.label') });
    fireEvent.change(composer, { target: { value: 'Nézd meg ezt' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() =>
      expect(posted(project, '/messages')[0]?.body).toEqual({
        to: ['operator'],
        text: 'Nézd meg ezt',
        taskKey: 'AC-20',
      }),
    );
  });

  it('introduces itself on first use and puts a picked example into the box', async () => {
    const project = mockProject();
    renderLayout(project);
    fireEvent.click(await button());
    const panel = await screen.findByRole('dialog');
    expect(await within(panel).findByText(t('operator.intro.title'))).toBeTruthy();
    // The owner is told where the daily work distributor is.
    expect(within(panel).getByText(t('operator.intro.transitionLink'), { exact: false })).toBeTruthy();

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
    expect(within(panel).queryByText(t('operator.intro.transitionLink'), { exact: false })).toBeNull();
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
    await waitFor(() => expect(screen.queryByRole('dialog', { name: operatorName(project) })).toBeNull());
    expect(posted(project, '/pause/resume')).toHaveLength(0);
  });

  it('says there is no Operator when the project has none', async () => {
    const project = mockProject();
    const config = project.backend.config;
    config.team.members = config.team.members.filter((member) => member.handle !== 'operator');
    renderLayout(project);
    fireEvent.click(await button());
    expect(await screen.findByText(t('operator.missing.title'))).toBeTruthy();
  });

  it('links the full session for an admin or an owner, not for a developer', async () => {
    const project = mockProject();
    const base = project.backend.sessions[0]!;
    project.backend.sessions.push({
      ...base,
      id: 'ses_operator',
      member: 'operator',
      workItem: { type: 'general' },
      state: 'idle',
    });
    const { unmount } = renderLayout(project, '/p/AC', { access: 'admin' });
    fireEvent.click(await button());
    const panel = await screen.findByRole('dialog');
    const link = await within(panel).findByRole('link', {
      name: new RegExp(t('operator.panel.fullSession')),
    });
    expect(link.getAttribute('href')).toBe('/p/AC/sessions/ses_operator');
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
    const asked = project.backend.sendTeamMessage('owner', ['operator'], null, 'Állítsd át a szövegírót');
    project.backend.operatorRequests = [
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
    const asked = project.backend.sendTeamMessage('owner', ['operator'], null, 'Kapcsold ki a szabadságot');
    project.backend.operatorRequests = [
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
      const asked = project.backend.sendTeamMessage('kata', ['operator'], null, 'Töröld a szövegírót');
      project.backend.operatorRequests = [
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

  it('decides a proposal inline for the owner, and shows the card as approved', async () => {
    const project = mockProject();
    const asked = project.backend.sendTeamMessage(
      'owner',
      ['operator'],
      null,
      'Adj a fejlesztőnek több jogot',
    );
    project.backend.inbox.push(approvalItem('stp_1'));
    project.backend.operatorRequests = [
      request(
        [
          step({
            id: 'stp_1',
            action: 'member_change',
            status: 'awaiting_approval',
            member: 'dev-1',
            inboxItemId: 'inb_stp_1',
          }),
        ],
        asked.id,
      ),
    ];
    renderLayout(project);
    fireEvent.click(await button());
    const steps = await screen.findByRole('region', { name: t('operator.steps.label') });
    fireEvent.click(await within(steps).findByRole('button', { name: t('operator.approval.approve') }));
    await waitFor(() =>
      expect(posted(project, '/inbox/inb_stp_1/resolve')[0]?.body).toEqual({ optionId: 'approve' }),
    );
  });

  it('does not offer the decision to a person who may not decide', async () => {
    const project = mockProject();
    const asked = project.backend.sendTeamMessage(
      'kata',
      ['operator'],
      null,
      'Adj a fejlesztőnek több jogot',
    );
    project.backend.inbox.push(approvalItem('stp_1'));
    project.backend.operatorRequests = [
      request(
        [
          step({
            id: 'stp_1',
            action: 'member_change',
            status: 'awaiting_approval',
            member: 'dev-1',
            inboxItemId: 'inb_stp_1',
          }),
        ],
        asked.id,
      ),
    ];
    renderLayout(project, '/p/AC', { viewer: 'kata' });
    fireEvent.click(await button());
    const steps = await screen.findByRole('region', { name: t('operator.steps.label') });
    expect(within(steps).getByText(t('operator.steps.actions.member_change'))).toBeTruthy();
    expect(within(steps).queryByRole('button', { name: t('operator.approval.approve') })).toBeNull();
  });
});

describe('unanchored Operator signals', () => {
  function setup(count = 55) {
    const project = mockProject();
    project.backend.operatorSignals = Array.from({ length: count }, (_, index) =>
      signal({
        id: `sig_${index}`,
        kind: 'nobody',
        raisedAt: `2026-10-10T08:${String(index).padStart(2, '0')}:00.000Z`,
      }),
    );
    const question = project.backend.sendTeamMessage('owner', ['operator'], null, 'Question');
    question.createdAt = '2026-10-10T09:00:00.000Z';
    const reply = project.backend.sendTeamMessage('operator', ['owner'], null, 'Latest reply');
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
    project.backend.operatorSignals[0]!.raisedAt = '2026-10-10T09:01:00.000Z';
    renderLayout(project);
    fireEvent.click(await button());
    await screen.findByRole('heading', { name: 'AC-20: senki nem viheti' });
    const log = screen.getByRole('log');
    expect(log.lastElementChild?.querySelector('[data-signal="nobody"]')).toBeTruthy();
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
    project.backend.operatorSignals.forEach((signal, index) => {
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
    project.backend.operatorSignals[0]!.state = 'resolved';
    const refreshes = project.requests.filter((r) => r.path.endsWith('/operator')).length;
    fireEvent.click(bulk());
    fireEvent.click(screen.getByRole('button', { name: t('operator.signal.dismissAllYes') }));
    const settled = await screen.findByRole('button', { name: new RegExp(t('operator.signal.pendingNone')) });
    await waitFor(() => expect(settled.getAttribute('aria-expanded')).toBe('false'));
    expect(project.requests.filter((r) => r.path.endsWith('/dismiss'))).toHaveLength(6);
    expect(project.requests.filter((r) => r.path.endsWith('/operator')).length - refreshes).toBe(1);
    expect(document.activeElement).toBe(settled);
    fireEvent.click(settled);
    expect(screen.getAllByRole('listitem')).toHaveLength(6);
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
      <OperatorSignalGroup
        signals={project.backend.operatorSignals}
        operatorHandle="operator"
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
    project.backend.sendTeamMessage('operator', ['owner'], 'AC-20', body);

  it.each([false, true])(
    'hides coordinator-only cards and preserves their message (mixed: %s)',
    async (mixed) => {
      const project = mockProject();
      const message = presenting(project, 'Historical summary stays readable.');
      project.backend.operatorSignals = [
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
    project.backend.operatorSignals = [
      ...Array.from({ length: 5 }, (_, index) =>
        signal({ id: `hidden_${index}`, kind: index % 2 ? 'milestone_closed' : 'structural_pattern' }),
      ),
      ...(['stalled', 'silent', 'nobody'] as const).map((kind) => signal({ id: kind, kind })),
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
      'nobody',
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
    const message = presenting(project, operatorSummaryFixture('summary').body);
    project.backend.operatorSignals = operatorSummaryFixture(message.id).signals;
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
    project.backend.operatorSignals.find((s) => s.id === 'sig_out')!.state = 'resolved';
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
    project.backend.operatorSignals = operatorSummaryFixture(message.id).signals;
    renderLayout(project);
    fireEvent.click(await button());
    const group = await screen.findByRole('heading', { name: new RegExp(t('operator.signal.group')) });
    const rows = [...group.closest('article')!.querySelectorAll('li')];
    project.backend.operatorSignals.find((s) => s.id === 'sig_first')!.state = 'resolved';
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

  it('says yes with a visible message that names the signal', async () => {
    const project = mockProject();
    const message = presenting(project);
    project.backend.operatorSignals = [signal({ id: 'sig_1', kind: 'nobody', messageId: message.id })];
    renderLayout(project);
    fireEvent.click(await button());
    fireEvent.click(await screen.findByRole('button', { name: t('operator.signal.accept') }));
    await waitFor(() =>
      expect(posted(project, '/messages')[0]?.body).toEqual({
        to: ['operator'],
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
      project.backend.operatorSignals = [
        signal({ id: 'sig_1', kind: 'silent', actionable: false, messageId: message?.id ?? null }),
        ...(presentation === 'summary'
          ? [signal({ id: 'sig_2', kind: 'nobody', messageId: message!.id })]
          : []),
      ];
      renderLayout(project);
      const operator = await button();
      const initialCount = project.backend.operatorSignals.length;
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
    project.backend.operatorSignals = [
      signal({ id: 'sig_old', kind: 'silent', actionable: false, state: 'dismissed', decidedBy: 'owner' }),
      signal({
        id: 'sig_operator',
        kind: 'ready_waiting',
        actionable: false,
        state: 'dismissed',
        decidedBy: 'operator',
      }),
      signal({ id: 'sig_open', kind: 'nobody', actionable: false }),
    ];
    renderLayout(project);
    fireEvent.click(await button());
    await screen.findByRole('heading', { name: 'AC-20: senki nem viheti' });
    expect(screen.queryByRole('heading', { name: 'AC-20: a munkamenet nem ad jelet' })).toBeNull();
    expect(screen.queryByRole('heading', { name: t('operator.signal.kinds.ready_waiting') })).toBeNull();
    expect(screen.queryByText(new RegExp(t('operator.signal.dismissed')))).toBeNull();
  });

  it.each(['summary', 'card'] as const)('hides every signal decision in a read-only %s', (presentation) => {
    const project = mockProject();
    const message = presenting(project);
    const signals = [
      signal({ id: 'sig_1', kind: 'silent', actionable: false, messageId: message.id }),
      signal({ id: 'sig_2', kind: 'nobody', messageId: message.id }),
    ];
    project.render(
      presentation === 'summary' ? (
        <OperatorSignalList signals={signals} message={message} operatorHandle="operator" readOnly />
      ) : (
        <>
          {signals.map((entry) => (
            <OperatorSignalCard
              key={entry.id}
              signal={entry}
              message={null}
              operatorHandle="operator"
              readOnly
            />
          ))}
        </>
      ),
    );
    expect(screen.getByRole('heading', { name: 'AC-20: a munkamenet nem ad jelet' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'AC-20: senki nem viheti' })).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows every visible kind by its own title inside a group', async () => {
    const project = mockProject();
    const kinds = [
      'outage',
      'nobody',
      'stalled',
      'silent',
      'idle',
      'merge_waiting',
      'merge_blocked',
      'unreleased',
      'ready_waiting',
    ] as const;
    const withoutCard = ['outage', 'unreleased', 'ready_waiting'];
    project.backend.operatorSignals = kinds.map((kind) =>
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
    project.backend.operatorSignals = [signal({ id: 'sig_1', kind: 'nobody' })];
    renderLayout(project);
    fireEvent.click(await button());
    const dismiss = await screen.findByRole('button', { name: t('operator.signal.dismiss') });
    project.backend.operatorSignals[0]!.state = 'resolved';
    fireEvent.click(dismiss);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', t('operator.signal.closed'));
  });
});

describe('the approval in Rád vár', () => {
  const rendered = (project: Project) => project.render(<InboxPage />, '/p/AC/inbox');

  it('shows the plan, recipient and full exact message before sending, always as irreversible', async () => {
    const project = mockProject();
    const payload = operatorMessageApprovalFixture();
    const text = 'First paragraph.\n\n' + 'A long exact message. '.repeat(250) + '\nFinal line.';
    project.backend.inbox.push(
      approvalItem('stp_message', {
        ...payload,
        operation: { op: 'message_send', to: ['kata'], text, taskKey: 'AC-1' },
        plan: { ...payload.plan!, reversible: true },
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      }),
    );
    rendered(project);
    const card = (await screen.findByRole('link', { name: 'AC-1' })).closest('article')!;
    expect(within(card).getByRole('link', { name: 'AC-1' }).closest('p')?.textContent).toBe(
      t('operator.approval.messageExactTask', { key: 'AC-1' }),
    );
    expect(within(card).queryAllByRole('region')).toHaveLength(0);
    expect(within(card).getByText(payload.plan!.why)).toBeTruthy();
    expect(within(card).getByText(payload.plan!.impact)).toBeTruthy();
    expect(within(card).getByText(t('operator.approval.reversibleNo'))).toBeTruthy();
    expect(within(card).getByText(t('operator.approval.guest'))).toBeTruthy();
    expect(
      within(card).getByText((_, node) => node?.textContent === text && node.children.length === 0),
    ).toBeTruthy();
    expect(within(card).getByText(t('operator.approval.expiresSoon', { minutes: 30 }))).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: t('operator.approval.send') }));
    await waitFor(() =>
      expect(posted(project, '/inbox/inb_stp_message/resolve')[0]?.body).toEqual({ optionId: 'approve' }),
    );
  });

  it('uses the shared timestamp format and hides the deadline once it passed before the sweep', async () => {
    const project = mockProject();
    const future = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    project.backend.inbox.push(
      approvalItem('stp_future', { ...operatorMessageApprovalFixture(), expiresAt: future }),
      approvalItem('stp_past', { ...operatorMessageApprovalFixture(), expiresAt: past }),
    );
    rendered(project);
    const expected = t('operator.approval.expires', { time: formatStamp(future) });
    expect(
      await screen.findByText((_, node) => node?.tagName === 'TIME' && node.textContent === expected),
    ).toBeTruthy();
    expect(screen.queryByText(t('operator.approval.expiresSoon', { minutes: 0 }))).toBeNull();
    expect(document.querySelector(`time[datetime="${past}"]`)).toBeNull();
  });

  it('offers only dismissal for an expired message proposal, with no deadline', async () => {
    const project = mockProject();
    project.backend.inbox.push(
      approvalItem('stp_message', {
        ...operatorMessageApprovalFixture(),
        stale: { reason: 'expired', at: new Date().toISOString() },
      }),
    );
    rendered(project);
    const card = (await screen.findByText(t('operator.approval.staleReasons.expired'))).closest('article')!;
    expect(within(card).getByRole('button', { name: t('operator.approval.ok') })).toBeTruthy();
    expect(within(card).queryByRole('button', { name: t('operator.approval.send') })).toBeNull();
    expect(
      card.querySelector('time[datetime="' + operatorMessageApprovalFixture().expiresAt + '"]'),
    ).toBeNull();
  });

  it('shows the request, what changes and the consequence, and approves', async () => {
    const project = mockProject();
    project.backend.inbox.push(approvalItem('stp_1'));
    rendered(project);
    const card = (
      await screen.findByText(t('operator.approval.asked', { quote: 'Adj a fejlesztőnek több jogot' }))
    ).closest('article')!;
    expect(within(card).getByText('bypassPermissions')).toBeTruthy();
    expect(within(card).getByText(t('operator.approval.consequences.permission_mode'))).toBeTruthy();
    expect(within(card).getByRole('button', { name: t('operator.approval.reject') })).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: t('operator.approval.approve') }));
    await waitFor(() =>
      expect(posted(project, '/inbox/inb_stp_1/resolve')[0]?.body).toEqual({ optionId: 'approve' }),
    );
  });

  it('names the stop and the pause in the button', async () => {
    const project = mockProject();
    project.backend.inbox.push(
      approvalItem('stp_1', {
        action: 'session_stop',
        operation: { op: 'session_stop', sessionId: 'ses_x' },
        changes: [],
        consequence: 'session_stop',
      }),
      approvalItem('stp_2', {
        action: 'project_pause',
        operation: { op: 'project_pause' },
        changes: [],
        consequence: 'project_pause',
      }),
    );
    rendered(project);
    expect(await screen.findByRole('button', { name: t('operator.approval.stop') })).toBeTruthy();
    expect(screen.getByRole('button', { name: t('operator.approval.pause') })).toBeTruthy();
  });

  it('rejects without changing anything', async () => {
    const project = mockProject();
    project.backend.inbox.push(approvalItem('stp_1'));
    rendered(project);
    fireEvent.click(await screen.findByRole('button', { name: t('operator.approval.reject') }));
    await waitFor(() =>
      expect(posted(project, '/inbox/inb_stp_1/resolve')[0]?.body).toEqual({ optionId: 'reject' }),
    );
  });

  it('folds the rows past the third behind a "+N" button', async () => {
    const project = mockProject();
    const rows = ['model', 'effort', 'capacity', 'onLeave', 'schedule'].map((field): ConfigChangeRow => ({
      ...CHANGE,
      field,
    }));
    project.backend.inbox.push(approvalItem('stp_1', { changes: rows }));
    rendered(project);
    const more = await screen.findByRole('button', { name: t('operator.approval.more', { count: 2 }) });
    expect(screen.queryByText(t('operator.change.fields.onLeave'))).toBeNull();
    fireEvent.click(more);
    expect(screen.getByText(t('operator.change.fields.onLeave'))).toBeTruthy();
    expect(screen.getByRole('button', { name: t('operator.approval.less') })).toBeTruthy();
  });

  it('names the changes in Hungarian: the area, the member by name, yes/no, and JSON cut short in mono', async () => {
    const project = mockProject();
    const json = JSON.stringify({ aaaa: 'x'.repeat(80) });
    project.backend.inbox.push(
      approvalItem('stp_1', {
        changes: [
          { ...CHANGE, field: 'onLeave', before: 'false', after: 'true' },
          { ...CHANGE, area: 'role', target: 'qa', field: 'override.*', before: null, after: 'qa' },
          { ...CHANGE, area: 'project', target: null, field: 'mysteryKey', before: null, after: json },
        ],
      }),
    );
    rendered(project);
    const changes = await screen.findByRole('region', { name: t('operator.approval.changes') });
    const text = changes.textContent ?? '';
    expect(text).toContain(t('operator.change.areas.member'));
    expect(text).toContain('Általános fejlesztő');
    expect(text).not.toContain('dev-1');
    expect(text).toContain(t('operator.change.yes'));
    expect(text).toContain(t('operator.change.no'));
    expect(text).toContain(`${t('operator.change.prefixes.override')}`);
    expect(text).not.toContain('*');
    const cut = within(changes).getByTitle(json);
    expect(cut.textContent?.endsWith('…')).toBe(true);
    expect(cut.className).toMatch(/mono/);
  });

  it('turns stale when the configuration moved on: the reason on the card, only "Rendben" left, and no toast', async () => {
    const project = mockProject();
    project.backend.inbox.push(approvalItem('stp_1', { baseVersion: 'old0001' }));
    rendered(project);
    const card = (
      await screen.findByText(t('operator.approval.asked', { quote: 'Adj a fejlesztőnek több jogot' }))
    ).closest('article')!;
    fireEvent.click(within(card).getByRole('button', { name: t('operator.approval.approve') }));
    const alert = await within(card).findByRole('alert');
    expect(alert.textContent).toContain(t('operator.approval.staleReasons.config_changed'));
    expect(await within(card).findByRole('button', { name: t('operator.approval.ok') })).toBeTruthy();
    expect(within(card).queryByRole('button', { name: t('operator.approval.approve') })).toBeNull();
    // "Rendben" closes it.
    fireEvent.click(within(card).getByRole('button', { name: t('operator.approval.ok') }));
    await waitFor(() =>
      expect(posted(project, '/inbox/inb_stp_1/resolve').at(-1)?.body).toEqual({ optionId: 'dismiss' }),
    );
  });

  it('shows a proposal that was stale already with its reason and "Rendben" only', async () => {
    const project = mockProject();
    project.backend.inbox.push(
      approvalItem('stp_1', { stale: { reason: 'session_changed', at: '2026-10-10T10:00:00.000Z' } }),
    );
    rendered(project);
    expect(
      await screen.findByText(t('operator.approval.staleReasons.session_changed'), { exact: false }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: t('operator.approval.ok') })).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('operator.approval.reject') })).toBeNull();
  });
});

describe('the Operator in the history of the settings', () => {
  it('shows the Operator as the author, who approved and the request it came from', async () => {
    const project = mockProject();
    const quote = 'A szövegíró legyen Sonnet, mert a jelenlegi túl lassú';
    project.render(
      <HistorySection
        current="abc1234"
        canRevert
        history={[
          {
            version: 'abc1234',
            message: 'Szövegíró: Sonnet',
            author: 'Operátor',
            at: '2026-10-10T09:00:00.000Z',
            operator: 'operator',
            request: quote,
            approvedBy: 'owner',
          },
          { version: 'def5678', message: 'Régi mentés', author: 'Te', at: '2026-10-09T09:00:00.000Z' },
        ]}
      />,
    );
    expect(await screen.findByText(new RegExp(`^${operatorName(project)} ·`))).toBeTruthy();
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
    const openOperator = vi.fn();
    project.render(
      <Routes>
        <Route path="/p/:key/tasks/:taskKey" element={<TaskDrawer />} />
      </Routes>,
      '/p/AC/tasks/AC-20',
      { openOperator },
    );
    fireEvent.click(await button());
    expect(openOperator).toHaveBeenCalledTimes(1);
  });

  it('opens the panel from the profile instead of starting a second conversation', async () => {
    const project = mockProject();
    const openOperator = vi.fn();
    project.render(
      <Routes>
        <Route path="/team/:handle" element={<MemberProfilePage />} />
      </Routes>,
      '/team/operator',
      { openOperator },
    );
    fireEvent.click(await screen.findByRole('button', { name: t('profile.conversation') }));
    expect(openOperator).toHaveBeenCalledTimes(1);
    expect(project.requests.some((r) => r.path.endsWith('/conversation'))).toBe(false);
  });
});

describe('the built-in Operator in the team', () => {
  it('has a built-in chip, and a menu with no leave and no retire', async () => {
    const project = mockProject();
    project.render(<TeamPage />);
    const name = operatorName(project);
    const row = (await screen.findByRole('link', { name })).closest('tr')!;
    expect(within(row).getByText(t('operator.builtIn.chip'))).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: t('team.moreFor', { name }) }));
    expect(within(row).getByRole('button', { name: t('operator.builtIn.editMember') })).toBeTruthy();
    expect(within(row).queryByRole('button', { name: /Szabadság|Visszahív/ })).toBeNull();
    expect(
      within(row).queryByRole('button', { name: t('team.retireMember', { name, handle: 'operator' }) }),
    ).toBeNull();
  });

  it('edits only the provider, the model and the effort', async () => {
    const project = mockProject();
    project.render(<TeamPage />);
    const name = operatorName(project);
    const row = (await screen.findByRole('link', { name })).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: t('team.moreFor', { name }) }));
    fireEvent.click(within(row).getByRole('button', { name: t('operator.builtIn.editMember') }));
    const dialog = await screen.findByRole('dialog', { name: t('operator.builtIn.editTitle') });
    expect(within(dialog).getByText(t('operator.builtIn.editLead'))).toBeTruthy();
    expect(within(dialog).getByText(t('operator.builtIn.roleValue'))).toBeTruthy();
    expect(within(dialog).queryByLabelText(t('hire.displayName'))).toBeNull();
    expect(within(dialog).queryByLabelText(t('memberEdit.instructions'))).toBeNull();
  });

  it('is not offered when hiring', async () => {
    const project = mockProject();
    project.render(<TeamPage />);
    fireEvent.click(await screen.findByRole('button', { name: t('team.hire') }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText(t('hire.roles'));
    expect(within(dialog).queryByRole('radio', { name: new RegExp(t('operator.name')) })).toBeNull();
  });
});
