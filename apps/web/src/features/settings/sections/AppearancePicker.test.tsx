import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../../api/client';
import { t } from '../../../i18n/t';
import { mockProject } from '../../../test/mockProject';
import { SettingsTestRoutes } from '../testRoutes';

/** The interface style choice in Settings → Account (PM-363). */

beforeEach(() => {
  delete document.documentElement.dataset.style;
  window.localStorage.clear();
});
afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

const radio = async (name: string | RegExp) =>
  (await screen.findByRole('radio', { name })) as HTMLInputElement;

describe('the interface style choice (PM-363)', () => {
  it('shows the classic style as chosen when the user has not chosen one', async () => {
    mockProject().render(<SettingsTestRoutes initialSection="account" />);
    expect((await radio(new RegExp(t('settings.account.appearance.classic')))).checked).toBe(true);
    expect((await radio(new RegExp(t('settings.account.appearance.win311')))).checked).toBe(false);
  });

  it('switches the whole interface at once, remembers it in the browser and saves it on the account', async () => {
    const project = mockProject();
    project.render(<SettingsTestRoutes initialSection="account" />);
    fireEvent.click(await radio(new RegExp(t('settings.account.appearance.win311'))));
    expect(document.documentElement.dataset.style).toBe('win311');
    expect(window.localStorage.getItem('pm:ui-style')).toBe('win311');
    await waitFor(() => expect(project.backend.uiStyle).toBe('win311'));
  });

  it('keeps the style on this device and offers a retry when saving fails', async () => {
    const project = mockProject();
    project.backend.failUiStyleSave = true;
    project.render(<SettingsTestRoutes initialSection="account" />);
    fireEvent.click(await radio(new RegExp(t('settings.account.appearance.win311'))));
    expect(await screen.findByText(new RegExp(t('settings.account.appearance.saveFailed')))).toBeTruthy();
    expect(document.documentElement.dataset.style).toBe('win311');
    expect(window.localStorage.getItem('pm:ui-style-pending')).toBe('win311');
    project.backend.failUiStyleSave = false;
    fireEvent.click(screen.getByRole('button', { name: t('settings.account.appearance.retry') }));
    await waitFor(() => expect(project.backend.uiStyle).toBe('win311'));
    await waitFor(() => expect(screen.queryByText(t('settings.account.appearance.saveFailed'))).toBeNull());
    expect(window.localStorage.getItem('pm:ui-style-pending')).toBe('');
  });
});
