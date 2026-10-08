import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../../api/client';
import { t } from '../../../i18n/t';
import { mockProject } from '../../../test/mockProject';
import { IntegratorSection } from './IntegratorSection';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));
describe('integrator key settings', () => {
  it('creates a key with its expiry, hides the secret after dismissal and revokes it', async () => {
    const project = mockProject();
    project.context.me.hostOwner = true;
    project.render(<IntegratorSection />);
    fireEvent.click(await screen.findByRole('button', { name: t('integratorKey.create') }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(t('integratorKey.expiry')), { target: { value: '30' } });
    fireEvent.click(within(dialog).getByRole('button', { name: t('integratorKey.create') }));
    expect(await screen.findByText('pmi_mock_key_for_ui_tests_only')).toBeTruthy();
    expect(
      project.requests.find(
        (request) => request.method === 'POST' && request.path.endsWith('/integrator-key'),
      )?.body,
    ).toEqual({ expiresInDays: 30 });
    fireEvent.click(screen.getByRole('button', { name: t('integratorKey.done') }));
    await waitFor(() => expect(screen.queryByText('pmi_mock_key_for_ui_tests_only')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: t('integratorKey.revoke') }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: t('integratorKey.revoke') }),
    );
    expect(await screen.findByText(t('integratorKey.states.revoked'))).toBeTruthy();
  });
  it('is hidden for anyone who is not the host owner', () => {
    const project = mockProject();
    project.context.me.hostOwner = false;
    project.render(<IntegratorSection />);
    expect(screen.queryByRole('heading', { name: t('integratorKey.title') })).toBeNull();
    expect(project.requests.some((request) => request.path.endsWith('/integrator-key'))).toBe(false);
  });
});
