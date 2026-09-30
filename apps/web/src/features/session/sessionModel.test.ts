import type { ChatItem, Session } from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/t';
import { sessions } from '../../mocks/fixtures';
import { liveState, sessionTitle, shortPath } from './sessionModel';
import { withoutEchoed } from './usePendingEchoes';

const session = sessions.find((entry) => entry.id === 'ses_ac21_fe1')!;
const withItem = (workItem: Session['workItem']): Session => ({ ...session, workItem });
const noSchedule = { scheduledFor: undefined, timezone: undefined };

describe('sessionTitle', () => {
  it("names the task, else the member's conversation or meeting", () => {
    expect(sessionTitle(session, { title: 'Fictional task' }, 'Anna', noSchedule)).toBe('Fictional task');
    expect(sessionTitle(withItem({ type: 'general' }), null, 'Anna', noSchedule)).toBe(
      t('session.general', { member: 'Anna' }),
    );
    expect(sessionTitle(withItem({ type: 'meeting', meetingId: 'm1' }), null, 'Anna', noSchedule)).toBe(
      t('session.meeting', { member: 'Anna' }),
    );
  });

  it('names a scheduled run by its time in the project time zone', () => {
    const title = sessionTitle(withItem({ type: 'schedule', runId: 'run_1' }), null, 'Anna', {
      scheduledFor: '2026-09-30T06:00:00.000Z',
      timezone: 'Europe/Budapest',
    });
    expect(title).toContain(' 8:00');
  });
});

describe('liveState', () => {
  it('puts a permission waiting for the viewer first', () => {
    expect(liveState({ state: 'waiting_permission' }, true)).toEqual({
      status: 'needs_you',
      label: t('sessionState.needsYou'),
    });
    expect(liveState({ state: 'working' }, false)).toEqual({
      status: 'working',
      label: t('sessionState.working'),
    });
    expect(liveState({ state: 'waiting_input' }, false).status).toBe('idle');
    expect(liveState({ state: 'failed' }, false).status).toBe('failed');
    expect(liveState({ state: 'exited' }, false).status).toBe('exited');
  });
});

describe('shortPath', () => {
  it('keeps the last two folders', () => {
    expect(shortPath('/Users/owner/.projectman/worktrees/AC/AC-21')).toBe('…/AC/AC-21');
    expect(shortPath('/srv/app')).toBe('/srv/app');
  });
});

describe('withoutEchoed', () => {
  const sentAt = '2026-09-30T10:00:00.000Z';
  const echo = { id: 'local-1', text: 'Fictional question ', failed: false, sentAt };
  const typed = (text: string, ts: string): ChatItem => ({
    id: 'c1',
    ts,
    kind: 'user_text',
    origin: 'human',
    text,
  });

  it('drops an echo once the transcript shows the message, allowing for clock skew', () => {
    expect(withoutEchoed([echo], [typed('Fictional question', '2026-09-30T09:59:00.000Z')])).toEqual([]);
  });

  it('keeps echoes of other or older messages', () => {
    expect(withoutEchoed([echo], [typed('Other text', sentAt)])).toEqual([echo]);
    expect(withoutEchoed([echo], [typed('Fictional question', '2026-09-30T09:50:00.000Z')])).toEqual([echo]);
  });
});
