import { screen, within } from '@testing-library/react';
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

function renderAs(access: HumanAccess, handle: string, seed: boolean) {
  const project = mockProject();
  if (seed) project.backend.feedback.seedSample();
  project.backend.viewerHandle = handle;
  const me = {
    ...project.context.me,
    projects: [{ key: 'AC', name: 'Acme webshop', access, roles: [] }],
  };
  const manage = access === 'owner' || access === 'admin';
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
      can: { createTasks: access !== 'client', manageTeam: manage, workInSessions: access !== 'client' },
    },
  );
  return project;
}

describe('the "Jelölések" item in the navigation', () => {
  it('gives a processor the item with the number of marks to decide', async () => {
    renderAs('owner', 'owner', true);
    const item = await screen.findByRole('link', { name: new RegExp(t('nav.feedback')) });
    expect(item.getAttribute('href')).toBe('/p/AC/feedback');
    await within(item).findByText(/jelölés vár rád/);
  });

  it('gives a client the item once there is a surface to mark on', async () => {
    renderAs('client', 'kata', true);
    expect(await screen.findByRole('link', { name: new RegExp(t('nav.feedback')) })).toBeTruthy();
  });

  it('keeps the item from a client while nothing is set up', async () => {
    renderAs('client', 'kata', false);
    await screen.findByText('board');
    expect(screen.queryByRole('link', { name: new RegExp(t('nav.feedback')) })).toBeNull();
  });

  it('shows an owner the item even before anything is set up, to start the setup', async () => {
    renderAs('owner', 'owner', false);
    expect(await screen.findByRole('link', { name: new RegExp(t('nav.feedback')) })).toBeTruthy();
  });
});
