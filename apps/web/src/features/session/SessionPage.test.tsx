import { screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
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
    member.permissionMode = 'plan';
    project.render(sessionRoute, '/sessions/ses_ac21_fe1', {
      can: { createTasks: false, manageTeam: false, workInSessions: false },
    });
    expect(
      await screen.findByText(t('session.chips.model', { model: 'fictional-public-model' })),
    ).toBeTruthy();
    expect(
      screen.getByText(t('session.chips.permissions', { mode: t('permissionModes.plan') })),
    ).toBeTruthy();
    expect(screen.getByText(t('providers.codex'))).toBeTruthy();
    expect(project.requests.some((request) => request.path.endsWith('/config'))).toBe(false);
    expect(screen.getByText(t('session.chat.brief'))).toBeTruthy();
  });
});
