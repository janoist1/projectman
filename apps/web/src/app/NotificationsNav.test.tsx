import { fireEvent, screen, within } from '@testing-library/react';
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

function renderAs(access: HumanAccess) {
  const project = mockProject();
  const me = {
    ...project.context.me,
    projects: [{ key: 'AC', name: 'Acme webshop', access, roles: [] }],
  };
  project.render(
    <MeContext.Provider value={me}>
      <Routes>
        <Route path="/p/:projectKey" element={<ProjectLayout />}>
          <Route index element={<p>board</p>} />
          <Route path="notifications" element={<p>notifications page</p>} />
        </Route>
      </Routes>
    </MeContext.Provider>,
    '/p/AC',
  );
  return project;
}

describe('"Értesítések" in the account menu', () => {
  it.each(['owner', 'developer', 'viewer', 'client'] as const)(
    'gives a %s the item, and it leads to the notifications page',
    async (access) => {
      renderAs(access);
      const trigger = await screen.findByRole('button', { name: t('nav.account', { name: 'Te' }) });
      fireEvent.click(trigger);
      const panel = document.getElementById(trigger.getAttribute('aria-controls')!)!;
      const item = within(panel).getByRole('link', { name: t('nav.notifications') });
      expect(item.getAttribute('href')).toBe('/p/AC/notifications');
      fireEvent.click(item);
      expect(await screen.findByText('notifications page')).toBeTruthy();
      // The menu closes when the item is chosen.
      expect(document.getElementById(trigger.getAttribute('aria-controls')!)).toBeNull();
    },
  );
});
