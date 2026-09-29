import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { SessionPage } from './SessionPage';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

describe('session header public settings', () => {
  it('shows AI model and permission mode from MemberView without fetching config', async () => {
    const project = mockProject();
    const member = project.backend.findMember('fe-1')!;
    member.model = 'fictional-public-model';
    member.permissionMode = 'plan';
    project.render(
      <Routes>
        <Route path="/sessions/:sessionId" element={<SessionPage />} />
      </Routes>,
      '/sessions/ses_ac21_fe1',
      { can: { createTasks: false, manageTeam: false, workInSessions: false } },
    );
    expect(
      await screen.findByText(t('session.chips.model', { model: 'fictional-public-model' })),
    ).toBeTruthy();
    expect(
      screen.getByText(t('session.chips.permissions', { mode: t('permissionModes.plan') })),
    ).toBeTruthy();
    expect(project.requests.some((request) => request.path.endsWith('/config'))).toBe(false);
    expect(screen.getByText(t('session.chat.brief'))).toBeTruthy();
  });
});
