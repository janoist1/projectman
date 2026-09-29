import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../api/client';
import { mockProject } from '../test/mockProject';
import { MeContext, useProject } from './contexts';
import { ProjectLayout } from './ProjectLayout';

function AccessProbe() {
  const { can, isOwner } = useProject();
  return <output data-testid="access">{JSON.stringify({ can, isOwner })}</output>;
}

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

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
