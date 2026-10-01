import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/t';
import { MockBackend } from '../../mocks/backend';
import { mockProject } from '../../test/mockProject';
import { InboxPage } from './InboxPage';

/** The message storm warning of a card, in the fake backend and in the "Rád vár" list (PM-186). */

const burstAlerts = (backend: MockBackend) =>
  backend.inbox.filter((item) => item.kind === 'alert' && item.payload.alert === 'message_burst');

const notes = (backend: MockBackend, count: number, taskKey = 'AC-21') => {
  for (let i = 0; i < count; i++) backend.addTimeline(taskKey, 'owner', 'task_note', { text: 'Update' });
};

describe('the message storm rule in the fake backend', () => {
  it('raises one alert to the owners at the threshold, and none for the next entry', () => {
    const backend = new MockBackend();
    backend.config.team.limits.messageBurst = { count: 5, minutes: 15 };
    notes(backend, 4);
    expect(burstAlerts(backend)).toEqual([]);
    notes(backend, 1);
    expect(burstAlerts(backend)).toMatchObject([
      {
        assignees: ['owner'],
        taskKey: 'AC-21',
        state: 'open',
        payload: { alert: 'message_burst', taskKey: 'AC-21', count: 5, minutes: 15 },
        options: [{ id: 'seen' }],
      },
    ]);
    notes(backend, 3);
    expect(burstAlerts(backend)).toHaveLength(1);
  });

  it('counts team messages too, and leaves imported comments out', () => {
    const backend = new MockBackend();
    backend.config.team.limits.messageBurst = { count: 3, minutes: 15 };
    for (let i = 0; i < 5; i++)
      backend.addTimeline('AC-21', 'owner', 'task_note', { text: 'Old', importedAuthor: 'Ann' });
    expect(burstAlerts(backend)).toEqual([]);
    backend.addTimeline('AC-21', 'owner', 'team_message', { messageId: 'm1', from: 'owner', to: ['fe-1'] });
    backend.addTimeline('AC-21', 'fe-1', 'team_message', { messageId: 'm2', from: 'fe-1', to: ['owner'] });
    expect(burstAlerts(backend)).toEqual([]);
    notes(backend, 1);
    expect(burstAlerts(backend)[0]!.payload).toMatchObject({ count: 3, members: ['owner', 'fe-1'] });
  });
});

describe('a message storm on screen', () => {
  it('shows the alert in the list with the card, the count and the members, and "Láttam" closes it', async () => {
    const project = mockProject();
    project.backend.config.team.limits.messageBurst = { count: 3, minutes: 15 };
    notes(project.backend, 3);
    const alert = burstAlerts(project.backend)[0]!;
    project.render(<InboxPage />, '/p/AC/inbox');

    const card = (
      await screen.findByRole('heading', { name: t('inbox.alerts.message_burst.heading') })
    ).closest('article')!;
    expect(within(card).getByText(t('inbox.kinds.alert'))).toBeTruthy();
    // The card says its key, the window and the count.
    expect(card.textContent).toMatch(/AC-21.*15.*3/);
    expect(
      within(card)
        .getByRole('link', { name: t('inbox.details') })
        .getAttribute('href'),
    ).toBe('/p/AC/tasks/AC-21');

    fireEvent.click(within(card).getByRole('button', { name: t('inbox.options.seen') }));
    await waitFor(() =>
      expect(project.requests).toContainEqual({
        method: 'POST',
        path: `/api/projects/AC/inbox/${alert.id}/resolve`,
        body: { optionId: 'seen' },
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: t('inbox.alerts.message_burst.heading') })).toBeNull(),
    );
    expect(project.backend.inbox.find((item) => item.id === alert.id)).toMatchObject({
      state: 'resolved',
      resolution: { optionId: 'seen', by: 'owner' },
    });
  });
});
