import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { act } from 'react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyServerEvent } from '../../api/cache';
import { setFetchImplementation } from '../../api/client';
import { MeContext } from '../../app/contexts';
import { ProjectLayout } from '../../app/ProjectLayout';
import { ToastProvider } from '../../components/Toast';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { BoardPage } from '../board/BoardPage';
import { TaskDrawer } from '../board/TaskDrawer';
import { TeamPage } from '../team/TeamPage';
import { SessionPage } from '../session/SessionPage';
import { CreateProjectPage } from '../projects/CreateProjectPage';

/**
 * The team pause in the UI (PM-220), against the fake backend: the Szünet button, the bar with its
 * progress, the force and the resume, the held starts and the instance's own bar. A live update is the
 * backend's pause view pushed through the cache like the websocket does.
 */
afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

type Project = ReturnType<typeof mockProject>;
type Access = 'owner' | 'admin' | 'developer' | 'viewer';

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

function Page() {
  return <output data-testid="page">page</output>;
}

/** The project layout as the app has it, for a viewer with the given access. */
function app(project: Project, access: Access = 'owner') {
  const me = {
    ...project.context.me,
    projects: [{ key: 'AC', name: 'Acme webshop', access, roles: [] }],
  };
  return (
    <MeContext.Provider value={me}>
      <ToastProvider>
        <Routes>
          <Route path="/p/:projectKey" element={<ProjectLayout />}>
            <Route index element={<Page />} />
            <Route path="tasks/:taskKey" element={<TaskDrawer />} />
            <Route path="sessions/:sessionId" element={<SessionPage />} />
          </Route>
        </Routes>
      </ToastProvider>
    </MeContext.Provider>
  );
}

type View = ReturnType<Project['render']>;

/** The pause the backend holds reaches the open page, as the websocket's `pause_changed` does. */
function publish(view: View, project: Project) {
  act(() => {
    applyServerEvent(view.client, {
      type: 'pause_changed',
      projectKey: 'AC',
      pause: project.backend.pauses.projectView(),
    });
  });
}

const pausePosts = (project: Project) =>
  project.requests.filter((request) => request.method === 'POST' && /\/pause(\/\w+)?$/.test(request.path));

const barTexts = [
  t('pause.banner.pausing'),
  t('pause.banner.paused'),
  t('pause.banner.instancePaused'),
  t('pause.banner.shutdown'),
];
/** The bar's status line (the page has other status regions, such as loading texts). */
const barNow = () =>
  screen
    .queryAllByRole('status')
    .find((element) => barTexts.some((text) => element.textContent?.includes(text))) ?? null;
const bar = () =>
  waitFor(() => {
    const element = barNow();
    if (!element) throw new Error('no pause bar');
    return element;
  });
/** Every session that still runs in an open pause reaches a safe point (the fixtures have several). */
function settleAll(project: Project) {
  const { project: own, instance } = project.backend.pauses.projectView();
  for (const pause of [own, instance])
    for (const row of pause?.sessions ?? [])
      if (row.point === null) project.backend.pauses.settle(row.sessionId, 'after_tool', 'Bash');
}

/** How many sessions the open project pause holds, and how many of them have stopped. */
function counts(project: Project) {
  const rows = project.backend.pauses.projectView().project!.sessions;
  return { done: rows.filter((row) => row.point !== null).length, total: rows.length };
}

const developer = 'Backend fejlesztő';
const pausingTitle = t('pause.progress.pausingTitle', { clock: '' }).split('·')[0]!.trim();

/** Asks for the pause through the top bar's button and the confirm dialog. */
async function requestPause() {
  fireEvent.click(await screen.findByRole('button', { name: t('pause.button') }));
  const dialog = within(await screen.findByRole('dialog', { name: t('pause.confirm.title') }));
  fireEvent.click(dialog.getByRole('button', { name: t('pause.confirm.submit') }));
}

describe('who may pause', () => {
  it.each<Access>(['owner', 'admin'])('offers the Szünet button to %s', async (access) => {
    const project = mockProject();
    project.render(app(project, access), '/p/AC');
    expect(await screen.findByRole('button', { name: t('pause.button') })).toBeTruthy();
  });

  it('has the pause in the account menu on a desktop too, at every width', async () => {
    const project = mockProject();
    project.render(app(project, 'owner'), '/p/AC');
    const account = await screen.findByRole('button', { name: /^Fiók/ });
    fireEvent.click(account);
    const row = await screen.findByRole('button', { name: t('pause.menuItem') });
    // The rail scrolls and would clip the menu: it is placed against the window, beside the trigger.
    const panel = document.getElementById(account.getAttribute('aria-controls')!)!;
    expect(panel.style.left).not.toBe('');
    expect(panel.style.bottom).not.toBe('');
    fireEvent.click(row);
    expect(await screen.findByRole('dialog', { name: t('pause.confirm.title') })).toBeTruthy();
  });

  it('takes the account menu row away while a pause is open', async () => {
    const project = mockProject();
    project.backend.pauses.pauseProject();
    project.render(app(project, 'owner'), '/p/AC');
    await bar();
    fireEvent.click(await screen.findByRole('button', { name: /^Fiók/ }));
    await screen.findByText(t('common.logout'));
    expect(screen.queryByRole('button', { name: t('pause.menuItem') })).toBeNull();
  });

  it.each<Access>(['developer', 'viewer'])('does not offer it to %s', async (access) => {
    const project = mockProject();
    project.render(app(project, access), '/p/AC');
    await screen.findByText('Acme webshop');
    await screen.findByTestId('page');
    expect(screen.queryByRole('button', { name: t('pause.button') })).toBeNull();
  });

  it('shows a viewer who cannot resume the bar without Folytatás and without Megállítás most', async () => {
    const project = mockProject();
    project.backend.pauses.pauseProject();
    project.render(app(project, 'developer'), '/p/AC');
    expect(await bar()).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('pause.banner.details') }));
    expect(await screen.findByText(pausingTitle, { exact: false })).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('pause.banner.resume') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('pause.force.button') })).toBeNull();
  });
});

describe('asking for the pause', () => {
  it('asks first, sends the request, then shows the progress and, when all stopped, the bar', async () => {
    const project = mockProject();
    const view = project.render(app(project), '/p/AC');

    await requestPause();

    await waitFor(() =>
      expect(pausePosts(project).map((request) => request.path)).toEqual(['/api/projects/AC/pause']),
    );
    // The bar says it is stopping, the details open by themselves with who still runs.
    const status = await bar();
    expect(status.textContent).toContain(t('pause.banner.pausing'));
    expect(status.textContent).toContain(t('pause.banner.stoppedCount', counts(project)));
    expect(await screen.findByText(pausingTitle, { exact: false })).toBeTruthy();
    const running = screen.getByRole('list', { name: t('pause.progress.table') });
    expect(within(running).getByText(developer)).toBeTruthy();
    expect(
      within(running).getAllByText(t('pause.progress.stillRunning', { tool: 'Parancs' }), { exact: false })
        .length,
    ).toBeGreaterThan(0);

    // The last sessions stop: the bar and the details turn to "paused".
    act(() => settleAll(project));
    publish(view, project);
    await waitFor(() => expect(barNow()?.textContent).toContain(t('pause.banner.paused')));
    expect(barNow()?.textContent).toContain(project.backend.user.name);
    expect(await screen.findByText(t('pause.toast.allStopped'))).toBeTruthy();
    expect(screen.getByRole('heading', { name: t('pause.progress.pausedTitle') })).toBeTruthy();
    expect(
      screen.getAllByText(t('session.pausePoint.after_tool', { tool: 'Parancs' })).length,
    ).toBeGreaterThan(0);
    // The button is gone while a pause is open.
    expect(screen.queryByRole('button', { name: t('pause.button') })).toBeNull();
  });

  it('says so in the dialog and keeps it open when the server refuses', async () => {
    const project = mockProject();
    setFetchImplementation(async (path, init) => {
      if (init?.method === 'POST' && String(path).endsWith('/pause'))
        return new Response(JSON.stringify({ error: { code: 'insufficient_access', message: 'no' } }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        });
      return (await import('../../test/mockProject')).createMockFetch(project.backend)(String(path), init);
    });
    project.render(app(project), '/p/AC');

    await requestPause();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(t('errors.codes.insufficient_access'));
    expect(screen.getByText(t('errors.details'))).toBeTruthy();
    // Still open, and Mégse closes it.
    fireEvent.click(screen.getByRole('button', { name: t('pause.confirm.cancel') }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('the details and the page', () => {
  it('closes the details when a link in them leads to another page', async () => {
    const project = mockProject();
    project.backend.pauses.pauseProject();
    project.render(app(project), '/p/AC');
    const details = await screen.findByRole('button', { name: t('pause.banner.details') });
    fireEvent.click(details);
    expect(details.getAttribute('aria-expanded')).toBe('true');
    const list = await screen.findByRole('list', { name: t('pause.progress.table') });
    fireEvent.click(within(list).getAllByRole('link')[0]!);
    await waitFor(() => expect(screen.queryByRole('list', { name: t('pause.progress.table') })).toBeNull());
    expect(
      screen.getByRole('button', { name: t('pause.banner.details') }).getAttribute('aria-expanded'),
    ).toBe('false');
  });

  it.each([
    ['the board', '/p/AC'],
    ['the team page', '/p/AC/team'],
  ])('opens the details on the first click on %s, a while after it loaded', async (_name, path) => {
    const project = mockProject();
    project.backend.pauses.pauseProject();
    const me = {
      ...project.context.me,
      projects: [{ key: 'AC', name: 'Acme webshop', access: 'owner' as const, roles: [] }],
    };
    project.render(
      <MeContext.Provider value={me}>
        <ToastProvider>
          <Routes>
            <Route path="/p/:projectKey" element={<ProjectLayout />}>
              <Route index element={<BoardPage />} />
              <Route path="team" element={<TeamPage />} />
            </Route>
          </Routes>
        </ToastProvider>
      </MeContext.Provider>,
      path,
    );
    const details = await screen.findByRole('button', { name: t('pause.banner.details') });
    await new Promise((resolve) => setTimeout(resolve, 600));
    fireEvent.click(details);
    expect(
      screen.getByRole('button', { name: t('pause.banner.details') }).getAttribute('aria-expanded'),
    ).toBe('true');
    expect(await screen.findByRole('list', { name: t('pause.progress.table') })).toBeTruthy();
  });
});

describe('Megállítás most', () => {
  async function pausing() {
    const project = mockProject();
    project.backend.pauses.pauseProject();
    const view = project.render(app(project), '/p/AC');
    fireEvent.click(await screen.findByRole('button', { name: t('pause.banner.details') }));
    return { project, view };
  }

  it('asks, then sends the force request and shows the stopped session', async () => {
    const { project, view } = await pausing();
    expect(screen.getByText(t('pause.force.hint'))).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: t('pause.force.button') }));
    const dialog = within(await screen.findByRole('dialog', { name: t('pause.force.title') }));
    expect(dialog.getByText(t('pause.force.body'))).toBeTruthy();
    expect(pausePosts(project)).toHaveLength(0);
    fireEvent.click(dialog.getByRole('button', { name: t('pause.force.button') }));

    await waitFor(() =>
      expect(pausePosts(project).map((request) => request.path)).toEqual(['/api/projects/AC/pause/force']),
    );
    publish(view, project);
    await waitFor(() => expect(barNow()?.textContent).toContain(t('pause.banner.paused')));
    expect(
      screen.getAllByText(t('session.pausePoint.interrupted', { tool: 'Parancs' })).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: t('pause.force.button') })).toBeNull();
  });

  it('offers nothing to cut once everyone has stopped', async () => {
    const project = mockProject();
    project.backend.pauses.pauseProject();
    settleAll(project);
    project.render(app(project), '/p/AC');
    fireEvent.click(await screen.findByRole('button', { name: t('pause.banner.details') }));
    await screen.findByRole('heading', { name: t('pause.progress.pausedTitle') });
    expect(screen.queryByRole('button', { name: t('pause.force.button') })).toBeNull();
  });
});

describe('the resume', () => {
  it('lifts the bar, says so, and gives back the Szünet button', async () => {
    const project = mockProject();
    project.backend.pauses.pauseProject();
    const view = project.render(app(project), '/p/AC');
    fireEvent.click(await screen.findByRole('button', { name: t('pause.banner.resume') }));

    await waitFor(() =>
      expect(pausePosts(project).map((request) => request.path)).toEqual(['/api/projects/AC/pause/resume']),
    );
    await waitFor(() => expect(barNow()).toBeNull());
    expect(await screen.findByText(t('pause.toast.resumed'))).toBeTruthy();
    expect(screen.getByRole('button', { name: t('pause.button') })).toBeTruthy();
    publish(view, project);
    expect(barNow()).toBeNull();
  });

  it('says so when the resume fails and leaves the bar', async () => {
    const project = mockProject();
    project.backend.pauses.pauseProject();
    const fetch = (await import('../../test/mockProject')).createMockFetch(project.backend);
    setFetchImplementation(async (path, init) =>
      init?.method === 'POST' && String(path).endsWith('/resume')
        ? new Response(JSON.stringify({ error: { code: 'internal', message: 'x' } }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          })
        : fetch(String(path), init),
    );
    project.render(app(project), '/p/AC');
    fireEvent.click(await screen.findByRole('button', { name: t('pause.banner.resume') }));
    expect(await screen.findByText(t('pause.toast.resumeFailed'))).toBeTruthy();
    expect(barNow()).toBeTruthy();
  });

  it('follows a resume somebody else made, delivered as pause_changed', async () => {
    const project = mockProject();
    project.backend.pauses.pauseProject();
    const view = project.render(app(project), '/p/AC');
    await bar();
    act(() => project.backend.pauses.resume('project'));
    publish(view, project);
    await waitFor(() => expect(barNow()).toBeNull());
  });
});

describe('the instance pause', () => {
  it('has its own bar with the reason, and Folytatás for an owner of every project', async () => {
    const project = mockProject();
    project.backend.pauses.pauseInstance({ source: 'control', reason: 'deploy' });
    settleAll(project);
    project.render(app(project), '/p/AC');

    const status = await bar();
    expect(status.textContent).toContain(t('pause.banner.instancePaused'));
    expect(status.textContent).toContain(t('pause.reason.deploy'));
    fireEvent.click(await screen.findByRole('button', { name: t('pause.banner.resume') }));
    await waitFor(() =>
      expect(pausePosts(project).map((request) => request.path)).toEqual(['/api/pause/resume']),
    );
    await waitFor(() => expect(barNow()).toBeNull());
    expect(screen.getByRole('button', { name: t('pause.button') })).toBeTruthy();
  });

  it('has no Folytatás where the viewer may not manage the instance', async () => {
    const project = mockProject();
    project.backend.pauses.pauseInstance({ source: 'control', reason: 'deploy' });
    settleAll(project);
    // The server says the viewer is not an owner of every project.
    const fetch = (await import('../../test/mockProject')).createMockFetch(project.backend);
    let asked = false;
    setFetchImplementation(async (path, init) => {
      if (!String(path).endsWith('/api/pause') || (init?.method ?? 'GET') !== 'GET')
        return fetch(String(path), init);
      asked = true;
      return new Response(JSON.stringify({ ...project.backend.pauses.instanceView(), canManage: false }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    project.render(app(project, 'admin'), '/p/AC');
    await bar();
    // The answer carries the right to resume: wait for it, then the button stays away.
    await waitFor(() => expect(asked).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('button', { name: t('pause.banner.resume') })).toBeNull();
  });

  it('shows the instance bar when both pauses are open, with the project pause lifted from the details', async () => {
    const project = mockProject();
    project.backend.pauses.pauseProject();
    project.backend.pauses.pauseInstance({ source: 'control', reason: 'deploy' });
    project.render(app(project), '/p/AC');

    const status = await bar();
    expect(status.textContent).toContain(t('pause.banner.instancePaused'));
    fireEvent.click(screen.getByRole('button', { name: t('pause.banner.details') }));
    const row = (await screen.findByText(/A projekt szünete is áll/)).closest('p')!;
    fireEvent.click(within(row).getByRole('button', { name: t('pause.progress.lift') }));
    await waitFor(() =>
      expect(pausePosts(project).map((request) => request.path)).toContain('/api/projects/AC/pause/resume'),
    );
    // The instance's pause stays.
    await waitFor(() => expect(screen.queryByText(/A projekt szünete is áll/)).toBeNull());
    expect(barNow()?.textContent).toContain(t('pause.banner.instancePaused'));
  });

  it('says the server restarts, with no Folytatás', async () => {
    const project = mockProject();
    project.backend.pauses.pauseInstance({ kind: 'shutdown', source: 'system' });
    project.render(app(project), '/p/AC');
    const status = await bar();
    expect(status.textContent).toContain(t('pause.banner.shutdown'));
    expect(status.textContent).toContain(t('pause.banner.shutdownMeta'));
    expect(screen.getByRole('button', { name: t('pause.banner.details') })).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('pause.banner.resume') })).toBeNull();
  });

  it('shows the bar on the create-project page too', async () => {
    const project = mockProject();
    project.backend.pauses.pauseInstance({ source: 'control', reason: 'deploy' });
    settleAll(project);
    project.render(
      <MeContext.Provider value={project.context.me}>
        <CreateProjectPage />
      </MeContext.Provider>,
      '/projects/new',
    );
    const status = await bar();
    expect(status.textContent).toContain(t('pause.banner.instancePaused'));
    expect(await screen.findByRole('button', { name: t('pause.banner.resume') })).toBeTruthy();
  });
});

describe('what the pause holds back', () => {
  it('disables Indítás with an explanation in view, and enables it after the resume', async () => {
    const project = mockProject();
    project.backend.pauses.pauseProject();
    const view = project.render(app(project), '/p/AC/tasks/AC-24');

    const start = await screen.findByRole('button', { name: t('task.start') });
    expect(start.getAttribute('aria-disabled')).toBe('true');
    expect(start.getAttribute('title')).toBe(t('pause.disabled.start'));
    // The reason is on the screen, not only in a tooltip, and the button points at it.
    const note = screen.getByText(t('pause.disabled.start'));
    expect(start.getAttribute('aria-describedby')).toBe(note.closest('p')!.id);
    fireEvent.click(start);
    expect(project.requests.some((request) => request.path.endsWith('/start'))).toBe(false);

    act(() => project.backend.pauses.resume('project'));
    publish(view, project);
    await waitFor(() => expect(screen.queryByText(t('pause.disabled.start'))).toBeNull());
    const again = screen.getByRole('button', { name: t('task.start') });
    expect(again.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(again);
    await waitFor(() =>
      expect(project.requests.some((request) => request.path.endsWith('/start'))).toBe(true),
    );
  });

  it('tells in the composer that the message waits for the resume', async () => {
    const project = mockProject();
    project.backend.pauses.pauseProject();
    project.render(app(project), '/p/AC/sessions/ses_ac20_be1');
    expect(await screen.findByText(t('session.composer.pausedLive'))).toBeTruthy();
    const input = screen.getByRole('textbox');
    expect(input.getAttribute('aria-describedby')).toBeTruthy();
  });
});

describe('on a phone', () => {
  it('has the pause in the account menu, not in the top bar', async () => {
    phone();
    const project = mockProject();
    project.render(app(project), '/p/AC');
    expect(screen.queryByRole('button', { name: t('pause.button') })).toBeNull();
    const account = await screen.findByRole('button', { name: /^Fiók/ });
    fireEvent.click(account);
    fireEvent.click(await screen.findByRole('button', { name: t('pause.menuItem') }));
    expect(await screen.findByRole('dialog', { name: t('pause.confirm.title') })).toBeTruthy();
  });

  it('keeps the row away from a viewer who may not pause', async () => {
    phone();
    const project = mockProject();
    project.render(app(project, 'developer'), '/p/AC');
    fireEvent.click(await screen.findByRole('button', { name: /^Fiók/ }));
    await screen.findByText(t('common.logout'));
    expect(screen.queryByRole('button', { name: t('pause.menuItem') })).toBeNull();
  });

  it('makes the whole bar a button that opens the details as a sheet with a full-width Folytatás', async () => {
    phone();
    const project = mockProject();
    project.backend.pauses.pauseProject();
    project.render(app(project), '/p/AC');

    const trigger = await screen.findByRole('button', { name: t('pause.banner.detailsOpen') });
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    fireEvent.click(trigger);
    const sheet = within(await screen.findByRole('dialog'));
    expect(sheet.getByText(pausingTitle, { exact: false })).toBeTruthy();
    expect(sheet.getAllByRole('button', { name: t('pause.banner.close') }).length).toBeGreaterThan(0);
    fireEvent.click(sheet.getByRole('button', { name: t('pause.banner.resume') }));
    await waitFor(() =>
      expect(pausePosts(project).map((request) => request.path)).toEqual(['/api/projects/AC/pause/resume']),
    );
  });
});
