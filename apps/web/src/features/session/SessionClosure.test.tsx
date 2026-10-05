import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionStop } from '@projectman/shared';
import { applyServerEvent } from '../../api/cache';
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

const resume = t('session.closure.resume');

/** A copy of a task session of the fixtures that has ended, with the reason the server records. */
function closedSession(
  project: ReturnType<typeof mockProject>,
  stop: SessionStop | undefined,
  id = 'ses_closed',
) {
  project.backend.sessions.push({
    ...project.backend.findSession('ses_ac21_fe1')!,
    id,
    workItem: { type: 'task', taskKey: 'AC-21' },
    state: 'idle',
  });
  if (stop) project.backend.closeSession(id, stop);
  else project.backend.updateSession(id, { state: 'exited', activity: null });
  return id;
}

describe('a closed session (PM-296)', () => {
  const kinds: Array<[string, SessionStop, string, string]> = [
    [
      'step_done',
      { kind: 'step_done', taskKey: 'AC-21', stageId: 'review' },
      'lépés kész',
      'Magától lezárult: a lépés kész (AC-21 → ',
    ],
    ['idle', { kind: 'idle', idleMinutes: 15 }, '15 perc csend', 'Magától lezárult: 15 perc csend után.'],
    [
      'card_done',
      { kind: 'card_done', taskKey: 'AC-21' },
      'kártya kész',
      'Magától lezárult: a kártya kész (AC-21).',
    ],
    [
      'task_cancelled',
      { kind: 'task_cancelled', taskKey: 'AC-21' },
      'visszavonva',
      'Magától lezárult: a kártyát visszavonták (AC-21).',
    ],
    [
      'sent_back',
      { kind: 'sent_back', taskKey: 'AC-21', stageId: 'dev' },
      'visszaküldve',
      'Magától lezárult: a kártyát visszaküldték (AC-21 → ',
    ],
    ['pause', { kind: 'pause' }, 'szünet', 'Magától lezárult: szünet miatt.'],
    [
      'manual',
      { kind: 'manual', by: { kind: 'ai', handle: 'fe-1' } },
      'leállította: Frontend fejlesztő',
      'Leállította: Frontend fejlesztő.',
    ],
  ];

  it.each(kinds)(
    'shows %s as "Lezárva" with its reason in the header and above the box',
    async (_kind, stop, short, note) => {
      const project = mockProject();
      const id = closedSession(project, stop);
      project.render(sessionRoute, `/sessions/${id}`);
      await screen.findByRole('heading', { name: project.backend.findTask('AC-21')!.title });
      const status = screen.getAllByRole('status').find((element) => element.textContent === 'Lezárva')!;
      expect(status.getAttribute('data-status')).toBe('exited');
      expect(status.getAttribute('title')).toContain(`Lezárva, folytatható · ${short}`);
      const line = await screen.findByText((text) => text.startsWith(note) && text.endsWith(resume));
      const box = screen.getByLabelText(t('session.composer.label'));
      expect(box.getAttribute('aria-describedby')).toContain(line.parentElement!.id);
      // The message box is not disabled: a new message continues the conversation.
      expect((box as HTMLTextAreaElement).disabled).toBe(false);
    },
  );

  it('writes the reason in the card timeline too', async () => {
    const project = mockProject();
    const id = closedSession(project, { kind: 'idle', idleMinutes: 15 });
    project.render(sessionRoute, `/sessions/${id}`);
    expect(
      (await screen.findAllByText('Munkamenet magától lezárult: 15 perc csend után')).length,
    ).toBeGreaterThan(0);
  });

  it('names the viewer, another member and the system apart', async () => {
    const mine = mockProject();
    const own = closedSession(mine, { kind: 'manual', by: { kind: 'human', handle: 'owner' } });
    mine.render(sessionRoute, `/sessions/${own}`);
    expect(await screen.findByText(`Leállítottad. ${resume}`)).toBeTruthy();
  });

  it('says "Rendszer" when nobody stopped it', async () => {
    const project = mockProject();
    const id = closedSession(project, { kind: 'loop_stopped' });
    project.render(sessionRoute, `/sessions/${id}`);
    expect(await screen.findByText(`Leállította: ${t('common.system')}. ${resume}`)).toBeTruthy();
  });

  it('sends a message written into a closed session to its message endpoint and rests no more', async () => {
    const project = mockProject();
    const id = closedSession(project, { kind: 'idle', idleMinutes: 15 });
    const view = project.render(sessionRoute, `/sessions/${id}`);
    fireEvent.change(await screen.findByLabelText(t('session.composer.label')), {
      target: { value: 'Folytasd, kérlek.' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('common.send') }));
    await waitFor(() =>
      expect(
        project.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/messages')),
      ).toEqual([
        expect.objectContaining({
          path: expect.stringContaining(`/sessions/${id}/messages`),
          body: { text: 'Folytasd, kérlek.' },
        }),
      ]),
    );
    // The session runs again (the server's session event reaches the page): the reason is gone,
    // and so is the line above the box.
    expect(project.backend.findSession(id)!.lastStop).toBeUndefined();
    act(() =>
      applyServerEvent(view.client, {
        type: 'session_upserted',
        projectKey: 'AC',
        session: structuredClone(project.backend.findSession(id)!),
      }),
    );
    await waitFor(() => expect(screen.queryByText(new RegExp(`${resume}$`))).toBeNull());
    expect(screen.queryByText('Lezárva')).toBeNull();
  });

  it('turns "Pihen" into "Lezárva" when the session closes under the open page', async () => {
    const project = mockProject();
    const id = closedSession(project, undefined);
    project.backend.updateSession(id, { state: 'idle' });
    const view = project.render(sessionRoute, `/sessions/${id}`);
    expect(await screen.findByText(t('sessionState.idle'))).toBeTruthy();
    expect(screen.queryByText(new RegExp(resume))).toBeNull();
    project.backend.closeSession(id, { kind: 'step_done', taskKey: 'AC-21' });
    act(() =>
      applyServerEvent(view.client, {
        type: 'session_upserted',
        projectKey: 'AC',
        session: structuredClone(project.backend.findSession(id)!),
      }),
    );
    expect(await screen.findByText('Lezárva')).toBeTruthy();
    expect(screen.getByText(new RegExp(`${resume}$`))).toBeTruthy();
    expect(screen.queryByText(t('sessionState.idle'))).toBeNull();
  });

  it('leaves a failed session as it was, with or without a reason', async () => {
    const project = mockProject();
    const id = closedSession(project, undefined);
    project.backend.updateSession(id, { state: 'failed', lastStop: { kind: 'idle' } });
    project.render(sessionRoute, `/sessions/${id}`);
    const status = await screen.findByText(t('sessionState.failed'));
    expect(status.closest('[role="status"]')!.getAttribute('data-status')).toBe('failed');
    expect(screen.queryByText(new RegExp(resume))).toBeNull();
  });

  it('keeps other stops and old sessions without a reason as "Leállt", with no line above the box', async () => {
    for (const stop of [{ kind: 'login_lost' as const }, undefined]) {
      const project = mockProject();
      const id = closedSession(project, undefined);
      if (stop) project.backend.updateSession(id, { lastStop: stop });
      const view = project.render(sessionRoute, `/sessions/${id}`);
      const status = await screen.findAllByText(t('sessionState.exited'));
      expect(status.length).toBeGreaterThan(0);
      expect(screen.queryByText('Lezárva')).toBeNull();
      expect(screen.queryByText(new RegExp(resume))).toBeNull();
      expect(
        screen.getByLabelText(t('session.composer.label')).getAttribute('aria-describedby'),
      ).not.toContain('-pause');
      view.unmount();
    }
  });

  it('shows only the pause line while the team is paused', async () => {
    const project = mockProject();
    const id = closedSession(project, { kind: 'idle', idleMinutes: 15 });
    project.backend.pauses.pauseProject();
    project.render(sessionRoute, `/sessions/${id}`);
    expect(await screen.findByText(t('session.composer.pausedStopped'))).toBeTruthy();
    expect(screen.queryByText(new RegExp(resume))).toBeNull();
    const header = screen.getAllByRole('status').find((element) => element.textContent === 'Lezárva');
    expect(header).toBeTruthy();
    expect(within(header!).getByText('Lezárva')).toBeTruthy();
  });
});
