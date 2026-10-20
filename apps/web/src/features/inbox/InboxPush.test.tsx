import { screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxItem } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { ToastProvider } from '../../components/Toast';
import { t } from '../../i18n/t';
import { plainLanguageQuestion } from '../../mocks/fixtures';
import { mockProject } from '../../test/mockProject';
import { resetFakeBrowser } from '../../test/pushBrowser';
import { InboxPage } from './InboxPage';

vi.mock('../../lib/pushBrowser', async () => (await import('../../test/pushBrowser')).pushBrowserModule);

beforeEach(() => {
  resetFakeBrowser();
  localStorage.clear();
});
afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

function renderInbox(route: string, items: InboxItem[]) {
  const project = mockProject();
  project.backend.inbox.push(...items);
  project.render(
    <ToastProvider>
      <Routes>
        <Route path="/p/:projectKey/inbox" element={<InboxPage />} />
      </Routes>
    </ToastProvider>,
    route,
  );
  return project;
}

const resolved = (id: string): InboxItem => ({
  ...plainLanguageQuestion({ id }),
  state: 'resolved',
  resolution: { optionId: 'option_1', by: 'owner', at: new Date().toISOString(), note: null },
});

describe('inbox opened from a push notification', () => {
  it('says the item has been handled when it is no longer open', async () => {
    renderInbox('/p/AC/inbox?via=push#inbox-item-inb_done', [resolved('inb_done')]);
    expect(await screen.findByText(t('notifications.alreadyHandled'))).toBeTruthy();
  });

  it('says so when the item is not there at all', async () => {
    renderInbox('/p/AC/inbox?via=push#inbox-item-inb_gone', []);
    expect(await screen.findByText(t('notifications.alreadyHandled'))).toBeTruthy();
  });

  it('says nothing when the item is still open', async () => {
    renderInbox('/p/AC/inbox?via=push#inbox-item-inb_open', [plainLanguageQuestion({ id: 'inb_open' })]);
    await screen.findByText(plainLanguageQuestion().title);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByText(t('notifications.alreadyHandled'))).toBeNull();
  });

  it('says nothing for an ordinary visit, even to a handled item', async () => {
    const project = renderInbox('/p/AC/inbox#inbox-item-inb_done', [resolved('inb_done')]);
    await waitFor(() => expect(project.requests.some((r) => r.path.includes('/inbox'))).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByText(t('notifications.alreadyHandled'))).toBeNull();
  });
});

describe('inbox notification bar', () => {
  it('offers to switch notifications on at the top of the inbox', async () => {
    renderInbox('/p/AC/inbox', []);
    expect(await screen.findByRole('region', { name: t('notifications.banner.label') })).toBeTruthy();
  });
});
