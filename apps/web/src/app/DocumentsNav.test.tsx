import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HumanAccess } from '@projectman/shared';
import { setFetchImplementation } from '../api/client';
import { t } from '../i18n/t';
import { mockProject } from '../test/mockProject';
import { MeContext } from './contexts';
import { ProjectLayout } from './ProjectLayout';

afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

function renderAs(access: HumanAccess, handle: string) {
  const project = mockProject();
  project.backend.viewerHandle = handle;
  const me = {
    ...project.context.me,
    projects: [{ key: 'AC', name: 'Acme webshop', access, roles: [] }],
  };
  project.render(
    <MeContext.Provider value={me}>
      <Routes>
        <Route path="/p/:projectKey" element={<ProjectLayout />}>
          <Route index element={<p>board</p>} />
        </Route>
      </Routes>
    </MeContext.Provider>,
    '/p/AC',
    {
      me,
      myHandle: handle,
      isOwner: access === 'owner',
      can: {
        createTasks: access !== 'client',
        manageTeam: access === 'owner',
        workInSessions: access !== 'client',
      },
    },
  );
}

describe('the "Dokumentumok" item in the navigation', () => {
  it.each([
    ['owner', 'owner'],
    ['viewer', 'owner'],
  ] as const)('gives a %s the item', async (access, handle) => {
    renderAs(access, handle);
    const item = await screen.findByRole('link', { name: new RegExp(t('nav.documents')) });
    expect(item.getAttribute('href')).toBe('/p/AC/docs');
  });

  it('keeps the item from a client', async () => {
    renderAs('client', 'kata');
    await screen.findByText('board');
    expect(screen.queryByRole('link', { name: new RegExp(t('nav.documents')) })).toBeNull();
  });
});
