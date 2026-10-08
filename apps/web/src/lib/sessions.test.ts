import { describe, expect, it } from 'vitest';
import { SESSION_IDLE_CLOSE_MINUTES } from '@projectman/shared';
import type { MemberView, SessionStop, TimelineEvent } from '@projectman/shared';
import { t } from '../i18n/t';
import { indexMembers } from './members';
import { indexPipeline } from './pipeline';
import { closureTexts, eventClosure, sessionClosure } from './sessions';
import { describeEvent } from './timeline';

const members = indexMembers([
  { handle: 'owner', displayName: 'Ist1', kind: 'human', role: 'owner' },
  { handle: 'claude', displayName: 'Vezető Fejlesztő', kind: 'ai', role: 'lead-developer' },
] as unknown as MemberView[]);
const pipeline = indexPipeline({
  stages: [{ id: 'review', name: 'Átnézés', kind: 'step' }],
  columns: [{ id: 'review', name: 'Átnézés', stageIds: ['review'] }],
} as unknown as Parameters<typeof indexPipeline>[0]);
const ctx = { pipeline, members, myHandle: 'owner' };

const text = (stop: SessionStop, context = ctx) => closureTexts(stop, context);

describe('what closes a session', () => {
  const closing: SessionStop['kind'][] = [
    'step_done',
    'idle',
    'card_done',
    'task_cancelled',
    'sent_back',
    'pause',
    'manual',
    'assignee_change',
    'loop_stopped',
    'fix_limit_reassign',
  ];
  it.each(closing)('counts %s of an exited session', (kind) => {
    expect(sessionClosure({ state: 'exited', lastStop: { kind } })).toEqual({ kind });
  });

  it.each([
    'login_lost',
    'restart',
    'workspace',
    'exited',
    'failed',
    'server_restart',
    'member_retired',
  ] as const)('leaves %s as a plain stop', (kind) => {
    expect(sessionClosure({ state: 'exited', lastStop: { kind } })).toBeNull();
  });

  it('needs an exited session with a reason', () => {
    expect(sessionClosure({ state: 'exited' })).toBeNull();
    expect(sessionClosure({ state: 'failed', lastStop: { kind: 'idle' } })).toBeNull();
    expect(sessionClosure({ state: 'idle', lastStop: { kind: 'idle' } })).toBeNull();
  });

  it('applies the same rule to a session_ended event', () => {
    expect(eventClosure({ exitCode: 0, stop: { kind: 'idle' } })).toEqual({ kind: 'idle' });
    expect(eventClosure({ exitCode: null, stop: { kind: 'idle' } })).toEqual({ kind: 'idle' });
    expect(eventClosure({ exitCode: 1, stop: { kind: 'idle' } })).toBeNull();
    expect(eventClosure({ exitCode: 0, stop: { kind: 'login_lost' } })).toBeNull();
    expect(eventClosure({ exitCode: 0, stop: { kind: 'nonsense' } })).toBeNull();
    expect(eventClosure({ exitCode: 0 })).toBeNull();
  });
});

describe('the texts of a closed session', () => {
  it('names the step and the stage a finished step moved the card to', () => {
    const texts = text({ kind: 'step_done', taskKey: 'PM-1', stageId: 'review' });
    expect(texts.label).toBe('Lezárva');
    expect(texts.hint).toBe('Lezárva, folytatható · lépés kész');
    expect(texts.list).toBe('Lezárva · lépés kész');
    expect(texts.note).toBe(
      'Magától lezárult: a lépés kész (PM-1 → Átnézés). Ha írsz, a beszélgetés a korábbi előzménnyel folytatódik.',
    );
    expect(texts.event).toBe('Munkamenet magától lezárult: a lépés kész (PM-1 → Átnézés)');
  });

  it('falls back to the stage id, and leaves out what is missing', () => {
    expect(text({ kind: 'step_done', taskKey: 'PM-1', stageId: 'gone' }).event).toContain('(PM-1 → gone)');
    expect(text({ kind: 'step_done', taskKey: 'PM-1' }).event).toContain('a lépés kész (PM-1)');
    expect(text({ kind: 'step_done' }).event).toBe('Munkamenet magától lezárult: a lépés kész');
    expect(text({ kind: 'sent_back', taskKey: 'PM-1' }).event).toContain('visszaküldték (PM-1)');
    expect(text({ kind: 'sent_back', taskKey: 'PM-1', stageId: 'review' }).event).toContain(
      'visszaküldték (PM-1 → Átnézés)',
    );
  });

  it('gives the silence in minutes, the default when it is missing', () => {
    expect(text({ kind: 'idle', idleMinutes: 20 }).list).toBe('Lezárva · 20 perc csend');
    expect(text({ kind: 'idle' }).event).toBe(
      `Munkamenet magától lezárult: ${SESSION_IDLE_CLOSE_MINUTES} perc csend után`,
    );
  });

  it('words the other reasons', () => {
    expect(text({ kind: 'card_done', taskKey: 'PM-1' }).event).toContain('a kártya kész (PM-1)');
    expect(text({ kind: 'task_cancelled', taskKey: 'PM-1' }).list).toBe('Lezárva · visszavonva');
    expect(text({ kind: 'pause' }).event).toContain('szünet miatt');
    expect(text({ kind: 'pause' }).list).toBe('Lezárva · szünet');
  });

  it('names who stopped it: another member, nobody, or the viewer', () => {
    const other = text({ kind: 'manual', by: { kind: 'ai', handle: 'claude' } });
    expect(other.list).toBe('Lezárva · leállította: Vezető Fejlesztő');
    expect(other.hint).toBe('Lezárva, folytatható · leállította: Vezető Fejlesztő');
    expect(other.note).toBe(
      'Leállította: Vezető Fejlesztő. Ha írsz, a beszélgetés a korábbi előzménnyel folytatódik.',
    );
    expect(other.event).toBe('Munkamenet lezárva, leállította: Vezető Fejlesztő');

    for (const stop of [
      { kind: 'loop_stopped' as const },
      { kind: 'assignee_change' as const, by: { kind: 'system' as const, handle: null } },
    ]) {
      expect(text(stop).list).toBe(`Lezárva · leállította: ${t('common.system')}`);
    }

    const mine = text({ kind: 'fix_limit_reassign', by: { kind: 'human', handle: 'owner' } });
    expect(mine.list).toBe('Lezárva · leállítottad');
    expect(mine.hint).toBe('Lezárva, folytatható · leállítottad');
    expect(mine.note).toBe('Leállítottad. Ha írsz, a beszélgetés a korábbi előzménnyel folytatódik.');
    expect(mine.event).toBe('Munkamenet lezárva: leállítottad');
  });
});

describe('the session_ended row', () => {
  const ended: TimelineEvent = {
    id: 'evt_1',
    projectKey: 'AC',
    taskKey: 'AC-1',
    sessionId: 'ses_1',
    actor: { kind: 'ai', handle: 'claude' },
    type: 'session_ended',
    data: { member: 'claude', exitCode: 0 },
    createdAt: '2026-10-05T09:00:00.000Z',
  };
  const context = { ...ctx, openInboxIds: new Set<string>() };

  it('reads the reason from data.stop', () => {
    const stop = { kind: 'idle', idleMinutes: 15 };
    expect(describeEvent({ ...ended, data: { ...ended.data, stop } }, context).text).toBe(
      `${t('involvement.verbs.closed')} — ${t('session.closure.long.idle', { n: 15 })}`,
    );
  });

  it('keeps legacy events and unsuccessful closures readable and describes other stops', () => {
    const plain = t('timeline.events.session_ended');
    expect(describeEvent(ended, context).text).toBe(plain);
    expect(
      describeEvent({ ...ended, data: { member: 'claude', exitCode: 1, stop: { kind: 'idle' } } }, context)
        .text,
    ).toBe(plain);
    expect(
      describeEvent(
        { ...ended, data: { member: 'claude', exitCode: 0, stop: { kind: 'login_lost' } } },
        context,
      ).text,
    ).toBe(`${t('involvement.verbs.ended')} — ${t('involvement.stops.login_lost')}`);
  });
});
