import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { ToastProvider } from '../../components/Toast';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { browserHash, browserSubscription, fakeBrowser, resetFakeBrowser } from '../../test/pushBrowser';
import { PushNudge } from './PushNudge';

vi.mock('../../lib/pushBrowser', async () => (await import('../../test/pushBrowser')).pushBrowserModule);

beforeEach(() => {
  resetFakeBrowser();
  localStorage.clear();
});
afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

function renderNudge(project = mockProject()) {
  project.render(
    <ToastProvider>
      <Routes>
        <Route path="/p/:projectKey/inbox" element={<PushNudge />} />
        <Route path="/p/:projectKey/notifications" element={<p>notifications page</p>} />
      </Routes>
    </ToastProvider>,
    '/p/AC/inbox',
  );
  return project;
}

const bar = () => screen.queryByRole('region', { name: t('notifications.banner.label') });

describe('push nudge', () => {
  it('offers to switch notifications on in a browser that has not been asked yet', async () => {
    renderNudge();
    expect(await screen.findByRole('region', { name: t('notifications.banner.label') })).toBeTruthy();
  });

  it('switches them on, then takes the person to the notifications page', async () => {
    const project = renderNudge();
    fireEvent.click(await screen.findByRole('button', { name: t('notifications.banner.enable') }));
    expect(await screen.findByText('notifications page')).toBeTruthy();
    expect(project.backend.push.devices).toHaveLength(1);
    expect(await screen.findByText(t('notifications.enabled'))).toBeTruthy();
  });

  it('still opens the page when the person refuses the prompt, to explain what to do', async () => {
    const project = renderNudge();
    fakeBrowser.answer = 'denied';
    fireEvent.click(await screen.findByRole('button', { name: t('notifications.banner.enable') }));
    expect(await screen.findByText('notifications page')).toBeTruthy();
    expect(project.backend.push.devices).toHaveLength(0);
  });

  it('is put away with "Most nem" and stays away on this device', async () => {
    const project = renderNudge();
    fireEvent.click(await screen.findByRole('button', { name: t('notifications.banner.later') }));
    expect(await screen.findByText(t('notifications.banner.dismissed'))).toBeTruthy();
    expect(bar()).toBeNull();
    expect(localStorage.getItem('pm:pushNudgeDismissed')).not.toBeNull();
    cleanup();
    renderNudge(project);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bar()).toBeNull();
  });

  it('does not show where push cannot work or the person has already decided', async () => {
    const cases: Array<() => void> = [
      () => (fakeBrowser.support = 'unsupported'),
      () => (fakeBrowser.support = 'ios_install'),
      () => (fakeBrowser.permission = 'denied'),
      () => (fakeBrowser.permission = 'granted'),
    ];
    for (const setUp of cases) {
      resetFakeBrowser();
      setUp();
      const project = renderNudge();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(bar()).toBeNull();
      // Nothing was even asked of the server.
      expect(project.requests.filter((r) => r.path.startsWith('/api/me/push'))).toHaveLength(0);
      cleanup();
    }
  });

  it('is not shown when the server already lists this device as on', async () => {
    const project = mockProject();
    // Not asked by the browser yet, but the server already lists this device as on.
    fakeBrowser.subscription = browserSubscription();
    project.backend.push.addDevice({ endpointHash: browserHash() });
    renderNudge(project);
    await waitFor(() => expect(project.requests.some((r) => r.path === '/api/me/push')).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bar()).toBeNull();
  });
});
