import styles from './Shell.module.css';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
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
      can: { createTasks: false, manageTeam: false, workInSessions: false },
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
