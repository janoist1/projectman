import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MemberQueueItem, Obligation } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { TaskDrawer } from './TaskDrawer';

afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.hash}`}</output>;
}

const card = (
  <>
    <Where />
    <Routes>
      <Route path="/p/:key/tasks/:taskKey/*" element={<TaskDrawer />} />
    </Routes>
  </>
);

type Project = ReturnType<typeof mockProject>;

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const obligation = (patch: Partial<Obligation> = {}): Obligation => ({
  id: 'obl_1',
  projectKey: 'AC',
  taskKey: 'AC-21',
  kind: 'merge',
  responsible: 'pm',
  subject: 'mrg_1',
  openedAt: ago(90),
  dueAt: ago(30),
  pausedSince: null,
  pauseReason: null,
  wokenAt: null,
  pmToldAt: null,
  handedOverAt: null,
  inboxItemId: null,
  state: 'open',
  closedAt: null,
  ...patch,
});

const queueItem = (patch: Partial<MemberQueueItem> = {}): MemberQueueItem => ({
  id: 'mqi_1',
  projectKey: 'AC',
  member: 'pm',
  kind: 'todo',
  source: { type: 'inbox', inboxItemId: 'inb_x' },
  place: { type: 'task', taskKey: 'AC-21' },
  wake: true,
  state: 'processing',
  title: 'A private message text',
  from: 'owner',
  taskKey: 'AC-21',
  queuedAt: ago(20),
  startedAt: ago(10),
  closedAt: null,
  closeReason: null,
  attempts: 0,
  restartedAt: null,
  sessionId: null,
  wait: null,
  outcome: null,
  ...patch,
});

/** Opens the Process view of AC-21; its open permission item of the fixtures is one of the steps. */
async function openSteps(project: Project) {
  project.render(card, '/p/AC/tasks/AC-21/steps');
  return screen.findByRole('heading', { name: new RegExp(`^${t('task.steps.open')}`), level: 3 });
}

/** A section's heading may carry a count after its name. */
const section = (name: string) => screen.getByRole('region', { name: new RegExp(`^${name}`) });

describe('the Process view of the open card (PM-1151)', () => {
  it('shows what waits, with the one who holds it, and the overdue deadline', async () => {
    const project = mockProject();
    project.backend.obligations = [obligation()];
    project.backend.queueItems = [queueItem({ attempts: 1 })];
    await openSteps(project);
    const open = within(section(t('task.steps.open')));
    const rows = open.getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    // The running queue item comes first, on its second attempt; the obligation's deadline has passed.
    expect(within(rows[0]!).getByText(t('task.steps.state.running'))).toBeTruthy();
    expect(within(rows[0]!).getByText(t('task.steps.meta.attempt', { count: 2 }))).toBeTruthy();
    expect(open.getByText(/^lejárt /)).toBeTruthy();
    // The "Most" box names the stage the card stands in.
    expect(within(section(t('task.steps.now'))).getByText(/ · .* óta$/)).toBeTruthy();
    // The message text of the queue item never reaches the view.
    expect(screen.queryByText('A private message text')).toBeNull();
  });

  it('counts the open steps on the tab, and leads an item for the viewer back to the card', async () => {
    const project = mockProject();
    await openSteps(project);
    const tabs = screen.getByRole('group', { name: t('task.view.label') });
    const tab = within(tabs).getByRole('button', { name: new RegExp(`^${t('task.view.steps')}`) });
    expect(within(tab).getByText('1')).toBeTruthy();
    // Nothing ran yet: one dashed line instead of a bare count.
    expect(within(section(t('task.steps.ran'))).getByText(t('task.steps.ranEmpty'))).toBeTruthy();
    expect(screen.queryByText(t('task.steps.ranCount', { count: 0 }))).toBeNull();
    const row = within(section(t('task.steps.open'))).getByRole('link');
    expect(within(row).getByText(t('task.steps.forYou'))).toBeTruthy();
    fireEvent.click(row);
    expect(screen.getByTestId('where').textContent).toBe('/p/AC/tasks/AC-21');
  });

  it('lists what ran newest first, marks the failed and handed-over ones and leaves out other events', async () => {
    const project = mockProject();
    const { backend } = project;
    backend.addTimeline('AC-21', null, 'task_merged', { commit: 'abc12345' }, null, ago(50));
    backend.addTimeline('AC-21', null, 'task_full_test', { outcome: 'failed' }, null, ago(40));
    backend.addTimeline('AC-21', null, 'obligation_handed_over', { kind: 'merge' }, null, ago(30));
    backend.addTimeline('AC-21', null, 'member_queue_item_closed', { reason: 'stale' }, null, ago(20));
    await openSteps(project);
    const ran = within(section(t('task.steps.ran')));
    const rows = ran.getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    // An outcome that is not known (an old or unrecognised close reason) gets no chip.
    for (const outcome of ['ran', 'failed', 'handed_over'] as const)
      expect(within(rows[0]!).queryByText(t(`task.steps.outcome.${outcome}`))).toBeNull();
    expect(within(rows[1]!).getByText(t('task.steps.outcome.handed_over'))).toBeTruthy();
    expect(within(rows[2]!).getByText(t('task.steps.outcome.failed'))).toBeTruthy();
    // A screen reader hears the outcome at the start of the row, too.
    expect(rows[2]!.querySelector('p')?.textContent).toMatch(
      new RegExp(`^${t('task.steps.outcome.failed')}: `),
    );
    expect(within(rows[3]!).getByText(t('task.steps.outcome.ran'))).toBeTruthy();
    expect(ran.getByText(t('task.steps.ranFailed', { count: 1 }))).toBeTruthy();
    expect(ran.getByText(t('task.steps.ranHanded', { count: 1 }))).toBeTruthy();
    // A row leads to its event on the timeline.
    fireEvent.click(within(rows[2]!).getByRole('link', { name: t('task.steps.toTimeline') }));
    expect(screen.getByTestId('where').textContent).toMatch(/^\/p\/AC\/tasks\/AC-21\/timeline#timeline-evt/);
  });

  it('shows the first ten ran rows and the older ones in place', async () => {
    const project = mockProject();
    for (let index = 0; index < 12; index++)
      project.backend.addTimeline('AC-21', null, 'task_merged', {}, null, ago(100 - index));
    await openSteps(project);
    const ran = within(section(t('task.steps.ran')));
    expect(ran.getAllByRole('listitem')).toHaveLength(10);
    fireEvent.click(ran.getByRole('button', { name: t('task.steps.earlier', { count: 2 }) }));
    await waitFor(() => expect(ran.getAllByRole('listitem')).toHaveLength(12));
    expect(ran.queryByRole('button', { name: /^Korábbiak/ })).toBeNull();
  });

  it('says so when nothing ran and nothing is open', async () => {
    const project = mockProject();
    project.backend.inbox = project.backend.inbox.filter((item) => item.taskKey !== 'AC-21');
    project.render(card, '/p/AC/tasks/AC-21/steps');
    expect(await screen.findByText(t('task.steps.firstTitle'))).toBeTruthy();
    // The Now box stays above it: it says what the card waits for.
    expect(section(t('task.steps.now'))).toBeTruthy();
    expect(screen.queryByRole('heading', { name: new RegExp(`^${t('task.steps.open')}`) })).toBeNull();
  });

  it('gives a theme no Process view', async () => {
    const project = mockProject();
    const response = project.backend.handle('POST', '/api/projects/AC/tasks', {
      title: 'Epic',
      kind: 'theme',
    });
    const key = (response.body as { key: string }).key;
    project.render(card, `/p/AC/tasks/${key}/steps`);
    await screen.findByRole('group', { name: t('task.view.label') });
    expect(screen.queryByRole('button', { name: new RegExp(`^${t('task.view.steps')}`) })).toBeNull();
    expect(screen.queryByRole('heading', { name: t('task.steps.title') })).toBeNull();
  });
});
