import styles from './Shell.module.css';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFetchImplementation } from '../api/client';
import { t } from '../i18n/t';
import { mockProject } from '../test/mockProject';
import { MeContext, useProject } from './contexts';
import { ProjectLayout } from './ProjectLayout';

function AccessProbe() {
  const { can, isOwner } = useProject();
  return <output data-testid="access">{JSON.stringify({ can, isOwner })}</output>;
}

afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

describe('project access from Me', () => {
  it('uses Me membership even when the board lists the viewer as an owner', async () => {
    const project = mockProject();
    const me = {
      ...project.context.me,
      projects: [{ key: 'AC', name: 'Fictional project', access: 'viewer' as const, roles: [] }],
    };
    project.render(
      <MeContext.Provider value={me}>
        <Routes>
          <Route path="/p/:projectKey" element={<ProjectLayout />}>
            <Route index element={<AccessProbe />} />
          </Route>
        </Routes>
      </MeContext.Provider>,
      '/p/AC',
    );
    expect(JSON.parse((await screen.findByTestId('access')).textContent!)).toEqual({
      can: { createTasks: false, manageTeam: false, workInSessions: false, pauseTeam: false },
      isOwner: false,
    });
    await screen.findByText('Acme webshop');
    expect(project.requests.some((request) => request.path.endsWith('/config'))).toBe(false);
  });
});

describe('board scroll ownership', () => {
  it.each([
    ['/p/AC', false, true],
    ['/p/AC/tasks/AC-20', false, true],
    ['/p/AC/settings', false, false],
    ['/p/AC', true, false],
  ] as const)('constrains only desktop/tablet board routes: %s, mobile=%s', async (route, mobile, fixed) => {
    if (mobile)
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
    const project = mockProject();
    const view = project.render(
      <MeContext.Provider value={project.context.me}>
        <Routes>
          <Route path="/p/:projectKey" element={<ProjectLayout />}>
            <Route index element={<AccessProbe />} />
            <Route path="tasks/:taskKey" element={<AccessProbe />} />
            <Route path="settings" element={<AccessProbe />} />
          </Route>
        </Routes>
      </MeContext.Provider>,
      route,
    );
    await screen.findByTestId('access');
    expect(view.container.querySelector('main')!.classList.contains(styles.boardMain!)).toBe(fixed);
    expect(view.container.querySelector(`.${styles.shell}`)!.classList.contains(styles.boardShell!)).toBe(
      fixed,
    );
  });
});

describe('desktop top bar steps', () => {
  /** A window of this width: every `(max-width: Npx)` query matches when N is at least the width. */
  function renderAt(width: number) {
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      matches: Number(/max-width: (\d+)px/.exec(query)?.[1] ?? 0) >= width,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }));
    const project = mockProject();
    return project.render(
      <MeContext.Provider value={project.context.me}>
        <Routes>
          <Route path="/p/:projectKey" element={<ProjectLayout />}>
            <Route index element={<AccessProbe />} />
          </Route>
        </Routes>
      </MeContext.Provider>,
      '/p/AC',
    );
  }

  it.each([
    [1920, 'full'],
    [1600, 'full'],
    [1500, 'full'],
    [1499, 'peak'],
    [1280, 'peak'],
  ] as const)('at %s px the plan usage is %s', async (width, variant) => {
    renderAt(width);
    await screen.findAllByRole('group', { name: /Claude|Codex/ });
    const header = document.querySelector('header')!;
    const meters = within(header).getAllByRole('meter');
    const providers = within(header).getAllByRole('group').length;
    expect(meters).toHaveLength(variant === 'full' ? providers * 2 : providers);
  });

  it('keeps "Új feladat" with its text above 900 px and shows an icon with the same name at 900 px', async () => {
    renderAt(901);
    const labelled = await screen.findByRole('button', { name: t('topbar.newTask') });
    expect(labelled.textContent).toBe(t('topbar.newTask'));
    cleanup();
    renderAt(900);
    const iconOnly = await screen.findByRole('button', { name: t('topbar.newTask') });
    expect(iconOnly.textContent).toBe('');
    expect(iconOnly.getAttribute('aria-label')).toBe(t('topbar.newTask'));
  });
});

describe('phone header', () => {
  function renderPhone() {
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
    const project = mockProject();
    const view = project.render(
      <MeContext.Provider value={project.context.me}>
        <Routes>
          <Route path="/p/:projectKey" element={<ProjectLayout />}>
            <Route index element={<AccessProbe />} />
          </Route>
        </Routes>
      </MeContext.Provider>,
      '/p/AC',
    );
    return view;
  }

  it('has a search icon, a usage badge and no inbox pill (the tab bar has the count)', async () => {
    const view = renderPhone();
    await screen.findByRole('button', { name: t('topbar.searchOpen') });
    const header = view.container.querySelector('header')!;
    expect(within(header).queryByRole('link', { name: /^Rád vár/ })).toBeNull();
    await waitFor(() =>
      expect(
        within(header)
          .getByRole('link', { name: /Legmagasabb AI-keret/ })
          .getAttribute('href'),
      ).toBe('/p/AC/team'),
    );
  });

  it('opens the search over the header, filters through it and clears on cancel', async () => {
    const view = renderPhone();
    fireEvent.click(await screen.findByRole('button', { name: t('topbar.searchOpen') }));
    const input = screen.getByRole('searchbox');
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: 'AC-20' } });
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('AC-20');
    fireEvent.click(screen.getByRole('button', { name: t('topbar.searchCancel') }));
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(view.container.querySelector('header')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('topbar.searchOpen') }));
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('');
  });
});
