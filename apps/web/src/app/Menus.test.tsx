import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFetchImplementation } from '../api/client';
import { t } from '../i18n/t';
import { mockProject } from '../test/mockProject';
import { MeContext } from './contexts';
import { AccountMenu } from './Menus';

const COMMIT = 'abcdef0123456789'.repeat(2) + 'abcdef01';

afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

function menu(tag: string | null, commit: string | null = COMMIT) {
  const project = mockProject();
  project.backend.serverVersion = { version: commit ?? 'dev', commit, tag, latestReleaseTag: null };
  const rendered = project.render(
    <MeContext.Provider value={project.context.me}>
      <AccountMenu settingsPath={null} />
    </MeContext.Provider>,
  );
  const open = () =>
    fireEvent.click(
      screen.getByRole('button', { name: t('nav.account', { name: project.context.me.name }) }),
    );
  return { ...project, ...rendered, open };
}

describe('account menu version', () => {
  it('shows the release tag with the full commit as its title', async () => {
    const project = menu('v2026.10.23');
    project.open();
    const row = await screen.findByText(t('nav.version', { version: 'v2026.10.23' }));
    expect(row.getAttribute('title')).toBe(COMMIT);
    expect(row.tagName).toBe('DIV');
  });

  it('fetches only when opened and reuses the fresh result on reopening', async () => {
    const project = menu(null);
    expect(project.requests.some((r) => r.path === '/api/version')).toBe(false);
    project.open();
    await screen.findByTitle(COMMIT);
    project.open();
    project.open();
    expect(project.requests.filter((r) => r.path === '/api/version')).toHaveLength(1);
  });

  it('shows the short unpublished commit and its full title', async () => {
    menu(null).open();
    const row = await screen.findByText(t('nav.version', { version: COMMIT.slice(0, 8) }));
    expect(row.getAttribute('title')).toBe(COMMIT);
  });

  it('shows a non-commit version', async () => {
    menu(null, null).open();
    const row = await screen.findByText(t('nav.version', { version: 'dev' }));
    expect(row.getAttribute('title')).toBe('dev');
  });

  it('hides the version while loading', () => {
    const project = menu(null);
    setFetchImplementation(() => new Promise(() => {}));
    project.open();
    expect(project.client.getQueryState(['server-version'])?.status).toBe('pending');
    expect(screen.queryByTitle(COMMIT)).toBeNull();
  });

  it('hides the version after an error', async () => {
    const project = menu(null);
    let fail!: (error: Error) => void;
    setFetchImplementation(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    project.open();
    fail(new Error('Unavailable'));
    await waitFor(() => expect(project.client.getQueryState(['server-version'])?.status).toBe('error'));
    expect(screen.queryByTitle(COMMIT)).toBeNull();
  });
});
