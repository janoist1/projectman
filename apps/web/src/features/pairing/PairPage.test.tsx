import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { MockBackend } from '../../mocks/backend';
import { createMockFetch, mockProject } from '../../test/mockProject';
import type { MockRequest } from '../../test/mockProject';
import { PairPage } from './PairPage';

beforeEach(() => window.localStorage.clear());
afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderPair(backend: MockBackend, path = '/pair') {
  const project = mockProject(backend);
  const view = project.render(
    <>
      <Routes>
        <Route path="/pair" element={<PairPage />} />
        <Route path="/pair/:code" element={<PairPage />} />
        <Route path="/p/AC/settings/engines" element={<p>engines</p>} />
      </Routes>
      <Where />
    </>,
    path,
  );
  return { ...project, ...view };
}

const lookups = (project: { requests: MockRequest[] }, name: 'lookup' | 'approve' | 'deny') =>
  project.requests.filter((request) => request.path === `/api/pairings/${name}`);

async function typeCode(code: string) {
  fireEvent.change(await screen.findByLabelText(t('pairing.enter.label')), { target: { value: code } });
  fireEvent.click(screen.getByRole('button', { name: t('pairing.enter.submit') }));
}

async function openApproval(backend = new MockBackend(), options?: { ttlMs?: number }) {
  const code = backend.pairing.open('Mac mini', options);
  const project = renderPair(backend);
  await typeCode(code.toLowerCase().replace('-', ' '));
  await screen.findByRole('heading', { name: t('pairing.approve.title') });
  return { ...project, code };
}

const title = (name: string) => screen.getByRole('heading', { name });

describe('the code step', () => {
  it('puts the focus in the field and keeps the code out of the address', async () => {
    renderPair(new MockBackend());
    const field = (await screen.findByLabelText(t('pairing.enter.label'))) as HTMLInputElement;
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: 'wdjbmjht' } });
    expect(field.value).toBe('WDJB-MJHT');
    expect(screen.getByTestId('where').textContent).toBe('/pair');
  });

  it('refuses a code of the wrong shape without asking the server', async () => {
    const project = renderPair(new MockBackend());
    await typeCode('AB1');
    expect(await screen.findByText(t('pairing.enter.invalid'))).toBeTruthy();
    expect(lookups(project, 'lookup')).toHaveLength(0);
  });

  it('says a code the server does not know is not valid and keeps the text selected for typing over', async () => {
    const project = renderPair(new MockBackend());
    await typeCode('ZZZZ-ZZZZ');
    expect(await screen.findByText(t('pairing.enter.invalid'))).toBeTruthy();
    const field = screen.getByLabelText(t('pairing.enter.label')) as HTMLInputElement;
    expect(field.value).toBe('ZZZZ-ZZZZ');
    expect(document.activeElement).toBe(field);
    expect(lookups(project, 'lookup').map((request) => request.body)).toEqual([{ code: 'ZZZZ-ZZZZ' }]);
  });

  it('shows a server failure above the button, keeps the code and tries again on Tovább', async () => {
    const backend = new MockBackend();
    const code = backend.pairing.open('Mac mini');
    backend.pairing.serverFailure = 503;
    renderPair(backend);
    await typeCode(code);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect((screen.getByLabelText(t('pairing.enter.label')) as HTMLInputElement).value).toBe(code);
    backend.pairing.serverFailure = null;
    fireEvent.click(screen.getByRole('button', { name: t('pairing.enter.submit') }));
    await screen.findByRole('heading', { name: t('pairing.approve.title') });
  });

  it('waits after too many wrong codes: the button shows the time, then the field gets the focus back', async () => {
    const backend = new MockBackend();
    backend.pairing.rateLimitedFor = 1;
    const project = renderPair(backend);
    await typeCode('ZZZZ-ZZZZ');
    const wait = await screen.findByRole('button', { name: t('pairing.enter.wait', { time: '0:01' }) });
    expect((wait as HTMLButtonElement).disabled).toBe(true);
    // The banner shows it; the page's polite live region says it once for a screen reader.
    expect(screen.getAllByText(t('pairing.enter.tooMany', { time: '0:01' }))).toHaveLength(2);
    backend.pairing.rateLimitedFor = null;
    const submit = await screen.findByRole('button', { name: t('pairing.enter.submit') }, { timeout: 3000 });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    expect(document.activeElement).toBe(screen.getByLabelText(t('pairing.enter.label')));
    expect(lookups(project, 'lookup')).toHaveLength(1);
  });
});

describe('a link with the code', () => {
  it('looks the code up on arrival and moves the focus to the title, not to Jóváhagyom', async () => {
    const backend = new MockBackend();
    const code = backend.pairing.open('Mac mini');
    const project = renderPair(backend, `/pair/${code}`);
    await screen.findByRole('heading', { name: t('pairing.approve.title') });
    await waitFor(() => expect(document.activeElement).toBe(title(t('pairing.approve.title'))));
    expect(lookups(project, 'lookup').map((request) => request.body)).toEqual([{ code }]);
    expect(Object.values(window.localStorage)).not.toContain(code);
    expect(JSON.stringify(window.localStorage)).not.toContain(code);
  });

  it('asks for the code again when the link holds a malformed one', async () => {
    const project = renderPair(new MockBackend(), '/pair/nope');
    expect(await screen.findByText(t('pairing.enter.invalid'))).toBeTruthy();
    expect(lookups(project, 'lookup')).toHaveLength(0);
  });
});

describe('the approval', () => {
  it('shows what the machine asks for and what an approval creates', async () => {
    const project = await openApproval();
    expect(screen.getByText('Mac mini')).toBeTruthy();
    expect(screen.getByText(project.code)).toBeTruthy();
    expect(screen.getByText(t('pairing.approve.createsEngine', { name: 'Mac mini' }))).toBeTruthy();
    expect(screen.queryByText(/Claude Code-kulcsod|current Claude Code key/)).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(title(t('pairing.approve.title'))));
  });

  it('tells which live key an approval replaces', async () => {
    const backend = new MockBackend();
    backend.integratorKeys = [
      {
        id: 'k1',
        mode: 'super',
        prefix: 'pmi_old1',
        state: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: null,
        lastUsedAt: null,
        lastUsedChannel: null,
        revokedAt: null,
      },
    ];
    await openApproval(backend);
    expect(screen.getByText(t('pairing.approve.replaces', { prefix: 'pmi_old1' }))).toBeTruthy();
  });

  it('approves: the machine and its key exist, the title has the focus, the keys never reach the page', async () => {
    const backend = new MockBackend();
    const project = await openApproval(backend);
    fireEvent.click(screen.getByRole('button', { name: t('pairing.approve.approve') }));
    await screen.findByRole('heading', { name: t('pairing.done.title') });
    await waitFor(() => expect(document.activeElement).toBe(title(t('pairing.done.title'))));
    expect(lookups(project, 'approve').map((request) => request.body)).toEqual([{ code: project.code }]);
    expect(backend.engines.some((engine) => engine.name === 'Mac mini' && engine.paired)).toBe(true);
    expect(backend.integratorKeys.some((key) => key.paired && key.state === 'active')).toBe(true);
    const cached = JSON.stringify(
      project.client
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data),
    );
    expect(`${document.body.textContent}${cached}`).not.toMatch(/pm[ei]_\w{16,}/);
    const open = await screen.findByRole('link', { name: t('pairing.done.open') });
    expect(open.getAttribute('href')).toBe('/p/AC/settings/engines');
  });

  it('denies: the machine gets nothing', async () => {
    const backend = new MockBackend();
    const project = await openApproval(backend);
    fireEvent.click(screen.getByRole('button', { name: t('pairing.approve.deny') }));
    await screen.findByRole('heading', { name: t('pairing.denied.title') });
    await waitFor(() => expect(document.activeElement).toBe(title(t('pairing.denied.title'))));
    expect(lookups(project, 'deny')).toHaveLength(1);
    expect(backend.engines.some((engine) => engine.paired)).toBe(false);
  });

  it('blocks both buttons while a decision is sent and keeps the focus on the pressed one', async () => {
    const backend = new MockBackend();
    const project = await openApproval(backend);
    const base = createMockFetch(backend, project.requests);
    setFetchImplementation(async (path, init) => {
      if (path === '/api/pairings/approve') await new Promise((resolve) => setTimeout(resolve, 150));
      return base(path, init);
    });
    const approve = screen.getByRole('button', { name: t('pairing.approve.approve') });
    approve.focus();
    fireEvent.click(approve);
    const busy = await screen.findByRole('button', { name: t('pairing.approve.approving') });
    expect(busy.getAttribute('aria-disabled')).toBe('true');
    expect(
      screen.getByRole('button', { name: t('pairing.approve.deny') }).getAttribute('aria-disabled'),
    ).toBe('true');
    expect(document.activeElement).toBe(busy);
    fireEvent.click(busy);
    fireEvent.click(screen.getByRole('button', { name: t('pairing.approve.deny') }));
    await screen.findByRole('heading', { name: t('pairing.done.title') });
    expect(lookups(project, 'approve')).toHaveLength(1);
    expect(lookups(project, 'deny')).toHaveLength(0);
  });

  it('shows an approval error above the buttons, focuses Jóváhagyom and lets it be tried again', async () => {
    const backend = new MockBackend();
    await openApproval(backend);
    backend.pairing.serverFailure = 500;
    fireEvent.click(screen.getByRole('button', { name: t('pairing.approve.approve') }));
    expect((await screen.findByRole('alert')).textContent).toBe(t('pairing.approve.approveFailed'));
    const approve = screen.getByRole('button', { name: t('pairing.approve.approve') });
    await waitFor(() => expect(document.activeElement).toBe(approve));
    backend.pairing.serverFailure = null;
    fireEvent.click(approve);
    await screen.findByRole('heading', { name: t('pairing.done.title') });
  });

  it('focuses Elutasítom after a denial error', async () => {
    const backend = new MockBackend();
    await openApproval(backend);
    backend.pairing.serverFailure = 500;
    fireEvent.click(screen.getByRole('button', { name: t('pairing.approve.deny') }));
    expect((await screen.findByRole('alert')).textContent).toBe(t('pairing.approve.denyFailed'));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: t('pairing.approve.deny') })),
    );
  });

  it('turns an approval the server calls invalid into the expired view, which leads back to a new code', async () => {
    const backend = new MockBackend();
    await openApproval(backend);
    backend.pairing.pairings[0]!.state = 'denied';
    fireEvent.click(screen.getByRole('button', { name: t('pairing.approve.approve') }));
    await screen.findByRole('heading', { name: t('pairing.expired.title') });
    await waitFor(() => expect(document.activeElement).toBe(title(t('pairing.expired.title'))));
    fireEvent.click(screen.getByRole('button', { name: t('pairing.expired.again') }));
    const field = (await screen.findByLabelText(t('pairing.enter.label'))) as HTMLInputElement;
    expect(field.value).toBe('');
    expect(document.activeElement).toBe(field);
  });

  it('expires by itself when the countdown ends', async () => {
    await openApproval(new MockBackend(), { ttlMs: 1500 });
    await screen.findByRole('heading', { name: t('pairing.expired.title') }, { timeout: 4000 });
    expect(screen.queryByRole('button', { name: t('pairing.approve.approve') })).toBeNull();
  });

  it('leaves the expired link to the code step with the code out of the address', async () => {
    const backend = new MockBackend();
    const code = backend.pairing.open('Mac mini', { ttlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    renderPair(backend, `/pair/${code}`);
    expect(await screen.findByText(t('pairing.enter.invalid'))).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe(`/pair/${code}`);
  });

  it('says an account without the right cannot approve, and the button logs out', async () => {
    const backend = new MockBackend();
    const code = backend.pairing.open('Mac mini');
    backend.user = { ...backend.user, userId: 'usr_client' };
    const project = renderPair(backend, `/pair/${code}`);
    await screen.findByRole('heading', { name: t('pairing.noRight.title') });
    await waitFor(() => expect(document.activeElement).toBe(title(t('pairing.noRight.title'))));
    fireEvent.click(screen.getByRole('button', { name: t('pairing.noRight.login') }));
    await waitFor(() =>
      expect(project.requests.some((request) => request.path === '/api/auth/logout')).toBe(true),
    );
  });
});
