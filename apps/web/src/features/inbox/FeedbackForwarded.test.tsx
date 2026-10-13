import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ALERT_SEEN_OPTION } from '@projectman/shared';
import type { InboxItem } from '@projectman/shared';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { InboxPage } from './InboxPage';

/** A mark the feedback processor passed to the owner (PM-506): the card opens it in the Jelölések page. */

const forwarded: InboxItem = {
  id: 'inb_fb',
  projectKey: 'AC',
  kind: 'alert',
  assignees: ['owner'],
  source: 'pm',
  sessionId: null,
  taskKey: null,
  title: 'A server alert',
  body: null,
  payload: {
    alert: 'feedback_forwarded',
    markId: 'fbm_abc',
    author: 'kata',
    excerpt: 'Az összehasonlító táblázat mobilon szétesik.',
    reason: 'Új felületi elem.',
  },
  options: [ALERT_SEEN_OPTION],
  state: 'open',
  resolution: null,
  createdAt: '2026-10-02T10:00:00.000Z',
};

describe('the forwarded mark in the inbox', () => {
  it('says who marked what and why it is yours, with a button to the mark', async () => {
    const project = mockProject();
    project.backend.inbox.push(forwarded);
    project.render(<InboxPage />, '/p/AC/inbox');

    const heading = await screen.findByRole('heading', {
      name: t('inbox.alerts.feedback_forwarded.heading'),
    });
    const card = heading.closest('article')!;
    expect(card.textContent).toContain('Az összehasonlító táblázat mobilon szétesik.');
    expect(card.textContent).toContain('Új felületi elem.');
    const open = await screen.findByRole('link', { name: t('inbox.alerts.feedback_forwarded.open') });
    expect(open.getAttribute('href')).toBe('/p/AC/feedback/fbm_abc');
  });
});
