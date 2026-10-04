import { screen, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { TaskDrawer } from './TaskDrawer';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

const drawer = (
  <Routes>
    <Route path="/p/:key/tasks/:taskKey" element={<TaskDrawer />} />
  </Routes>
);

describe('the sessions of a card that rest (PM-296)', () => {
  it('reads "Lezárva" with the short reason, and the dot stays grey', async () => {
    const project = mockProject();
    project.backend.closeSession('ses_ac20_be1', { kind: 'idle', idleMinutes: 15 });
    project.render(drawer, '/p/AC/tasks/AC-20');
    const sessions = (await screen.findByRole('heading', { name: t('task.sessions') })).parentElement!;
    const line = within(sessions).getByText('Lezárva · 15 perc csend');
    expect(line.getAttribute('data-status')).toBe('exited');
    expect(within(sessions).queryByText(t('sessionState.exited'))).toBeNull();
  });

  it('names who stopped it', async () => {
    const project = mockProject();
    project.backend.closeSession('ses_ac20_be1', { kind: 'manual', by: { kind: 'human', handle: 'owner' } });
    project.render(drawer, '/p/AC/tasks/AC-20');
    const sessions = (await screen.findByRole('heading', { name: t('task.sessions') })).parentElement!;
    expect(within(sessions).getByText('Lezárva · leállítottad')).toBeTruthy();
  });

  it('keeps "Leállt" for another stop and for an old session without a reason', async () => {
    const project = mockProject();
    project.backend.updateSession('ses_ac20_be1', { state: 'exited', lastStop: { kind: 'login_lost' } });
    project.render(drawer, '/p/AC/tasks/AC-20');
    const sessions = (await screen.findByRole('heading', { name: t('task.sessions') })).parentElement!;
    expect(within(sessions).getByText(t('sessionState.exited'))).toBeTruthy();
    expect(within(sessions).queryByText(/Lezárva/)).toBeNull();
  });
});
