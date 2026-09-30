import styles from './Shell.module.css';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFetchImplementation } from '../api/client';
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
