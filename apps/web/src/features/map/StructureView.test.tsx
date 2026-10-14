import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { StructureView } from './StructureView';

afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});
function Location() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}
      {location.search}
    </output>
  );
}
const routes = (
  <>
    <Routes>
      <Route path="/p/:projectKey/map" element={<StructureView />}>
        <Route path="tasks/:taskKey/*" element={<div data-testid="drawer" />} />
        <Route path=":groupKey/*" element={<Navigate to=".." relative="route" replace />} />
      </Route>
    </Routes>
    <Location />
  </>
);
const plot = (id: string) => document.querySelector<HTMLButtonElement>(`[data-module="${id}"]`)!;
const side = () => screen.getByRole('complementary', { name: t('map.structure.details') });
const cardButton = (key: string) => within(side()).getByRole('button', { name: new RegExp(key) });

describe('structure map', () => {
  it('keeps the landscape when no card is working in the repository', async () => {
    const project = mockProject();
    project.backend.structure.repos[0]!.cards = [];
    project.render(routes, '/p/AC/map');
    await screen.findByText(t('map.structure.emptyCards'));
    expect(plot('orders')).toBeTruthy();
    expect(plot('orders').dataset.clash).toBe('false');
  });
  it('shows a missing board card by key without inventing its title or state', async () => {
    const project = mockProject();
    project.backend.structure.repos[0]!.cards[0]!.taskKey = 'AC-999';
    project.render(routes, '/p/AC/map');
    await screen.findByRole('heading', { name: 'Vásárlói élmény' });
    const row = cardButton('AC-999');
    expect(row.querySelector('b')?.textContent).toBe('AC-999');
    expect(row.querySelector('[data-phase]')).toBeNull();
  });
  it('shows a request error with a working retry', async () => {
    const project = mockProject();
    const handle = project.backend.handle.bind(project.backend);
    let fail = true;
    vi.spyOn(project.backend, 'handle').mockImplementation((method, path, body, query) =>
      fail && path.endsWith('/structure')
        ? { status: 500, body: { error: { code: 'fixture_failure', message: 'Fixture failure' } } }
        : handle(method, path, body, query),
    );
    project.render(routes, '/p/AC/map');
    await screen.findByText(t('map.structure.error'));
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: t('app.retry') }));
    await screen.findByRole('heading', { name: 'Vásárlói élmény' });
  });
  it('loads the endpoint and shows areas, shaped modules and shared-module clashes', async () => {
    const project = mockProject();
    project.render(routes, '/p/AC/map');
    await screen.findByRole('heading', { name: 'Vásárlói élmény' });
    expect(project.requests.some((r) => r.path.endsWith('/structure'))).toBe(true);
    expect(plot('orders').dataset.kind).toBe('core');
    expect(plot('database').dataset.kind).toBe('store');
    expect(plot('payment').dataset.kind).toBe('external');
    expect(plot('orders').dataset.clash).toBe('true');
    expect(plot('shop').dataset.clash).toBe('false');
    expect(cardButton('AC-17').textContent).toContain(t('map.structure.clashTag'));
    expect(within(side()).queryByRole('button', { name: /AC-19/ })).toBeNull();
  });
  it('selects a card, highlights its modules and preserves the query when opening its drawer', async () => {
    mockProject().render(routes, '/p/AC/map');
    await screen.findByRole('heading', { name: 'Vásárlói élmény' });
    fireEvent.click(cardButton('AC-17'));
    expect(plot('shop').dataset.lit).toBe('true');
    expect(plot('database').dataset.dim).toBe('true');
    expect(within(plot('orders')).getByText(t('map.structure.files', { count: 3 }))).toBeTruthy();
    expect(screen.getByTestId('location').textContent).toContain('card=AC-17');
    expect(within(side()).getByText(t('map.structure.branch'), { exact: false })).toBeTruthy();
    expect(
      within(side())
        .getByRole('link', { name: t('map.structure.open') })
        .getAttribute('href'),
    ).toBe('/p/AC/map/tasks/AC-17?card=AC-17');
    fireEvent.click(within(side()).getByRole('link', { name: t('map.structure.open') }));
    await screen.findByTestId('drawer');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByTestId('location').textContent).toContain('card=AC-17');
    fireEvent.click(within(side()).getByRole('button', { name: /←/ }));
    expect(plot('shop').dataset.lit).toBe('false');
  });
  it('shows the module responsibility, directed relationships and file counts', async () => {
    mockProject().render(routes, '/p/AC/map?module=orders');
    await screen.findByRole('heading', { name: 'Vásárlói élmény' });
    await within(side()).findByRole('heading', { name: 'Rendelések' });
    expect(within(side()).getByText('A rendelés életútját vezérli.')).toBeTruthy();
    expect(within(side()).getByRole('button', { name: /Adattár.*eltárol/ })).toBeTruthy();
    expect(within(side()).getByRole('button', { name: /Webáruház.*rendelést indít/ })).toBeTruthy();
    expect(cardButton('AC-17').textContent).toContain(t('map.structure.files', { count: 3 }));
    expect(plot('shop').dataset.dim).toBe('false');
    expect(within(side()).getByText(t('map.structure.moduleClash', { keys: 'AC-17 és AC-18' }))).toBeTruthy();
  });
  it('clears keyboard selection on Escape and restores its initiating plot focus', async () => {
    mockProject().render(routes, '/p/AC/map');
    await screen.findByRole('heading', { name: 'Vásárlói élmény' });
    plot('orders').focus();
    // Native buttons provide Enter/Space activation; click is the resulting DOM event.
    fireEvent.click(plot('orders'));
    expect(plot('orders').getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(plot('orders').getAttribute('aria-pressed')).toBe('false');
    expect(document.activeElement).toBe(plot('orders'));
  });
  it('toggles completed cards and clears a hidden card selection', async () => {
    mockProject().render(routes, '/p/AC/map');
    await screen.findByRole('heading', { name: 'Vásárlói élmény' });
    fireEvent.click(screen.getByRole('button', { name: t('map.structure.all') }));
    expect(cardButton('AC-19').getAttribute('data-merged')).toBe('true');
    fireEvent.click(cardButton('AC-19'));
    fireEvent.click(screen.getByRole('button', { name: t('map.structure.ongoing') }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).not.toContain('card='));
  });
  it('switches repositories, clears selection and renders a full missing state', async () => {
    mockProject().render(routes, '/p/AC/map?module=orders');
    await screen.findByRole('heading', { name: 'Vásárlói élmény' });
    fireEvent.click(screen.getByRole('button', { name: /mobile/ }));
    await screen.findByRole('heading', { name: t('map.structure.missing') });
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(screen.queryByRole('group', { name: t('map.structure.cards') })).toBeNull();
    expect(screen.getByTestId('location').textContent).not.toContain('module=');
    expect(screen.getByRole('link', { name: t('map.structure.board') }).getAttribute('href')).toBe('/p/AC');
  });
  it.each(['invalid', 'engine_offline', 'not_allowed', 'failed'] as const)(
    'renders %s without map controls',
    async (status) => {
      const project = mockProject();
      const repo = project.backend.structure.repos[0]!;
      repo.status = status === 'invalid' ? 'invalid' : 'unavailable';
      repo.reason = status === 'invalid' ? null : status;
      repo.problem = 'Invalid <script> descriptor';
      project.render(routes, '/p/AC/map');
      await screen.findByRole('heading', { name: t(`map.structure.${status}`) });
      expect(screen.queryByRole('complementary')).toBeNull();
      expect(screen.queryByRole('button', { name: t('app.retry') }) !== null).toBe(
        status !== 'invalid' && status !== 'not_allowed',
      );
      if (status === 'invalid') expect(screen.getByText(repo.problem).tagName).toBe('PRE');
    },
  );
  it('shows outside examples and truncation notices', async () => {
    const project = mockProject();
    project.backend.structure.repos[0]!.truncated = true;
    project.render(routes, '/p/AC/map?outside=1');
    await screen.findByText(t('map.structure.truncated'));
    expect(within(side()).getByText('README.md')).toBeTruthy();
    expect(within(side()).getByText(t('map.structure.outsideBody'))).toBeTruthy();
  });
  it('preserves a selection on background refresh and clears it when removed', async () => {
    const project = mockProject();
    const view = project.render(routes, '/p/AC/map?module=orders');
    await screen.findByRole('heading', { name: 'Vásárlói élmény' });
    await act(async () => {
      await view.client.invalidateQueries({ queryKey: ['structure', 'AC'] });
    });
    expect(plot('orders').getAttribute('aria-pressed')).toBe('true');
    project.backend.structure.repos[0]!.map!.modules =
      project.backend.structure.repos[0]!.map!.modules.filter((m) => m.id !== 'orders');
    await act(async () => {
      await view.client.invalidateQueries({ queryKey: ['structure', 'AC'] });
    });
    await waitFor(() => expect(screen.getByTestId('location').textContent).not.toContain('module='));
  });
  it('redirects old group bookmarks to the map', async () => {
    mockProject().render(routes, '/p/AC/map/PM-12');
    await screen.findByRole('heading', { name: 'Vásárlói élmény' });
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/p/AC/map'));
  });
});
