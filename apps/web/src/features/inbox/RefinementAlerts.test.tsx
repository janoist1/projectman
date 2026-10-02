import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ALERT_SEEN_OPTION } from '@projectman/shared';
import type { InboxItem } from '@projectman/shared';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { InboxPage } from './InboxPage';

/** The alerts of the refinement (decision 31): a step only a person can do, a stalled one, and the end. */

function alert(id: string, payload: Record<string, unknown>): InboxItem {
  return {
    id,
    projectKey: 'AC',
    kind: 'alert',
    assignees: ['owner'],
    source: 'system',
    sessionId: null,
    taskKey: 'AC-21',
    title: 'A server alert',
    body: null,
    payload,
    options: [ALERT_SEEN_OPTION],
    state: 'open',
    resolution: null,
    createdAt: '2026-10-02T10:00:00.000Z',
  };
}

describe('the refinement alerts in the inbox', () => {
  it.each([
    ['manual_step', 'release-approved'],
    ['stalled', 'release-approved'],
    ['done', null],
  ] as const)('says what a %s refinement needs and leads to the card', async (reason, label) => {
    const project = mockProject();
    project.backend.inbox.push(alert('inb_refine', { alert: 'refinement', taskKey: 'AC-21', label, reason }));
    project.render(<InboxPage />, '/p/AC/inbox');

    const card = (await screen.findByRole('heading', { name: t('inbox.alerts.refinement.heading') })).closest(
      'article',
    )!;
    const labelName = project.backend.config.pipeline.labels.find((entry) => entry.id === label)?.name ?? '';
    expect(card.textContent).toContain(
      t(`inbox.alerts.refinement.${reason}`, { key: 'AC-21', label: labelName }),
    );
    // The label is named, not its id.
    if (label) expect(card.textContent).not.toContain(label);
    const link = card.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('/p/AC/tasks/AC-21');
  });
});
