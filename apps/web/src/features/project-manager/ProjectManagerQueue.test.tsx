import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { MeContext } from '../../app/contexts';
import { ProjectLayout } from '../../app/ProjectLayout';
import { ToastProvider } from '../../components/Toast';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { minutesAgo, queueItem } from '../../test/workQueueItems';
import { TeamPage } from '../team/TeamPage';

/**
 * The project manager's queue in the corner (PM-890, PM-1042, PM-1297), against the fake backend: the count on the
 * button, the strip in the panel, and the way to the work queues view and back to the conversation.
 */
afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

type Project = ReturnType<typeof mockProject>;
type Access = 'owner' | 'developer' | 'client';

const ago = minutesAgo;
const item = queueItem;

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
            <Route path="team" element={<TeamPage />} />
          </Route>
        </Routes>
      </MeContext.Provider>
    </ToastProvider>,
    '/p/AC',
  );
}

const button = () =>
  screen.findByRole('button', { name: new RegExp(`^${t('operator.button.aria', { status: '' })}`) });
const queueLink = () => screen.findByRole('link', { name: t('operator.queue.strip.label') });
const composer = () => screen.findByRole('textbox', { name: t('operator.composer.label' as const) });

describe('the project manager button with a queue', () => {
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

describe('the strip and the queue icon in the panel', () => {
  it('names the item in work and how many more wait, and opens the filtered work queues', async () => {
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
    const heading = await screen.findByRole('heading', { name: t('workQueues.title') });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      (screen.getByRole('combobox', { name: t('workQueues.queueFilter') }) as HTMLSelectElement).value,
    ).toBe('member:pm');
    expect(await screen.findByText('Állítsd át a szövegírót')).toBeTruthy();
  });

  it('is not there for an empty queue', async () => {
    const project = mockProject();
    renderLayout(project);
    fireEvent.click(await button());
    await queueLink();
    expect(screen.queryByTestId('operator-queue-strip')).toBeNull();
  });

  it('links the icon to the project manager queue of the Team page', async () => {
    const project = mockProject();
    renderLayout(project, { viewer: 'kata', access: 'developer' });
    fireEvent.click(await button());
    const link = await queueLink();
    expect(link.getAttribute('href')).toBe('/p/AC/team?view=queues&queue=member:pm');
    expect(link.getAttribute('aria-pressed')).toBeNull();
  });

  it('is not offered to a person without developer access', async () => {
    const project = mockProject();
    project.backend.queueItems = [item({ id: 'q1' })];
    renderLayout(project, { viewer: 'kata', access: 'client' });
    fireEvent.click(await button());
    await composer();
    expect(screen.queryByRole('link', { name: t('operator.queue.strip.label') })).toBeNull();
    expect(screen.queryByTestId('operator-queue-strip')).toBeNull();
  });
});

describe('the way back to the conversation', () => {
  it('reopens the panel on the same page with the draft kept and the caret at its end', async () => {
    const project = mockProject();
    renderLayout(project);
    fireEvent.click(await button());
    fireEvent.change(await composer(), { target: { value: 'Félkész üzenet' } });
    fireEvent.click(await queueLink());
    await screen.findByRole('heading', { name: t('workQueues.title') });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: t('workQueues.back') }));
    const box = (await composer()) as HTMLTextAreaElement;
    expect(box.value).toBe('Félkész üzenet');
    await waitFor(() => expect(document.activeElement).toBe(box));
    expect(box.selectionStart).toBe(box.value.length);
    expect(screen.getByText('board')).toBeTruthy();
  });

  it('shows the back link only when the person came from the panel', async () => {
    const project = mockProject();
    renderLayout(project);
    fireEvent.click(await button());
    fireEvent.click(await queueLink());
    await screen.findByRole('heading', { name: t('workQueues.title') });
    expect(screen.getByRole('link', { name: t('workQueues.back') })).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: t('workQueues.tabs.members') }));
    await screen.findByRole('heading', { name: t('team.title') });
    expect(screen.queryByRole('link', { name: t('workQueues.back') })).toBeNull();
  });
});
