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
  window.localStorage.clear();
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

/** Opens the Process view of AC-21 (in the fixtures: in QA, after four stage moves, one item waits for the viewer). */
async function openProcess(project: Project, path = '/p/AC/tasks/AC-21/steps') {
  project.render(card, path);
  return screen.findByRole('heading', { name: new RegExp(`^${t('task.story.title')}`), level: 3 });
}

const now = () => screen.getByRole('region', { name: t('task.steps.now') });
const story = () => screen.getByRole('region', { name: new RegExp(`^${t('task.story.title')}`) });
/** The round headers, newest first. */
const rounds = () =>
  within(story())
    .getAllByRole('button')
    .filter((button) => button.hasAttribute('aria-expanded') && button.closest('h4') !== null);
const noiseFolds = () => within(story()).queryAllByRole('button', { name: /rendszer-esemény/ });

describe('the "Most" box of the Process view (PM-1160)', () => {
  it('shows what waits, with the one who holds it, and the overdue deadline', async () => {
    const project = mockProject();
    project.backend.obligations = [obligation()];
    project.backend.queueItems = [queueItem({ attempts: 1 })];
    await openProcess(project);
    const rows = within(now()).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    // The running queue item comes first, on its second attempt; the obligation's deadline has passed.
    expect(within(rows[0]!).getByText(t('task.steps.state.running'))).toBeTruthy();
    expect(within(rows[0]!).getByText(t('task.steps.meta.attempt', { count: 2 }))).toBeTruthy();
    expect(within(now()).getByText(/^lejárt /)).toBeTruthy();
    // The box names the stage and the round the card stands in.
    expect(within(now()).getByText(/, \d+\. kör · .* óta$/)).toBeTruthy();
    // The message text of the queue item never reaches the view.
    expect(screen.queryByText('A private message text')).toBeNull();
  });

  it('counts the open steps on the tab, and leads an item for the viewer to its box on the card', async () => {
    const project = mockProject();
    await openProcess(project);
    const tabs = screen.getByRole('group', { name: t('task.view.label') });
    const tab = within(tabs).getByRole('button', { name: new RegExp(`^${t('task.view.steps')}`) });
    expect(within(tab).getByText('1')).toBeTruthy();
    const row = within(now()).getByRole('link');
    expect(within(row).getByText(t('task.steps.forYou'))).toBeTruthy();
    fireEvent.click(row);
    expect(screen.getByTestId('where').textContent).toMatch(/^\/p\/AC\/tasks\/AC-21#inbox-item-/);
  });

  it('leaves out the list when nothing waits', async () => {
    const project = mockProject();
    project.backend.inbox = project.backend.inbox.filter((item) => item.taskKey !== 'AC-21');
    await openProcess(project);
    expect(within(now()).queryByText(t('task.steps.waitingFor'))).toBeNull();
    expect(within(now()).queryAllByRole('listitem')).toHaveLength(0);
  });
});

describe('the story of the Process view (PM-1160)', () => {
  it('opens the latest round and folds the earlier ones to a line with their outcome', async () => {
    const project = mockProject();
    await openProcess(project);
    const heads = rounds();
    expect(heads.length).toBeGreaterThanOrEqual(4);
    expect(heads[0]!.getAttribute('aria-expanded')).toBe('true');
    expect(heads.slice(1).every((head) => head.getAttribute('aria-expanded') === 'false')).toBe(true);
    expect(heads[0]!.textContent).toContain(t('task.story.outcome.running'));
    // The round before it went on: the chip says where, and the closed round shows a line about it.
    expect(heads[1]!.textContent).toContain(t('task.story.outcome.forward', { stage: '' }).trim());
    const panelId = heads[0]!.getAttribute('aria-controls')!;
    expect(document.getElementById(panelId)).toBeTruthy();
    expect(heads[1]!.getAttribute('aria-controls')).toBeNull();
    fireEvent.click(heads[1]!);
    expect(rounds()[1]!.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(rounds()[1]!.getAttribute('aria-controls')!)).toBeTruthy();
  });

  it('folds the system events into runs, shows them all in the "Minden" view and remembers the choice', async () => {
    const project = mockProject();
    await openProcess(project);
    const before = noiseFolds().length;
    expect(before).toBeGreaterThan(0);
    const choice = within(story()).getByRole('group', { name: t('task.story.viewLabel') });
    fireEvent.click(within(choice).getByRole('button', { name: t('task.story.view.all') }));
    expect(noiseFolds()).toHaveLength(0);
    expect(window.localStorage.getItem('pm:cardStory.view')).toBe('all');
  });

  it('starts in the remembered view', async () => {
    window.localStorage.setItem('pm:cardStory.view', 'all');
    const project = mockProject();
    await openProcess(project);
    expect(noiseFolds()).toHaveLength(0);
    const choice = within(story()).getByRole('group', { name: t('task.story.viewLabel') });
    expect(
      within(choice)
        .getByRole('button', { name: t('task.story.view.all') })
        .getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('opens a noise run in place', async () => {
    const project = mockProject();
    await openProcess(project);
    const folds = noiseFolds().length;
    fireEvent.click(noiseFolds()[0]!);
    // The round shows its system events now, with a way to hide them again.
    expect(noiseFolds()).toHaveLength(0);
    expect(folds).toBeGreaterThan(0);
    fireEvent.click(within(story()).getByRole('button', { name: t('task.story.noiseHide') }));
    expect(noiseFolds()).toHaveLength(folds);
  });

  it('opens the round and the run that hide the event an older link points at', async () => {
    const project = mockProject();
    const hidden = project.backend.timeline.find(
      (event) => event.taskKey === 'AC-21' && event.type === 'session_started',
    )!;
    const reached: string[] = [];
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      reached.push(this.id);
    });
    await openProcess(project, `/p/AC/tasks/AC-21/timeline#timeline-${hidden.id}`);
    await waitFor(() => expect(reached).toContain(`timeline-${hidden.id}`));
    expect(document.getElementById(`timeline-${hidden.id}`)).toBeTruthy();
  });

  it('shows the older rows of a long round in place', async () => {
    const project = mockProject();
    for (let index = 0; index < 32; index++)
      project.backend.addTimeline(
        'AC-21',
        'owner',
        'task_note',
        { text: `Note ${index}` },
        null,
        ago(100 - index),
      );
    await openProcess(project);
    const more = await within(story()).findByRole('button', { name: /^Korábbiak/ });
    fireEvent.click(more);
    expect(within(story()).queryByRole('button', { name: /^Korábbiak/ })).toBeNull();
    expect(within(story()).getByText('Note 0')).toBeTruthy();
  });

  it('helps a card that has no story yet, without the choice of view', async () => {
    const project = mockProject();
    const response = project.backend.handle('POST', '/api/projects/AC/tasks', { title: 'Fresh card' });
    const key = (response.body as { key: string }).key;
    await openProcess(project, `/p/AC/tasks/${key}/steps`);
    expect(await screen.findByText(t('task.story.firstTitle'))).toBeTruthy();
    expect(within(story()).queryByRole('group', { name: t('task.story.viewLabel') })).toBeNull();
  });
});
