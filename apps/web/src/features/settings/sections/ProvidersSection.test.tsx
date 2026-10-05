import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../../api/client';
import { createMockFetch, mockProject } from '../../../test/mockProject';
import { t } from '../../../i18n/t';
import { ProvidersSection } from './ProvidersSection';
import { LimitsSection } from './LimitsSection';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));
describe('provider settings', () => {
  it('shows Gemini login steps with member emphasis and recovers silently', async () => {
    const p = mockProject();
    const member = p.backend.config.team.members.find((entry) => entry.kind === 'ai')!;
    if (member.kind === 'ai') member.provider = 'gemini';
    p.backend.providerStatus.gemini = { loggedIn: false, problem: 'not_logged_in' };
    const ui = p.render(<ProvidersSection config={p.backend.config} />);
    await screen.findByText('agy');
    const row = screen.getByText(t('providers.gemini')).closest('li')!;
    expect(row.querySelector('[data-tone="needs"]')).toBeTruthy();
    expect(within(row).getByText(t('providerSettings.loginSteps.gemini'))).toBeTruthy();
    p.backend.providerStatus.gemini = { loggedIn: true };
    await ui.client.invalidateQueries({ queryKey: ['providers'] });
    await within(row).findByText(t('providerSettings.ready'));
    expect(within(row).queryByText('agy')).toBeNull();
  });
  it('renders ready, login missing with and without members, incomplete and unknown rows', async () => {
    const p = mockProject();
    for (const member of p.backend.config.team.members) {
      if (member.kind === 'ai') member.provider = 'claude';
    }
    p.backend.providerStatus.claude = { loggedIn: false, problem: 'not_logged_in' };
    p.backend.providerStatus.codex = { loggedIn: false, problem: 'not_logged_in' };
    p.backend.providerStatus.nanogpt = { loggedIn: false, problem: 'no_key' };
    p.backend.providerStatus.gemini = { loggedIn: null };
    const ui = p.render(<ProvidersSection config={p.backend.config} />);
    await screen.findByText(t('providerSettings.notReady'));
    const row = (provider: 'claude' | 'codex' | 'gemini' | 'nanogpt') =>
      screen.getByText(t(`providers.${provider}`)).closest('li')!;
    expect(within(row('claude')).getByText('claude auth login')).toBeTruthy();
    expect(row('claude').querySelector('[data-tone="needs"]')).toBeTruthy();
    expect(within(row('codex')).getByText(t('providerSettings.noMembers'), { exact: false })).toBeTruthy();
    expect(row('codex').querySelector('[data-tone="neutral"]')).toBeTruthy();
    expect(within(row('nanogpt')).queryByRole('code')).toBeNull();
    expect(within(row('gemini')).getByText(t('providerSettings.unknown'))).toBeTruthy();
    p.backend.providerStatus = {};
    await ui.client.invalidateQueries({ queryKey: ['providers'] });
    await waitFor(() => expect(screen.getAllByText(t('providerSettings.ready'))).toHaveLength(4));
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('keeps names and counts visible while loading and silently refreshes', async () => {
    const p = mockProject();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = createMockFetch(p.backend);
    setFetchImplementation(async (path, init) => {
      if (path === '/api/providers') await pending;
      return fetch(path, init);
    });
    p.render(<ProvidersSection config={p.backend.config} />);
    expect(screen.getByRole('list').getAttribute('aria-busy')).toBe('true');
    expect(screen.getAllByText(t('providerSettings.checking'))).toHaveLength(4);
    expect(screen.getByText(t('providers.claude'))).toBeTruthy();
    release();
    await waitFor(() => expect(screen.getByRole('list').getAttribute('aria-busy')).toBe('false'));
  });
  it('retries a failed request and focuses the recovered list', async () => {
    const p = mockProject();
    p.backend.providersFail = true;
    p.render(<ProvidersSection config={p.backend.config} />);
    await screen.findByText(t('providerSettings.loadError'));
    p.backend.providersFail = false;
    fireEvent.click(screen.getByRole('button', { name: t('providerSettings.retry') }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('list')));
    expect(p.requests.filter((request) => request.path === '/api/providers')).toHaveLength(2);
  });
  it.each([false, true])('explains unmeasured usage only with an unmeasured member: %s', (hasMember) => {
    const p = mockProject();
    const member = p.backend.config.team.members.find((entry) => entry.kind === 'ai')!;
    if (member.kind === 'ai') member.provider = hasMember ? 'nanogpt' : 'claude';
    p.render(<LimitsSection config={p.backend.config} />, '/', { can: { manageTeam: false } });
    const hint = t('settings.limits.pauseAboveHelp', { providers: t('providers.nanogpt') });
    expect(Boolean(screen.queryByText(hint))).toBe(hasMember);
  });
});
