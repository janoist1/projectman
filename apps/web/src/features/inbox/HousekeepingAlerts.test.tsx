import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ALERT_SEEN_OPTION } from '@projectman/shared';
import type { InboxItem } from '@projectman/shared';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { InboxPage } from './InboxPage';

/** The alerts of the housekeeping (PM-243): little free disk space, and a kept worktree. */

const GB = 1024 ** 3;

function alert(id: string, payload: Record<string, unknown>, taskKey: string | null = null): InboxItem {
  return {
    id,
    projectKey: 'AC',
    kind: 'alert',
    assignees: ['owner'],
    source: 'system',
    sessionId: null,
    taskKey,
    title: 'A server alert',
    body: null,
    payload,
    options: [ALERT_SEEN_OPTION],
    state: 'open',
    resolution: null,
    createdAt: '2026-10-02T10:00:00.000Z',
  };
}

describe('the housekeeping alerts in the inbox (PM-243)', () => {
  it('says how little disk space is free and what that stops', async () => {
    const project = mockProject();
    project.backend.inbox.push(
      alert('inb_disk', { alert: 'disk_low', freeBytes: 4.5 * GB, thresholdBytes: 10 * GB }),
    );
    project.render(<InboxPage />, '/p/AC/inbox');

    const card = (await screen.findByRole('heading', { name: t('inbox.alerts.disk_low.heading') })).closest(
      'article',
    )!;
    const text = card.textContent!.replace(/\s/g, ' ');
    expect(text).toContain('4,5 GB');
    expect(text).toContain('10,0 GB');
  });

  it('names the card whose worktree was kept', async () => {
    const project = mockProject();
    project.backend.inbox.push(
      alert(
        'inb_kept',
        { alert: 'worktree_kept', taskKey: 'AC-21', path: '/work/AC-21-web', changes: 3 },
        'AC-21',
      ),
    );
    project.render(<InboxPage />, '/p/AC/inbox');

    const card = (
      await screen.findByRole('heading', { name: t('inbox.alerts.worktree_kept.heading') })
    ).closest('article')!;
    expect(card.textContent).toContain('AC-21');
    expect(card.textContent).toContain('/work/AC-21-web');
    expect(card.textContent).toContain('3');
  });
});
