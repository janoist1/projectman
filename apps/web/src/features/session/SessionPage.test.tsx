import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { formatStamp, formatTokens as format } from '../../i18n/format';
import { t } from '../../i18n/t';
import { plainLanguageQuestion } from '../../mocks/fixtures';
import { createMockFetch, mockProject } from '../../test/mockProject';
import { MeContext } from '../../app/contexts';
import { ProjectLayout } from '../../app/ProjectLayout';
import { SessionPage } from './SessionPage';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

/** A count as the queries see it: their normalizer turns the grouping (no-break) spaces into plain ones. */
const formatTokens = (count: number) => format(count).replace(/\s/g, ' ');

const sessionRoute = (
  <Routes>
    <Route path="/sessions/:sessionId" element={<SessionPage />} />
  </Routes>
);

describe('session header task state', () => {
  it('reads a queued task as ready once its prerequisite is done', async () => {
    const project = mockProject();
    const queued = project.backend.findTask('AC-23')!;
    queued.status = 'active';
    project.backend.findTask(queued.links[0]!.ref)!.status = 'done';
    project.backend.sessions.push({
      ...project.backend.findSession('ses_ac21_fe1')!,
      id: 'ses_ac23_fe1',
      workItem: { type: 'task', taskKey: queued.key },
    });
    const view = project.render(sessionRoute, '/sessions/ses_ac23_fe1');
    await screen.findByRole('heading', { name: queued.title });
    const phase = () => view.container.querySelector('[role="img"] [data-phase]')?.getAttribute('data-phase');
    await waitFor(() => expect(phase()).toBe('ready'));
  });
});

/** A phone: every media query matches, so the page takes its phone layout. */
function phone() {
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }));
}

const openDetails = async () =>
  fireEvent.click(await screen.findByRole('tab', { name: t('session.tabs.details') }));

describe('session details public settings', () => {
  it('shows AI model and permission mode from MemberView without fetching config', async () => {
    const project = mockProject();
    const member = project.backend.findMember('fe-1')!;
    member.provider = 'codex';
    member.model = 'fictional-public-model';
    member.permissionMode = 'plan';
    project.render(sessionRoute, '/sessions/ses_ac21_fe1', {
      isOwner: false,
      can: { createTasks: false, manageTeam: false, workInSessions: false },
    });
    expect(await screen.findByText(t('session.chat.brief'))).toBeTruthy();
    await openDetails();
    const panel = screen.getByRole('region', { name: t('session.details.title') });
    expect(within(panel).getByText('fictional-public-model')).toBeTruthy();
    expect(
      within(panel).getByText(t('session.chips.permissions', { mode: t('permissionModes.plan') })),
    ).toBeTruthy();
    expect(within(panel).getByText(t('providers.codex'))).toBeTruthy();
    expect(project.requests.some((request) => request.path.endsWith('/config'))).toBe(false);
  });

  it('names the agent CLI the session ran, even after the member switched', async () => {
    const project = mockProject();
    project.backend.findSession('ses_ac21_fe1')!.provider = 'claude';
    project.backend.findMember('fe-1')!.provider = 'codex';
    project.render(sessionRoute, '/sessions/ses_ac21_fe1');
    await openDetails();
    expect(screen.getByText(t('providers.claude'))).toBeTruthy();
    expect(screen.queryByText(t('providers.codex'))).toBeNull();
  });

  it('shows the branch and the whole working directory', async () => {
    const project = mockProject();
    const session = project.backend.findSession('ses_ac21_fe1')!;
    project.render(sessionRoute, '/sessions/ses_ac21_fe1');
    await openDetails();
    const panel = screen.getByRole('region', { name: t('session.details.title') });
    expect(within(panel).getByText(session.cwd)).toBeTruthy();
    if (session.branch) expect(within(panel).getByText(session.branch)).toBeTruthy();
  });
});

describe('session header', () => {
  afterEach(() => vi.restoreAllMocks());

  it('names the member the session belongs to by avatar and name, and keeps only the stage and PR chips', async () => {
    const project = mockProject();
    const member = project.backend.findMember('fe-1')!;
    member.model = 'fictional-public-model';
    project.render(sessionRoute, '/sessions/ses_ac21_fe1');
    const title = await screen.findByRole('heading', { level: 1 });
    const header = title.parentElement!;
    expect(within(header).getByText(member.displayName)).toBeTruthy();
    expect(header.querySelector('[data-tone]')).toBeTruthy();
    expect(within(header).getByText(/ · \d+\/\d+$/)).toBeTruthy();
    expect(within(header).queryByText('fictional-public-model')).toBeNull();
    expect(within(header).queryByText(t('providers.claude'))).toBeNull();
    expect(
      within(header).queryByText(t('session.chips.permissions', { mode: t('permissionModes.acceptEdits') })),
    ).toBeNull();
  });

  it('is one row on a phone: back arrow, title, status and "⋯" for stop, without the app header', async () => {
    phone();
    const project = mockProject();
    project.render(
      <MeContext.Provider value={project.context.me}>
        <Routes>
          <Route path="/p/:projectKey" element={<ProjectLayout />}>
            <Route path="sessions/:sessionId" element={<SessionPage />} />
          </Route>
        </Routes>
      </MeContext.Provider>,
      '/p/AC/sessions/ses_ac21_fe1',
    );
    const title = await screen.findByRole('heading', { level: 1 });
    expect(screen.getByRole('link', { name: t('session.back') }).getAttribute('href')).toBe(
      '/p/AC/tasks/AC-21',
    );
    expect(screen.queryByRole('navigation', { name: t('session.breadcrumb') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('topbar.searchOpen') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('session.stop') })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('common.moreActions') }));
    expect(screen.getByRole('button', { name: t('session.stop') })).toBeTruthy();
    // The member and the live status are the title's second line; the tab bar is gone.
    const second = title.nextElementSibling as HTMLElement;
    expect(within(second).getByText(project.backend.findMember('fe-1')!.displayName)).toBeTruthy();
    expect(within(second).getByRole('status')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: t('nav.main') })).toBeNull();
  });

  it('does not repeat the member where the title names it', async () => {
    const project = mockProject();
    const member = project.backend.findMember('communication')!;
    project.render(sessionRoute, '/sessions/ses_gen_comm');
    const title = await screen.findByRole('heading', { level: 1 });
    expect(title.textContent).toContain(member.displayName);
    expect(title.parentElement!.querySelector('[data-tone]')).toBeNull();
  });
});

describe('a message that did not go out', () => {
  it('shows a retry button in its bubble and sends the same text again', async () => {
    const project = mockProject();
    const answer = createMockFetch(project.backend, project.requests);
    let failures = 1;
    setFetchImplementation(async (path, init) => {
      if (path.endsWith('/messages') && init?.method === 'POST' && failures-- > 0)
        return new Response(JSON.stringify({ error: { code: 'internal' } }), { status: 500 });
      return answer(path, init);
    });
    project.render(sessionRoute, '/sessions/ses_ac21_fe1');
    fireEvent.change(await screen.findByLabelText(t('session.composer.label')), {
      target: { value: 'Mehet a push?' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('common.send') }));
    fireEvent.click(await screen.findByRole('button', { name: t('session.composer.retry') }));
    await waitFor(() =>
      expect(project.requests.filter((request) => request.path.endsWith('/messages'))).toEqual([
        expect.objectContaining({ body: { text: 'Mehet a push?' } }),
      ]),
    );
    await waitFor(() => expect(screen.queryByText(t('session.composer.failed'))).toBeNull());
    expect(screen.queryByRole('button', { name: t('session.composer.retry') })).toBeNull();
    expect(screen.getAllByText('Mehet a push?')).toHaveLength(1);
  });
});

describe('token usage of the session (PM-178)', () => {
  it('shows each model in the details, the subagent apart', async () => {
    const project = mockProject();
    project.render(sessionRoute, '/sessions/ses_ac21_fe1');
    await openDetails();
    const panel = screen.getByRole('region', { name: t('tokenUsage.title') });
    expect(within(panel).getByText(t('tokenUsage.total', { total: formatTokens(2_427_700) }))).toBeTruthy();
    expect(within(panel).getByText('claude-opus-5-5')).toBeTruthy();
    expect(within(panel).getByText('claude-haiku-4-5')).toBeTruthy();
    expect(within(panel).getByText(t('tokenUsage.subagent'))).toBeTruthy();
    expect(within(panel).getByText(formatTokens(112_000))).toBeTruthy();
    expect(
      within(panel).getByText(new RegExp(t('tokenUsage.cacheRead', { count: formatTokens(95_000) }))),
    ).toBeTruthy();
  });

  it('says "no data" for a session from before the measurement, without an error', async () => {
    const project = mockProject();
    project.render(sessionRoute, '/sessions/ses_ac21_qa');
    await openDetails();
    expect(screen.getByText(t('tokenUsage.noDataSession'))).toBeTruthy();
  });

  it('says since when a resumed old session is counted, and that Codex subagents are not', async () => {
    const project = mockProject();
    const session = project.backend.findSession('ses_ac21_fe1')!;
    session.provider = 'codex';
    session.usage = { since: new Date(Date.parse(session.startedAt) + 3_600_000).toISOString(), rows: [] };
    project.render(sessionRoute, '/sessions/ses_ac21_fe1');
    fireEvent.click(await screen.findByRole('tab', { name: t('session.tabs.details') }));
    expect(screen.getByText(t('tokenUsage.none'))).toBeTruthy();
    expect(screen.getByText(t('tokenUsage.since', { time: formatStamp(session.usage.since) }))).toBeTruthy();
    expect(screen.getByText(t('tokenUsage.codexSubagents'))).toBeTruthy();
  });
});

describe('questions in the session chat', () => {
  it('shows a plain-language question inline, next to an old-style one that looks as it did', async () => {
    const project = mockProject();
    const question = plainLanguageQuestion();
    project.backend.inbox.push(question);
    project.render(sessionRoute, '/sessions/ses_ac22_dev1');

    const card = (await screen.findByRole('heading', { name: question.title, level: 3 })).closest('article')!;
    expect(within(card).getByText(t('inbox.question.recommended'))).toBeTruthy();
    expect(within(card).getByText(/^Miért: /)).toBeTruthy();
    expect(within(card).getByText('A hibaüzenet addig látszik, amíg ki nem javítod a címet.')).toBeTruthy();
    expect(card.querySelector('details')!.open).toBe(false);

    const oldTitle = project.backend.inbox.find((item) => item.id === 'inb_q_ga4')!.title;
    const old = screen.getByRole('heading', { name: oldTitle, level: 3 }).closest('article')!;
    expect(within(old).queryByRole('list')).toBeNull();
    expect(old.querySelector('details')).toBeNull();
    expect(within(old).queryByText(t('inbox.question.recommended'))).toBeNull();

    fireEvent.click(within(card).getByRole('button', { name: 'Felugró ablakban' }));
    await waitFor(() =>
      expect(project.requests).toContainEqual({
        method: 'POST',
        path: `/api/projects/AC/inbox/${question.id}/resolve`,
        body: { optionId: 'option_2' },
      }),
    );
  });
});
