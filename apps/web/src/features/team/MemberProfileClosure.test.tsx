import { screen, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import type { Session, SessionStop } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { formatStamp } from '../../i18n/format';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { MemberProfilePage } from './MemberProfilePage';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

const page = (
  <Routes>
    <Route path="/team/:handle" element={<MemberProfilePage />} />
  </Routes>
);

/** A session of fe-1 of the given kind of work and state, started at a time of its own. */
function addSession(
  project: ReturnType<typeof mockProject>,
  id: string,
  workItem: Session['workItem'],
  state: Session['state'],
  startedAt: string,
  stop?: SessionStop,
) {
  project.backend.sessions.push({
    ...project.backend.findSession('ses_ac21_fe1')!,
    id,
    workItem,
    state,
    startedAt,
    lastActivityAt: startedAt,
    ...(stop ? { lastStop: stop } : {}),
  });
}

describe('the sessions on a member profile (PM-296)', () => {
  it('adds a quiet reason to a past session that rests, nothing to the others', async () => {
    const project = mockProject();
    const closedAt = '2026-09-01T08:00:00.000Z';
    addSession(project, 'ses_p_closed', { type: 'task', taskKey: 'AC-21' }, 'exited', closedAt, {
      kind: 'step_done',
      taskKey: 'AC-21',
    });
    addSession(
      project,
      'ses_p_plain',
      { type: 'task', taskKey: 'AC-20' },
      'exited',
      '2026-09-02T08:00:00.000Z',
    );
    addSession(
      project,
      'ses_p_failed',
      { type: 'task', taskKey: 'AC-18' },
      'failed',
      '2026-09-03T08:00:00.000Z',
      {
        kind: 'idle',
      },
    );
    project.render(page, '/team/fe-1');
    const heading = await screen.findByRole('heading', { name: t('profile.sessions') });
    const list = heading.nextElementSibling as HTMLElement;
    const rows = within(list).getAllByRole('listitem');
    const row = (key: string) => rows.find((entry) => entry.textContent!.startsWith(key))!;
    expect(row('AC-21').textContent).toBe(`AC-21 · ${formatStamp(closedAt)} · Lezárva · lépés kész`);
    expect(row('AC-20').textContent).not.toContain('Lezárva');
    expect(row('AC-18').textContent).not.toContain('Lezárva');
  });

  it('names the real kind of work of a live and of a past session', async () => {
    const project = mockProject();
    addSession(
      project,
      'ses_p_sched',
      { type: 'schedule', runId: 'run_1' },
      'working',
      '2026-09-04T08:00:00.000Z',
    );
    addSession(
      project,
      'ses_p_meeting',
      { type: 'meeting', meetingId: 'mtg_1' },
      'exited',
      '2026-09-05T08:00:00.000Z',
    );
    addSession(project, 'ses_p_general', { type: 'general' }, 'exited', '2026-09-06T08:00:00.000Z');
    project.render(page, '/team/fe-1');
    const live = await screen.findByRole('link', {
      name: `${t('profile.openSession')} · ${t('pause.progress.work.schedule')}`,
    });
    expect(live).toBeTruthy();
    const heading = await screen.findByRole('heading', { name: t('profile.sessions') });
    const list = within(heading.nextElementSibling as HTMLElement);
    expect(list.getByText(new RegExp(`^${t('pause.progress.work.meeting')} ·`))).toBeTruthy();
    expect(list.getByText(new RegExp(`^${t('pause.progress.work.general')} ·`))).toBeTruthy();
  });
});
