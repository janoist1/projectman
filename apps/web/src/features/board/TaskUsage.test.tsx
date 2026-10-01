import { screen, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { formatTokens as format } from '../../i18n/format';
import { t } from '../../i18n/t';
import { nameOf } from '../../lib/members';
import { mockProject } from '../../test/mockProject';
import { mockIndexes } from '../../test/render';
import { TaskDrawer } from './TaskDrawer';

/** A count as the queries see it: their normalizer turns the grouping (no-break) spaces into plain ones. */
const formatTokens = (count: number) => format(count).replace(/\s/g, ' ');

const drawer = (
  <Routes>
    <Route path="/p/:key/tasks/:taskKey" element={<TaskDrawer />} />
  </Routes>
);

describe('token usage of a card (PM-178)', () => {
  it("adds up the card's sessions per model and per member, and names those without data", async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-21');
    const section = await screen.findByRole('region', { name: t('tokenUsage.title') });
    // fe-1: 2 427 700 (its subagent 112 000 of it), code-review: 456 300; qa's session has no data.
    expect(within(section).getByText(t('tokenUsage.total', { total: formatTokens(2_884_000) }))).toBeTruthy();
    expect(within(section).getByText(formatTokens(2_315_700 + 456_300))).toBeTruthy();
    expect(within(section).getByText(t('tokenUsage.subagent'))).toBeTruthy();
    const members = mockIndexes().members;
    const byMember = within(section).getByText(t('tokenUsage.byMember')).parentElement!;
    expect(within(byMember).getByText(nameOf('fe-1', members, 'owner'))).toBeTruthy();
    expect(within(byMember).getByText(formatTokens(2_427_700))).toBeTruthy();
    expect(within(byMember).getByText(formatTokens(456_300))).toBeTruthy();
    expect(within(section).getByText(t('tokenUsage.sessionsWithoutData', { count: 1 }))).toBeTruthy();
  });

  it('says "no data" when none of its sessions was measured', async () => {
    const project = mockProject();
    for (const session of project.backend.sessions) delete session.usage;
    project.render(drawer, '/p/AC/tasks/AC-21');
    const section = await screen.findByRole('region', { name: t('tokenUsage.title') });
    expect(within(section).getByText(t('tokenUsage.noData'))).toBeTruthy();
    expect(within(section).queryByText(t('tokenUsage.sessionsWithoutData', { count: 3 }))).toBeNull();
  });
});
