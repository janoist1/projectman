import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { MeContext } from '../../app/contexts';
import { ProjectLayout } from '../../app/ProjectLayout';
import { ToastProvider } from '../../components/Toast';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { TaskDrawer } from '../board/TaskDrawer';
import { MemberProfilePage } from '../team/MemberProfilePage';
import { TeamPage } from '../team/TeamPage';

/**
 * The project manager's header button and panel (PM-429), against the fake backend: who sees the
 * button, opening and closing, sending (with the open card as context), the waiting states and
 * the project manager that cannot be retired.
 */
afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

type Project = ReturnType<typeof mockProject>;

function renderLayout(project: Project, route = '/p/AC', access: 'owner' | 'developer' | 'viewer' = 'owner') {
  const me = {
    ...project.context.me,
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

const button = () => screen.findByRole('button', { name: new RegExp(`^${t('pm.panel.label')}`) });
const pmName = (project: Project) => project.backend.findMember('pm')!.displayName;

describe('the project manager button', () => {
  it('shows who can answer in its name, for a viewer who may open cards', async () => {
    const project = mockProject();
    renderLayout(project);
    const pm = await button();
    await waitFor(() =>
      expect(pm.getAttribute('aria-label')).toBe(t('pm.button.aria', { status: t('pm.status.available') })),
    );
    expect(pm.getAttribute('aria-haspopup')).toBe('dialog');
    expect(pm.getAttribute('aria-expanded')).toBe('false');
  });

  it('is not there for a viewer who cannot open cards', async () => {
    const project = mockProject();
    renderLayout(project, '/p/AC', 'viewer');
    await screen.findByText('board');
    expect(screen.queryByRole('button', { name: /Projektmenedzser/ })).toBeNull();
  });
});

describe('the project manager panel', () => {
  it('opens beside the page with the focus in the composer and closes with Escape, back to the button', async () => {
    const project = mockProject();
    renderLayout(project);
    const pm = await button();
    fireEvent.click(pm);
    const panel = await screen.findByRole('dialog', { name: pmName(project) });
    expect(panel.getAttribute('aria-modal')).toBe('false');
    expect(pm.getAttribute('aria-expanded')).toBe('true');
    const composer = await within(panel).findByRole('textbox', { name: t('pm.composer.label') });
    await waitFor(() => expect(document.activeElement).toBe(composer));
    expect(within(panel).getByText(t('pm.intro.title'))).toBeTruthy();

    fireEvent.keyDown(composer, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(pm);
  });

  it('closes with the close button', async () => {
    const project = mockProject();
    renderLayout(project);
    fireEvent.click(await button());
    const panel = await screen.findByRole('dialog');
    fireEvent.click(within(panel).getByRole('button', { name: t('pm.panel.close') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('sends the message to the project manager and shows it in the thread', async () => {
    const project = mockProject();
    renderLayout(project);
    fireEvent.click(await button());
    const composer = await screen.findByRole('textbox', { name: t('pm.composer.label') });
    fireEvent.change(composer, { target: { value: 'Mi az állás?' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => {
      const sent = project.requests.find((r) => r.method === 'POST' && r.path.endsWith('/messages'));
      expect(sent?.body).toEqual({ to: ['pm'], text: 'Mi az állás?' });
    });
    const log = await screen.findByRole('log', { name: t('pm.thread.label') });
    expect(await within(log).findByText('Mi az állás?')).toBeTruthy();
  });

  it('adds the open card as the message context until it is taken off', async () => {
    const project = mockProject();
    renderLayout(project, '/p/AC/tasks/AC-20');
    fireEvent.click(await button());
    const panel = await screen.findByRole('dialog');
    const title = project.backend.tasks.find((task) => task.key === 'AC-20')!.title;
    expect(await within(panel).findByText(t('pm.context.label', { key: 'AC-20', title }))).toBeTruthy();

    const composer = within(panel).getByRole('textbox', { name: t('pm.composer.label') });
    fireEvent.change(composer, { target: { value: 'Nézd meg ezt' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => {
      const sent = project.requests.find((r) => r.method === 'POST' && r.path.endsWith('/messages'));
      expect(sent?.body).toEqual({ to: ['pm'], text: 'Nézd meg ezt', taskKey: 'AC-20' });
    });

    fireEvent.click(within(panel).getByRole('button', { name: t('pm.context.remove') }));
    expect(within(panel).queryByText(t('pm.context.label', { key: 'AC-20', title }))).toBeNull();
  });

  it('keeps a message that did not go out and sends it again', async () => {
    const project = mockProject();
    renderLayout(project);
    fireEvent.click(await button());
    const composer = await screen.findByRole('textbox', { name: t('pm.composer.label') });
    await waitFor(() => expect(document.activeElement).toBe(composer));
    setFetchImplementation(async (input, init) => {
      if (init?.method === 'POST' && String(input).endsWith('/messages'))
        return new Response(JSON.stringify({ error: { code: 'internal', message: 'boom' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      return globalThis.fetch(input, init);
    });
    fireEvent.change(composer, { target: { value: 'Elveszne?' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(await screen.findByText(t('pm.sent.failed'))).toBeTruthy();
    expect(screen.getByText('Elveszne?')).toBeTruthy();
    expect(screen.getByRole('button', { name: t('pm.sent.retry') })).toBeTruthy();
  });

  it('says the project manager is on leave and calls it back from the banner', async () => {
    const project = mockProject();
    project.backend.handle('PATCH', '/api/projects/AC/members/pm', { onLeave: true });
    renderLayout(project);
    fireEvent.click(await button());
    const panel = await screen.findByRole('dialog');
    const banner = await within(panel).findByRole('status');
    expect(banner.textContent).toContain(t('pm.banner.onLeave'));
    expect(banner.textContent).toContain(t('pm.banner.onLeaveText'));
    expect(within(panel).getByText(t('pm.status.onLeave'))).toBeTruthy();
    // No conversation yet: the introduction says the project manager has just arrived.
    expect(within(panel).getByText(t('pm.intro.arrivedTitle'))).toBeTruthy();

    fireEvent.click(within(banner).getByRole('button', { name: t('pm.banner.callBack') }));
    await waitFor(() => expect(project.backend.findMember('pm')!.onLeave).toBeFalsy());
    await waitFor(() => expect(within(panel).getByText(t('pm.status.available'))).toBeTruthy());
  });

  it('tells a viewer who cannot call it back who can', async () => {
    const project = mockProject();
    project.backend.handle('PATCH', '/api/projects/AC/members/pm', { onLeave: true });
    renderLayout(project, '/p/AC', 'developer');
    fireEvent.click(await button());
    expect(await screen.findByText(t('pm.banner.onLeaveOther'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('pm.banner.callBack') })).toBeNull();
  });

  it('introduces itself on first use and puts a picked example into the box', async () => {
    const project = mockProject();
    renderLayout(project);
    fireEvent.click(await button());
    const panel = await screen.findByRole('dialog');
    expect(await within(panel).findByText(t('pm.intro.title'))).toBeTruthy();
    expect(within(panel).getByText(t('pm.intro.lead'))).toBeTruthy();
    for (const point of ['card', 'pass', 'report'] as const)
      expect(within(panel).getByText(t(`pm.intro.points.${point}`))).toBeTruthy();
    expect(within(panel).getByText(t('pm.intro.approval'))).toBeTruthy();

    const composer = within(panel).getByRole<HTMLTextAreaElement>('textbox', {
      name: t('pm.composer.label'),
    });
    fireEvent.click(within(panel).getByRole('button', { name: t('pm.intro.examples.status') }));
    await waitFor(() => expect(composer.value).toBe(t('pm.intro.examples.status')));
    expect(document.activeElement).toBe(composer);
    expect(project.requests.some((r) => r.method === 'POST' && r.path.endsWith('/messages'))).toBe(false);
  });

  it('opens the pause details instead of resuming the team from the banner', async () => {
    const project = mockProject();
    project.backend.pauses.pauseProject();
    renderLayout(project);
    fireEvent.click(await button());
    const panel = await screen.findByRole('dialog');
    fireEvent.click(await within(panel).findByRole('button', { name: t('pm.banner.resume') }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: pmName(project) })).toBeNull());
    expect(
      (await screen.findByRole('button', { name: t('pause.banner.details') })).getAttribute('aria-expanded'),
    ).toBe('true');
    expect(project.requests.some((r) => r.method === 'POST' && r.path.endsWith('/pause/resume'))).toBe(false);
  });

  it('says there is no project manager when the project has none', async () => {
    const project = mockProject();
    const config = project.backend.config;
    config.team.members = config.team.members.filter((member) => member.handle !== 'pm');
    renderLayout(project);
    fireEvent.click(await button());
    expect(await screen.findByText(t('pm.missing.title'))).toBeTruthy();
  });
});

describe('the project manager button on a card', () => {
  it('stands in the card head and opens the panel', async () => {
    const project = mockProject();
    const openPm = vi.fn();
    project.render(
      <Routes>
        <Route path="/p/:key/tasks/:taskKey" element={<TaskDrawer />} />
      </Routes>,
      '/p/AC/tasks/AC-20',
      { openPm },
    );
    fireEvent.click(await button());
    expect(openPm).toHaveBeenCalledTimes(1);
  });
});

describe('the project manager profile', () => {
  it('opens the panel instead of starting a second conversation', async () => {
    const project = mockProject();
    const openPm = vi.fn();
    project.render(
      <Routes>
        <Route path="/team/:handle" element={<MemberProfilePage />} />
      </Routes>,
      '/team/pm',
      { openPm },
    );
    fireEvent.click(await screen.findByRole('button', { name: t('profile.conversation') }));
    expect(openPm).toHaveBeenCalledTimes(1);
    expect(project.requests.some((request) => request.path.endsWith('/conversation'))).toBe(false);
  });
});

describe('the project manager that is required', () => {
  it('has a required chip and a retire that cannot be used, with the reason', async () => {
    const project = mockProject();
    project.render(<TeamPage />);
    const name = pmName(project);
    const row = (await screen.findByRole('link', { name })).closest('tr')!;
    await waitFor(() => expect(within(row).getByText(t('pm.required.chip'))).toBeTruthy());
    fireEvent.click(within(row).getByRole('button', { name: t('team.moreFor', { name }) }));
    const retire = within(row).getByRole('button', {
      name: t('team.retireMember', { name, handle: 'pm' }),
    });
    expect(retire.getAttribute('aria-disabled')).toBe('true');
    expect(within(row).getByText(t('pm.required.retireNote'))).toBeTruthy();
    fireEvent.click(retire);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
