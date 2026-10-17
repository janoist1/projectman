import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFetchImplementation } from '../../../api/client';
import { t } from '../../../i18n/t';
import { mockProject } from '../../../test/mockProject';
import { IntegratorSection } from './IntegratorSection';

afterEach(() => {
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
  vi.unstubAllGlobals();
});
describe('integrator key settings', () => {
  it('shows an inactive empty state and compact past rows when all keys have expired', async () => {
    const project = mockProject();
    project.context.me.hostOwner = true;
    const at = '2026-01-01T00:00:00.000Z';
    project.backend.integratorKeys = [
      {
        id: 'old',
        mode: 'super',
        prefix: 'pmi_old',
        state: 'expired',
        createdAt: at,
        expiresAt: at,
        lastUsedAt: null,
        lastUsedChannel: null,
        revokedAt: null,
      },
    ];
    project.render(<IntegratorSection />);
    expect(await screen.findByText(t('integratorKey.noValid'))).toBeTruthy();
    fireEvent.click(screen.getByText(t('integratorKey.past', { n: 1 })));
    expect(document.querySelector('li[data-past="true"] dl')).toBeNull();
    expect(document.querySelectorAll('ul:empty')).toHaveLength(0);
    fireEvent.click(screen.getByText(t('integratorKey.audit')));
    await waitFor(() =>
      expect(project.requests.some((request) => request.path.includes('/integrator-keys/audit'))).toBe(true),
    );
  });
  it('keeps the one-time secret selectable after clipboard failure and clears it on Escape', async () => {
    const project = mockProject();
    project.context.me.hostOwner = true;
    project.render(<IntegratorSection />);
    fireEvent.click(await screen.findByRole('button', { name: t('integratorKey.create') }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: t('integratorKey.submit') }),
    );
    expect(await screen.findByText('pmi_mock_key_for_ui_tests_only')).toBeTruthy();
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('Denied')) } });
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: t('integratorKey.copy') }),
    );
    expect(await screen.findByText(t('integratorKey.copyFailed'))).toBeTruthy();
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: true, cancelable: true }));
    await waitFor(() => expect(screen.queryByText('pmi_mock_key_for_ui_tests_only')).toBeNull());
    expect(localStorage.getItem('integrator-key')).toBeNull();
  });
  it('creates a key with its expiry, hides the secret after dismissal and revokes it', async () => {
    const project = mockProject();
    project.context.me.hostOwner = true;
    const { client } = project.render(<IntegratorSection />);
    fireEvent.click(await screen.findByRole('button', { name: t('integratorKey.create') }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(t('integratorKey.expiry')), { target: { value: '30' } });
    fireEvent.click(within(dialog).getByRole('button', { name: t('integratorKey.submit') }));
    expect(await screen.findByText('pmi_mock_key_for_ui_tests_only')).toBeTruthy();
    expect(
      project.requests.find(
        (request) => request.method === 'POST' && request.path.endsWith('/integrator-keys'),
      )?.body,
    ).toEqual({ mode: 'super', expiresInDays: 30 });
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain('pmi_mock_key_for_ui_tests_only');
    expect(
      JSON.stringify(
        client
          .getMutationCache()
          .getAll()
          .map((mutation) => mutation.state.data),
      ),
    ).not.toContain('pmi_mock_key_for_ui_tests_only');
    fireEvent.click(screen.getByRole('button', { name: t('integratorKey.done') }));
    await waitFor(() => expect(screen.queryByText('pmi_mock_key_for_ui_tests_only')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: t('integratorKey.revoke') }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: t('integratorKey.revoke') }),
    );
    fireEvent.click(await screen.findByText(t('integratorKey.past', { n: 1 })));
    expect(await screen.findByText(t('integratorKey.states.revoked'), { exact: true })).toBeTruthy();
  });
  it('is hidden for anyone who is not the host owner', () => {
    const project = mockProject();
    project.context.me.hostOwner = false;
    project.render(<IntegratorSection />);
    expect(screen.queryByRole('heading', { name: t('integratorKey.title') })).toBeNull();
    expect(project.requests.some((request) => request.path.includes('/integrator-keys'))).toBe(false);
  });
  it('does not fetch or manage keys through a token', async () => {
    const project = mockProject();
    project.context.me.hostOwner = true;
    project.context.me.via = 'integrator';
    project.render(<IntegratorSection />);
    expect(screen.getByText(t('integratorKey.ownerOnly'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('integratorKey.create') })).toBeNull();
    expect(project.requests.some((request) => request.path.includes('/integrator-keys'))).toBe(false);
  });
  it('keeps mode and expiry after a failed create and uses the seven-day default', async () => {
    const project = mockProject();
    project.context.me.hostOwner = true;
    const original = project.backend.handle.bind(project.backend);
    vi.spyOn(project.backend, 'handle').mockImplementation((method, path, body, query) =>
      method === 'POST' && path.endsWith('/integrator-keys')
        ? { status: 500, body: { error: { code: 'internal_error', message: 'Failed' } } }
        : original(method, path, body, query),
    );
    project.render(<IntegratorSection />);
    fireEvent.click(await screen.findByRole('button', { name: t('integratorKey.create') }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: /Scripteknek/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: t('integratorKey.submit') }));
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    expect((within(dialog).getByLabelText(t('integratorKey.expiry')) as HTMLSelectElement).value).toBe('7');
    expect(project.requests.find((request) => request.method === 'POST')?.body).toEqual({
      mode: 'read',
      expiresInDays: 7,
    });
  });
  it('shows channel, legacy migration and imminent expiry without interpreting an unknown channel', async () => {
    const project = mockProject();
    project.context.me.hostOwner = true;
    const base = {
      state: 'active' as const,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      revokedAt: null,
    };
    project.backend.integratorKeys = [
      { ...base, id: 's', mode: 'super', prefix: 'pmi_super', lastUsedChannel: 'cli' },
      { ...base, id: 'l', mode: 'legacy', prefix: 'pmi_legacy', lastUsedChannel: null },
    ];
    project.render(<IntegratorSection />);
    expect(await screen.findByText(t('integratorKey.today'))).toBeTruthy();
    expect(screen.getByText(/· parancssor/)).toBeTruthy();
    expect(screen.getByText(t('integratorKey.legacy'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('integratorKey.upgrade') }));
    expect(screen.getByText(t('integratorKey.replaceBody', { prefix: 'pmi_super' }))).toBeTruthy();
    expect([...document.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toContain(
      '/p/AC/sessions?by=super&prefix=pmi_super',
    );
  });
});
