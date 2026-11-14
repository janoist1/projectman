import type { InfiniteData } from '@tanstack/react-query';
import type { ConfigHistoryView } from '@projectman/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { applyServerEvent } from '../../../api/cache';
import { queryKeys } from '../../../api/queryKeys';
import { t } from '../../../i18n/t';
import { mockProject } from '../../../test/mockProject';
import { HistorySection } from './HistorySection';

type Project = ReturnType<typeof mockProject>;

/** Saves the project name `count` times, each a version the mock can compare with the one before. */
function rename(p: Project, count: number) {
  for (let index = 0; index < count; index += 1) {
    const response = p.backend.handle('PATCH', '/api/projects/AC/config', {
      baseVersion: p.backend.configVersion,
      message: `Rename ${index}`,
      project: { name: `Name ${index}` },
    });
    expect(response.status).toBe(200);
  }
}

const show = (p: Project, canRevert = true) =>
  p.render(<HistorySection current={p.backend.configVersion} canRevert={canRevert} />);
const rows = () => screen.getAllByRole('listitem');
const projectSummary = () => t('settings.history.summary.sectionProject');

describe('the settings history', () => {
  it('shows five rows, then the earlier ones behind "Korábbiak", fifty at a time', async () => {
    const p = mockProject();
    rename(p, 7);
    show(p);
    fireEvent.click(await screen.findByRole('button', { name: t('settings.history.older', { count: 7 }) }));
    await waitFor(() => expect(rows()).toHaveLength(12));
    expect(screen.queryByRole('button', { name: t('settings.history.more') })).toBeNull();
    expect(
      p.requests.filter((request) => request.path.includes('/config/history')).map((r) => r.path),
    ).toEqual([
      '/api/projects/AC/config/history?limit=5&offset=0',
      '/api/projects/AC/config/history?limit=50&offset=5',
    ]);
  });

  it('keeps the refreshed first page when an older multi-page read arrives after a save', async () => {
    const p = mockProject();
    rename(p, 7);
    const { client } = show(p);
    fireEvent.click(await screen.findByRole('button', { name: t('settings.history.older', { count: 7 }) }));
    await waitFor(() => expect(rows()).toHaveLength(12));
    const held = p.holdNextResponse('GET', '/api/projects/AC/config/history?limit=5&offset=0');
    const earlier = client.refetchQueries({ queryKey: queryKeys.configHistory('AC') });
    await held.captured;
    try {
      rename(p, 1);
      act(() =>
        applyServerEvent(client, {
          type: 'config_changed',
          projectKey: 'AC',
          version: p.backend.configVersion,
        }),
      );
      await waitFor(() => {
        const data = client.getQueryData<InfiniteData<ConfigHistoryView, number>>(
          queryKeys.configHistory('AC'),
        );
        expect(data?.pages[0]?.entries[0]?.version).toBe(p.backend.configVersion);
      });
    } finally {
      await act(async () => {
        await held.release();
        await earlier;
      });
    }
    const data = client.getQueryData<InfiniteData<ConfigHistoryView, number>>(queryKeys.configHistory('AC'));
    expect(data?.pages).toHaveLength(1);
    expect(data?.pageParams).toEqual([0]);
    expect(data?.pages[0]?.entries[0]?.version).toBe(p.backend.configVersion);
    expect(rows()).toHaveLength(5);
    expect(
      p.requests.filter((request) => request.path.includes('/config/history')).map((request) => request.path),
    ).toEqual([
      '/api/projects/AC/config/history?limit=5&offset=0',
      '/api/projects/AC/config/history?limit=50&offset=5',
      '/api/projects/AC/config/history?limit=5&offset=0',
      '/api/projects/AC/config/history?limit=5&offset=0',
    ]);
  });

  it('says in a line what changed and keeps the original text in the details', async () => {
    const p = mockProject();
    rename(p, 1);
    show(p);
    expect(await screen.findAllByText(projectSummary())).toHaveLength(1);
    fireEvent.click(
      screen.getByRole('button', { name: t('settings.history.detailsOf', { summary: projectSummary() }) }),
    );
    expect(screen.getByText('Rename 0')).toBeTruthy();
    expect(screen.getByText(p.backend.configVersion)).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', {
        name: t('settings.history.hideDetailsOf', { summary: projectSummary() }),
      }),
    );
    expect(screen.queryByText('Rename 0')).toBeNull();
  });

  it('says so when an old version has nothing to compare with', async () => {
    const p = mockProject();
    show(p);
    const generic = t('settings.history.summary.generic');
    await screen.findAllByText(generic);
    fireEvent.click(
      screen.getAllByRole('button', { name: t('settings.history.detailsOf', { summary: generic }) })[0]!,
    );
    expect(screen.getByText(t('settings.history.noComparison'))).toBeTruthy();
  });

  it('explains an empty history', async () => {
    const p = mockProject();
    p.backend.history.length = 0;
    show(p);
    expect(await screen.findByText(t('settings.history.empty'))).toBeTruthy();
  });

  it('offers the restore to the owner only, and not on the current version', async () => {
    const owner = mockProject();
    rename(owner, 1);
    const { unmount } = show(owner);
    await screen.findAllByText(projectSummary());
    // Four earlier rows offer it, the current one does not.
    expect(
      screen.getAllByRole('button', {
        name: new RegExp(`^${t('settings.history.rowActions', { summary: '' })}`),
      }),
    ).toHaveLength(4);
    unmount();

    const member = mockProject();
    rename(member, 1);
    show(member, false);
    await screen.findAllByText(projectSummary());
    expect(
      screen.queryByRole('button', {
        name: new RegExp(`^${t('settings.history.rowActions', { summary: '' })}`),
      }),
    ).toBeNull();
    expect(screen.getByText(t('settings.history.ownerOnly'))).toBeTruthy();
  });

  it('restores an earlier version after a confirmation, and the new version says it was a restore', async () => {
    const p = mockProject();
    // Two saves, so that the version restored is a full commit id, as a revert message names it.
    rename(p, 2);
    show(p);
    await screen.findAllByText(projectSummary());
    const earlier = p.backend.history[1]!.version;
    fireEvent.click(
      screen.getAllByRole('button', {
        name: new RegExp(`^${t('settings.history.rowActions', { summary: '' })}`),
      })[0]!,
    );
    fireEvent.click(screen.getByRole('button', { name: t('settings.history.restoreAction') }));
    const dialog = await screen.findByRole('dialog', { name: t('settings.history.revertTitle') });
    expect(p.requests.some((request) => request.path.endsWith('/config/revert'))).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: t('settings.history.revert') }));
    await waitFor(() =>
      expect(p.requests.filter((request) => request.path.endsWith('/config/revert')).at(-1)?.body).toEqual({
        version: earlier,
      }),
    );
    expect((await screen.findAllByText(t('settings.history.summary.restored'))).length).toBe(1);
  });

  it('starts the confirmation on Cancel and returns the focus to the row menu, or the heading after a restore', async () => {
    const p = mockProject();
    rename(p, 2);
    show(p);
    await screen.findAllByText(projectSummary());
    const openDialog = async () => {
      const menu = screen.getAllByRole('button', {
        name: new RegExp(`^${t('settings.history.rowActions', { summary: '' })}`),
      })[0]!;
      fireEvent.click(menu);
      fireEvent.click(screen.getByRole('button', { name: t('settings.history.restoreAction') }));
      const dialog = await screen.findByRole('dialog', { name: t('settings.history.revertTitle') });
      return { menu, dialog };
    };

    const first = await openDialog();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(first.dialog).getByRole('button', { name: t('common.cancel') }),
      ),
    );
    fireEvent.click(within(first.dialog).getByRole('button', { name: t('common.cancel') }));
    await waitFor(() => expect(document.activeElement).toBe(first.menu));

    const second = await openDialog();
    fireEvent.click(within(second.dialog).getByRole('button', { name: t('settings.history.revert') }));
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById('settings-history')));
  });
});
