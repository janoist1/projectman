import type { CapacityHolder } from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import { t } from '../i18n/t';
import {
  capacityChip,
  capacityFrom,
  capacityHint,
  capacityIntro,
  capacityOf,
  capacityReason,
  capacityRows,
  onlyCardKey,
} from './capacity';

const NOW = new Date('2026-10-11T16:26:00');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

function holder(kind: CapacityHolder['kind'], patch: { quiet?: number } & Partial<CapacityHolder> = {}) {
  const { quiet = 6, ...rest } = patch;
  return {
    kind,
    working: false,
    startedAt: minutesAgo(40),
    lastActivityAt: minutesAgo(quiet),
    ...(kind === 'task' ? { taskKey: 'PM-12' } : {}),
    ...rest,
  } satisfies CapacityHolder;
}

const capacity = (holders: CapacityHolder[], max = holders.length) => capacityFrom(holders, max, 15)!;
const hint = (holders: CapacityHolder[], max?: number) =>
  capacityHint(capacity(holders, max), 'Fejlesztő', NOW);
const at = (time: string) => t('taskStatus.startHints.capacityAt', { time });

describe('what holds the places of a member (PM-297)', () => {
  it('knows nothing without holders: an older server, or the places have freed up', () => {
    expect(capacityFrom(undefined)).toBeNull();
    expect(capacityFrom([])).toBeNull();
    expect(capacityOf({ reason: 'member_at_capacity' })).toBeNull();
    // Only a wait for capacity has them.
    expect(capacityOf({ reason: 'team_paused', holders: [holder('general')] })).toBeNull();
    expect(capacityOf({ reason: 'member_at_capacity', holders: [holder('general')] })).not.toBeNull();
  });

  describe('the hint', () => {
    it('says when a chat that is idle closes and the card starts', () => {
      // Last entry 6 minutes ago, 15 minutes of silence: 16:35.
      expect(hint([holder('general')])).toBe(
        `${t('taskStatus.startHints.capacity.general', { n: 15 })} ${at('16:35')}`,
      );
    });

    it('gives no time for a chat in the middle of a turn', () => {
      expect(hint([holder('general', { working: true })])).toBe(
        t('taskStatus.startHints.capacity.general', { n: 15 }),
      );
    });

    it('says the same of a schedule run', () => {
      expect(hint([holder('schedule', { quiet: 3 })])).toBe(
        `${t('taskStatus.startHints.capacity.schedule', { n: 15 })} ${at('16:38')}`,
      );
    });

    it('holds the place to the end of a meeting, with no time', () => {
      expect(hint([holder('meeting', { working: true, quiet: 1 })])).toBe(
        t('taskStatus.startHints.capacity.meeting'),
      );
      expect(hint([holder('meeting', { quiet: 1 })])).toBe(t('taskStatus.startHints.capacity.meeting'));
    });

    it('waits for the card to finish its step, with a time only when it is quiet', () => {
      const text = t('taskStatus.startHints.capacity.task', { name: 'Fejlesztő' });
      expect(hint([holder('task', { working: true })])).toBe(text);
      expect(hint([holder('task', { quiet: 9 })])).toBe(`${text} ${at('16:32')}`);
    });

    it('takes the earliest silence limit among those that can close, for several holders', () => {
      const several = t('taskStatus.startHints.capacity.several', { name: 'Fejlesztő', n: 15 });
      // A card at work does not count; the chat closes at 16:32.
      expect(hint([holder('task', { working: true, quiet: 1 }), holder('general', { quiet: 9 })], 2)).toBe(
        `${several} ${at('16:32')}`,
      );
      // Two chats: the one quiet for 13 minutes closes first, at 16:28.
      expect(hint([holder('general', { quiet: 4 }), holder('general', { quiet: 13 })], 2)).toBe(
        `${several} ${at('16:28')}`,
      );
      // A meeting is not waited for by the clock.
      expect(hint([holder('meeting'), holder('general', { quiet: 9 })], 2)).toBe(`${several} ${at('16:32')}`);
    });

    it('omits the time when every holder is at work', () => {
      const several = t('taskStatus.startHints.capacity.several', { name: 'Fejlesztő', n: 15 });
      expect(hint([holder('task', { working: true }), holder('general', { working: true })], 2)).toBe(
        several,
      );
    });

    it('says "soon" when the time has passed', () => {
      expect(hint([holder('general', { quiet: 20 })])).toBe(
        `${t('taskStatus.startHints.capacity.general', { n: 15 })} ${t('taskStatus.startHints.capacitySoon')}`,
      );
    });

    it('takes the silence limit from the contract', () => {
      const wide = capacityFrom([holder('general')], 1, 30)!;
      expect(capacityHint(wide, 'Fejlesztő', NOW)).toContain(
        t('taskStatus.startHints.capacity.general', { n: 30 }),
      );
      expect(capacityHint(wide, 'Fejlesztő', NOW)).toContain(at('16:50'));
    });
  });

  describe('the short reason of the card row', () => {
    it('names the only holder', () => {
      expect(capacityReason(capacity([holder('general')]))).toBe(t('taskStatus.next.capacityKinds.general'));
      expect(capacityReason(capacity([holder('schedule')]))).toBe(
        t('taskStatus.next.capacityKinds.schedule'),
      );
      expect(capacityReason(capacity([holder('meeting')]))).toBe(t('taskStatus.next.capacityKinds.meeting'));
      expect(capacityReason(capacity([holder('task')]))).toBe(
        t('taskStatus.next.capacityKinds.task', { keys: 'PM-12' }),
      );
    });

    it('says "another card" when the viewer cannot see the key', () => {
      expect(capacityReason(capacity([holder('task', { taskKey: undefined })]))).toBe(
        t('taskStatus.next.capacityKinds.taskHidden'),
      );
    });

    it('leaves it to today’s sentence for several holders', () => {
      expect(capacityReason(capacity([holder('general'), holder('general')], 2))).toBeNull();
      expect(capacityReason(capacity([holder('task'), holder('general')], 2))).toBeNull();
    });
  });

  it('introduces the list by the number of places', () => {
    expect(capacityIntro(capacity([holder('general')]))).toBe(t('task.whyBox.capacityOne'));
    expect(capacityIntro(capacity([holder('general'), holder('schedule')], 2))).toBe(
      t('task.whyBox.capacityMany', { max: 2 }),
    );
  });

  describe('the rows', () => {
    it('gives each holder its name, link and meta', () => {
      const rows = capacityRows(
        capacity([
          holder('task', { working: true, taskKey: 'PM-12' }),
          holder('general', { sessionId: 'ses_1', quiet: 6 }),
          holder('meeting', { sessionId: 'ses_2', startedAt: minutesAgo(20), working: true }),
          holder('task', { taskKey: undefined, quiet: 3 }),
        ]),
        new Map([['PM-12', 'Kártyák szűrése']]),
        NOW,
      );
      expect(rows).toMatchObject([
        { what: 'PM-12', title: 'Kártyák szűrése', meta: t('task.whyBox.capacityWorking'), taskKey: 'PM-12' },
        {
          what: t('task.whyBox.capacityRow.general'),
          meta: t('task.whyBox.capacityLastEntry', { ago: t('time.minutesAgo', { count: 6 }) }),
          sessionId: 'ses_1',
          taskKey: null,
        },
        {
          what: t('task.whyBox.capacityRow.meeting'),
          meta: t('task.whyBox.capacityMeeting', { ago: t('time.minutesAgo', { count: 20 }) }),
          sessionId: 'ses_2',
        },
        { what: t('task.whyBox.capacityRow.taskHidden'), taskKey: null, sessionId: null, title: null },
      ]);
    });
  });

  describe('the strip', () => {
    it('shows the keys in mono and the other kinds in words', () => {
      expect(capacityChip(capacity([holder('task'), holder('general')], 2))).toEqual({
        keys: 'PM-12',
        kinds: t('taskStatus.capacityNames.general'),
      });
      expect(capacityChip(capacity([holder('task', { taskKey: undefined })]))).toEqual({
        keys: null,
        kinds: t('taskStatus.capacityNames.taskHidden'),
      });
      expect(capacityChip(capacity([holder('general'), holder('general')], 2))).toEqual({
        keys: null,
        kinds: t('taskStatus.capacityNames.general'),
      });
    });

    it('leads to the card only when it is the one visible holder', () => {
      expect(onlyCardKey(capacity([holder('task')]))).toBe('PM-12');
      expect(onlyCardKey(capacity([holder('task'), holder('general')], 2))).toBeNull();
      expect(onlyCardKey(capacity([holder('task', { taskKey: undefined })]))).toBeNull();
    });
  });
});
