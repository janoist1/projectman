import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFetchImplementation } from '../../../api/client';
import { t } from '../../../i18n/t';
import { MockBackend } from '../../../mocks/backend';
import { mockProject } from '../../../test/mockProject';
import { IntegratorSection } from './IntegratorSection';
import { OPERATOR_MACHINE_OPERATIONS } from '@projectman/shared';
import { hu } from '../../../i18n/hu';
import dialogStyles from '../../../components/Dialog.module.css';

afterEach(() => {
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
  vi.unstubAllGlobals();
});
describe('integrator key settings', () => {
  it('has a translation for every machine capability', () => {
    for (const id of OPERATOR_MACHINE_OPERATIONS) expect(hu.operatorGrant.operations[id]).toBeTruthy();
  });
  it('grants and revokes machine access through separate confirmation dialogs', async () => {
    const project = mockProject();
    project.context.me.hostOwner = true;
    project.render(<IntegratorSection />);
    fireEvent.click(await screen.findByRole('button', { name: t('operatorGrant.grant') }));
    expect((screen.getByLabelText(t('operatorGrant.duration')) as HTMLSelectElement).value).toBe(
      'until_revoked',
    );
    fireEvent.change(screen.getByLabelText(t('operatorGrant.duration')), { target: { value: '12h' } });
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: t('operatorGrant.submit') }),
    );
    fireEvent.click(await screen.findByRole('button', { name: t('operatorGrant.revoke') }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: t('operatorGrant.revokeSubmit') }),
    );
    await screen.findByRole('button', { name: t('operatorGrant.grant') });
    expect(
      project.requests.find(
        (request) => request.method === 'POST' && request.path.endsWith('/operator-grant'),
      )?.body,
    ).toEqual({ duration: '12h' });
    expect(
      project.requests.some(
        (request) => request.method === 'DELETE' && request.path.endsWith('/operator-grant'),
      ),
    ).toBe(true);
  });
  it('extends a grant expiring today and combines its replacement audit into one row', async () => {
    const project = mockProject();
    project.context.me.hostOwner = true;
    project.backend.operatorGrant = {
      active: true,
      grantId: 'g',
      grantedAt: new Date().toISOString(),
      grantedBy: 'Owner',
      expiresAt: new Date(new Date().setHours(23, 59, 59, 999)).toISOString(),
      lastUsedAt: null,
      canManage: true,
    };
    project.render(<IntegratorSection />);
    fireEvent.click(await screen.findByRole('button', { name: t('operatorGrant.extend') }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: t('operatorGrant.extendSubmit') }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(
      await screen.findByText(
        t('operatorGrant.auditExtended', {
          expiry: t('operatorGrant.untilRevoked'),
          by: project.backend.user.name,
        }),
        { exact: false },
      ),
    ).toBeTruthy();
  });
  it('keeps a failed write open and retries with the selected duration', async () => {
    const project = mockProject();
    project.context.me.hostOwner = true;
    const original = project.backend.handle.bind(project.backend);
    let fail = true;
    vi.spyOn(project.backend, 'handle').mockImplementation((method, path, body, query) =>
      method === 'POST' && path.endsWith('/operator-grant') && fail
        ? { status: 403, body: { error: { code: 'operator_grant_owner_only', message: 'Refused' } } }
        : original(method, path, body, query),
    );
    project.render(<IntegratorSection />);
    fireEvent.click(await screen.findByRole('button', { name: t('operatorGrant.grant') }));
    fireEvent.change(screen.getByLabelText(t('operatorGrant.duration')), { target: { value: '7d' } });
    fireEvent.click(screen.getByRole('button', { name: t('operatorGrant.submit') }));
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toBeTruthy();
    expect((screen.getByLabelText(t('operatorGrant.duration')) as HTMLSelectElement).value).toBe('7d');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: t('operatorGrant.submit') }));
    await screen.findByRole('button', { name: t('operatorGrant.revoke') });
  });
  it('shows the limited Claude Code credential state when the grant is absent', async () => {
    const project = mockProject();
    project.context.me.hostOwner = true;
    project.backend.integratorKeys = [
      {
        id: 'k',
        mode: 'super',
        prefix: 'pmi_test',
        state: 'active',
        createdAt: new Date().toISOString(),
        expiresAt: null,
        revokedAt: null,
        lastUsedAt: null,
        lastUsedChannel: null,
      },
    ];
    project.render(<IntegratorSection />);
    expect(await screen.findByText(t('operatorGrant.clientInactive'))).toBeTruthy();
  });
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
  it.each(['super', 'read'] as const)(
    'describes %s key revocation without an empty dialog body',
    async (mode) => {
      const project = mockProject();
      project.context.me.hostOwner = true;
      project.backend.integratorKeys = [
        {
          id: 'key',
          mode,
          prefix: 'pmi_test',
          state: 'active',
          createdAt: new Date().toISOString(),
          expiresAt: null,
          revokedAt: null,
          lastUsedAt: null,
          lastUsedChannel: null,
        },
      ];
      project.render(<IntegratorSection />);
      fireEvent.click(await screen.findByRole('button', { name: t('integratorKey.revoke') }));
      const dialog = screen.getByRole('dialog', {
        description: t(mode === 'read' ? 'integratorKey.revokeReadBody' : 'integratorKey.revokeBody'),
      });
      expect(dialog.querySelector(`.${dialogStyles.body}`)).toBeNull();
    },
  );
  it('creates a key lasting 365 days', async () => {
    const project = mockProject();
    project.context.me.hostOwner = true;
    project.render(<IntegratorSection />);
    fireEvent.click(await screen.findByRole('button', { name: t('integratorKey.create') }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(t('integratorKey.expiry')), {
      target: { value: '365' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: t('integratorKey.submit') }));
    await screen.findByText('pmi_mock_key_for_ui_tests_only');
    expect(
      project.requests.find(
        (request) => request.method === 'POST' && request.path.endsWith('/integrator-keys'),
      )?.body,
    ).toEqual({ mode: 'super', expiresInDays: 365 });
    const created = project.backend.integratorKeys[0]!;
    expect(Date.parse(created.expiresAt!) - Date.parse(created.createdAt)).toBe(365 * 86_400_000);
  });
  it('warns about a non-expiring key and creates it without an imminent-expiry warning', async () => {
    const project = mockProject();
    project.context.me.hostOwner = true;
    project.render(<IntegratorSection />);
    fireEvent.click(await screen.findByRole('button', { name: t('integratorKey.create') }));
    const dialog = screen.getByRole('dialog');
    const expiry = within(dialog).getByLabelText(t('integratorKey.expiry'));
    expect(expiry.getAttribute('aria-describedby')).toBeNull();
    fireEvent.change(expiry, { target: { value: 'never' } });
    const warningId = expiry.getAttribute('aria-describedby');
    expect(warningId).toBeTruthy();
    expect(document.getElementById(warningId!)?.textContent).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('radio', { name: /Scripteknek/ }));
    expect(expiry.getAttribute('aria-describedby')).toBe(warningId);
    fireEvent.click(within(dialog).getByRole('radio', { name: /Claude Code-nak/ }));
    fireEvent.change(expiry, { target: { value: '7' } });
    expect(expiry.getAttribute('aria-describedby')).toBeNull();
    fireEvent.change(expiry, { target: { value: 'never' } });
    fireEvent.click(within(dialog).getByRole('button', { name: t('integratorKey.submit') }));
    await screen.findByText('pmi_mock_key_for_ui_tests_only');
    fireEvent.click(screen.getByRole('button', { name: t('integratorKey.done') }));
    expect(
      project.requests.find(
        (request) => request.method === 'POST' && request.path.endsWith('/integrator-keys'),
      )?.body,
    ).toEqual({ mode: 'super', expiresInDays: null });
    expect(await screen.findByText(t('integratorKey.never'))).toBeTruthy();
    expect(project.backend.integratorKeys[0]!.expiresAt).toBeNull();
    expect(screen.queryByText(t('integratorKey.today'))).toBeNull();
    expect(screen.queryByText(t('integratorKey.soon', { n: 1 }))).toBeNull();
  });
  it('resets the lifetime to seven days when reopening key creation', async () => {
    const project = mockProject();
    project.context.me.hostOwner = true;
    project.render(<IntegratorSection />);
    fireEvent.click(await screen.findByRole('button', { name: t('integratorKey.create') }));
    fireEvent.change(screen.getByLabelText(t('integratorKey.expiry')), {
      target: { value: 'never' },
    });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: t('common.cancel') }));
    fireEvent.click(screen.getByRole('button', { name: t('integratorKey.create') }));
    const expiry = screen.getByLabelText(t('integratorKey.expiry')) as HTMLSelectElement;
    expect(expiry.value).toBe('7');
    expect(expiry.getAttribute('aria-describedby')).toBeNull();
  });
  it('is hidden for anyone who is not the host owner', () => {
    const project = mockProject();
    project.context.me.hostOwner = false;
    project.render(<IntegratorSection />);
    expect(screen.queryByRole('heading', { name: t('operatorGrant.title') })).toBeNull();
    expect(project.requests.some((request) => request.path.includes('/integrator-keys'))).toBe(false);
  });
  it('gives an owner account the key of its own projects, without the machine access grant', async () => {
    const backend = new MockBackend();
    backend.user = { userId: 'usr_owner2', name: 'Eszter', email: 'eszter@owner.test' };
    backend.ownerAccountIds.add('usr_owner2');
    const project = mockProject(backend);
    project.context.me.hostOwner = false;
    project.context.me.ownerAccount = true;
    project.render(<IntegratorSection />);
    expect(await screen.findByRole('button', { name: t('integratorKey.create') })).toBeTruthy();
    expect(screen.queryByText(t('operatorGrant.intro'))).toBeNull();
    expect(screen.queryByRole('button', { name: t('operatorGrant.grant') })).toBeNull();
    expect(project.requests.some((request) => request.path.includes('/operator-grant'))).toBe(false);
    // The operator grant is the host's: the owner account's section is titled by its own client.
    expect(screen.getByRole('heading', { name: t('operatorGrant.clientTitle') })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: t('operatorGrant.title') })).toBeNull();
  });
  it('shows the assistant instruction under the new key, with the MCP address and without the key', async () => {
    const project = mockProject();
    project.context.me.hostOwner = true;
    project.render(<IntegratorSection />);
    fireEvent.click(await screen.findByRole('button', { name: t('integratorKey.create') }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: t('integratorKey.submit') }),
    );
    await screen.findByText('pmi_mock_key_for_ui_tests_only');
    const instruction = within(screen.getByRole('dialog')).getByLabelText(t('integratorKey.assistant.aria'));
    expect(instruction.textContent).toContain(`${window.location.origin}/mcp`);
    expect(instruction.textContent).not.toContain('pmi_mock_key_for_ui_tests_only');
    expect(instruction.getAttribute('tabindex')).toBe('0');
  });
  it('shows the same instruction in the connection fold', async () => {
    const project = mockProject();
    project.context.me.hostOwner = true;
    project.render(<IntegratorSection />);
    await screen.findByRole('button', { name: t('integratorKey.create') });
    expect(screen.getByLabelText(t('integratorKey.assistant.aria')).textContent).toContain('/mcp');
  });
  it('does not fetch or manage keys through a token', async () => {
    const project = mockProject();
    project.context.me.hostOwner = true;
    project.context.me.via = 'integrator';
    project.backend.integratorMode = 'super';
    project.render(<IntegratorSection />);
    expect(screen.getByText(t('integratorKey.ownerOnly'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('integratorKey.create') })).toBeNull();
    expect(await screen.findByText(t('operatorGrant.ownerOnly'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('operatorGrant.grant') })).toBeNull();
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
  it('shows channel, revoked legacy history and imminent expiry without interpreting an unknown channel', async () => {
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
      {
        ...base,
        id: 'l',
        mode: 'legacy',
        prefix: 'pmi_legacy',
        lastUsedChannel: null,
        state: 'revoked',
        revokedAt: base.createdAt,
      },
    ];
    project.render(<IntegratorSection />);
    expect(await screen.findByText(t('integratorKey.today'))).toBeTruthy();
    expect(screen.getByText(/· parancssor/)).toBeTruthy();
    expect(screen.getByText(t('integratorKey.modes.legacy'))).toBeTruthy();
    expect([...document.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toContain(
      '/p/AC/sessions?by=super&prefix=pmi_super',
    );
  });
});
