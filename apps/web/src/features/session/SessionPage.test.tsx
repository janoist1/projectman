import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { plainLanguageQuestion } from '../../mocks/fixtures';
import { mockProject } from '../../test/mockProject';
import { SessionPage } from './SessionPage';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

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

describe('session header public settings', () => {
  it('shows AI model and permission mode from MemberView without fetching config', async () => {
    const project = mockProject();
    const member = project.backend.findMember('fe-1')!;
    member.provider = 'codex';
    member.model = 'fictional-public-model';
    member.permissionLevel = 'plan';
    project.render(sessionRoute, '/sessions/ses_ac21_fe1', {
      can: { createTasks: false, manageTeam: false, workInSessions: false },
    });
    expect(
      await screen.findByText(t('session.chips.model', { model: 'fictional-public-model' })),
    ).toBeTruthy();
    expect(
      screen.getByText(t('session.chips.permissions', { level: t('permissionLevels.levels.plan') })),
    ).toBeTruthy();
    expect(screen.getByText(t('providers.codex'))).toBeTruthy();
    expect(project.requests.some((request) => request.path.endsWith('/config'))).toBe(false);
    expect(screen.getByText(t('session.chat.brief'))).toBeTruthy();
  });

  it('names the agent CLI the session ran, even after the member switched', async () => {
    const project = mockProject();
    project.backend.findSession('ses_ac21_fe1')!.provider = 'claude';
    project.backend.findMember('fe-1')!.provider = 'codex';
    project.render(sessionRoute, '/sessions/ses_ac21_fe1');
    expect(await screen.findByText(t('providers.claude'))).toBeTruthy();
    expect(screen.queryByText(t('providers.codex'))).toBeNull();
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
