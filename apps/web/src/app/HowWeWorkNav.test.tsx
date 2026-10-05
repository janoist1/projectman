import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HumanAccess } from '@projectman/shared';
import { setFetchImplementation } from '../api/client';
import { HowWeWorkPage } from '../features/how-we-work/HowWeWorkPage';
import { t } from '../i18n/t';
import { mockProject } from '../test/mockProject';
import { MeContext } from './contexts';
import { ProjectLayout } from './ProjectLayout';

afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

function renderAs(access: HumanAccess, route: string) {
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
          <Route path="how-we-work" element={<HowWeWorkPage />} />
        </Route>
      </Routes>
    </MeContext.Provider>,
    route,
  );
  return project;
}

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

describe('"Hogyan dolgozunk" in the navigation', () => {
  it.each(['admin', 'developer', 'viewer'] as const)(
    'gives a %s the rail item, and the item leads to the page',
    async (access) => {
      renderAs(access, '/p/AC');
      const item = await screen.findByRole('link', { name: t('nav.howWeWork') });
      expect(item.getAttribute('href')).toBe('/p/AC/how-we-work');
      fireEvent.click(item);
      expect(await screen.findByRole('heading', { level: 1, name: t('howWeWork.title') })).toBeTruthy();
      expect(screen.getByRole('link', { name: t('nav.howWeWork') }).getAttribute('aria-current')).toBe(
        'page',
      );
    },
  );

  it('gives only an admin the way to edit', async () => {
    renderAs('viewer', '/p/AC/how-we-work');
    await screen.findByRole('region', { name: t('howWeWork.sections.flow') });
    expect(screen.queryByRole('link', { name: t('howWeWork.editInSettings') })).toBeNull();
  });

  it('gives a client no item and no page, and asks for no configuration', async () => {
    const project = renderAs('client', '/p/AC/how-we-work');
    expect(await screen.findByText(t('app.notFound'))).toBeTruthy();
    expect(screen.queryByRole('link', { name: t('nav.howWeWork') })).toBeNull();
    expect(project.requests.some((request) => request.path.endsWith('/config'))).toBe(false);
  });

  it('puts the item in the account menu on a phone, above the settings', async () => {
    phone();
    renderAs('admin', '/p/AC');
    const trigger = await screen.findByRole('button', { name: t('nav.account', { name: 'Te' }) });
    fireEvent.click(trigger);
    const panel = document.getElementById(trigger.getAttribute('aria-controls')!)!;
    const items = within(panel).getAllByRole('link');
    const names = items.map((item) => item.textContent);
    await waitFor(() => expect(names).toContain(t('nav.howWeWork')));
    expect(names.indexOf(t('nav.howWeWork'))).toBeLessThan(names.indexOf(t('nav.settings')));
  });

  it('keeps a client out of the phone menu too', async () => {
    phone();
    renderAs('client', '/p/AC');
    const trigger = await screen.findByRole('button', { name: t('nav.account', { name: 'Te' }) });
    fireEvent.click(trigger);
    const panel = document.getElementById(trigger.getAttribute('aria-controls')!)!;
    expect(within(panel).queryByText(t('nav.howWeWork'))).toBeNull();
  });
});
