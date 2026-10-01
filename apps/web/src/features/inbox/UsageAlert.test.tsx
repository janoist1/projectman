import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import type { TokenUsage } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { formatTokens as format } from '../../i18n/format';
import { t } from '../../i18n/t';
import { MockBackend } from '../../mocks/backend';
import { mockProject } from '../../test/mockProject';
import { SessionPage } from '../session/SessionPage';
import { InboxPage } from './InboxPage';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

/** A count as the queries see it: their normalizer turns the grouping (no-break) spaces into plain ones. */
const formatTokens = (count: number) => format(count).replace(/\s/g, ' ');

/** The session the fixtures measured: 452 200 tokens toward the warning limit. */
const SESSION = 'ses_ac21_fe1';
const COUNTED_BEFORE = 1_200 + 34_500 + 180_000 + 210_000 + 800 + 4_200 + 12_000 + 9_500;
const input = (count: number): TokenUsage => ({
  model: 'claude-opus-5-5',
  scope: 'main',
  input: count,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

describe('the warning limit of a session in the fake backend (PM-187)', () => {
  it('raises one alert to the owners when the limit is reached, and none without a limit', () => {
    const backend = new MockBackend();
    backend.reportUsage(SESSION, [input(1_000_000)]);
    expect(backend.inbox.filter((item) => item.kind === 'alert')).toEqual([]);

    backend.config.team.limits.warnAboveSessionTokens = COUNTED_BEFORE + 1_001_000;
    backend.reportUsage(SESSION, [input(1_000)]);
    backend.reportUsage(SESSION, [input(5_000)]);
    const alerts = backend.inbox.filter((item) => item.kind === 'alert');
    expect(alerts).toMatchObject([
      {
        assignees: ['owner'],
        source: 'fe-1',
        sessionId: SESSION,
        taskKey: 'AC-21',
        payload: { alert: 'session_tokens', countedTokens: COUNTED_BEFORE + 1_001_000 },
        options: [{ id: 'seen' }],
      },
    ]);
    expect(backend.findSession(SESSION)).toMatchObject({
      state: 'waiting_permission',
      usageAlert: { countedTokens: COUNTED_BEFORE + 1_001_000 },
    });
  });
});

describe('a session over the warning limit on screen (PM-187)', () => {
  const overLimit = () => {
    const project = mockProject();
    project.backend.config.team.limits.warnAboveSessionTokens = 500_000;
    project.backend.reportUsage(SESSION, [input(50_000)]);
    return project;
  };

  it('shows the alert in the inbox with the member, card and numbers, leads to the session, and "Láttam" closes it', async () => {
    const project = overLimit();
    const alert = project.backend.inbox.find((item) => item.kind === 'alert')!;
    project.render(<InboxPage />, '/p/AC/inbox');

    const card = (
      await screen.findByRole('heading', { name: t('inbox.alerts.session_tokens.heading') })
    ).closest('article')!;
    expect(within(card).getByText(t('inbox.kinds.alert'))).toBeTruthy();
    const text = card.textContent!.replace(/\s/g, ' ');
    expect(text).toContain(t('inbox.alerts.work.task', { key: 'AC-21' }));
    expect(text).toContain(formatTokens(COUNTED_BEFORE + 50_000));
    expect(text).toContain(formatTokens(500_000));
    expect(
      within(card)
        .getByRole('link', { name: t('inbox.details') })
        .getAttribute('href'),
    ).toBe(`/p/AC/sessions/${SESSION}`);

    fireEvent.click(within(card).getByRole('button', { name: t('inbox.options.seen') }));
    await waitFor(() =>
      expect(project.requests).toContainEqual({
        method: 'POST',
        path: `/api/projects/AC/inbox/${alert.id}/resolve`,
        body: { optionId: 'seen' },
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: t('inbox.alerts.session_tokens.heading') })).toBeNull(),
    );
    expect(project.backend.inbox.find((item) => item.id === alert.id)).toMatchObject({
      state: 'resolved',
      resolution: { optionId: 'seen', by: 'owner' },
    });
  });

  it('marks the session header and shows the counted number in its details', async () => {
    const project = overLimit();
    project.render(
      <Routes>
        <Route path="/sessions/:sessionId" element={<SessionPage />} />
      </Routes>,
      `/sessions/${SESSION}`,
    );
    const chip = await screen.findByText(t('tokenUsage.alertChip'));
    expect(chip.closest('[title]')?.getAttribute('title')?.replace(/\s/g, ' ')).toContain(
      formatTokens(500_000),
    );
    fireEvent.click(screen.getByRole('tab', { name: t('session.tabs.details') }));
    const panel = screen.getByRole('region', { name: t('tokenUsage.title') });
    expect(
      within(panel).getByText(t('tokenUsage.counted', { count: formatTokens(COUNTED_BEFORE + 50_000) })),
    ).toBeTruthy();
    const note = within(panel).getByRole('note').textContent!.replace(/\s/g, ' ');
    expect(note).toContain(formatTokens(COUNTED_BEFORE + 50_000));
    expect(note).toContain(formatTokens(500_000));
  });

  it('shows no mark on a session below the limit', async () => {
    const project = mockProject();
    project.render(
      <Routes>
        <Route path="/sessions/:sessionId" element={<SessionPage />} />
      </Routes>,
      `/sessions/${SESSION}`,
    );
    await screen.findByText(t('tokenUsage.chip', { total: formatTokens(2_427_700) }));
    expect(screen.queryByText(t('tokenUsage.alertChip'))).toBeNull();
  });
});
