import { describe, expect, it } from 'vitest';
import type { FixLimitDecisionPayload } from '@projectman/shared';
import { formatFixLimitItem } from './fix-limit-text';

type Config = Parameters<typeof formatFixLimitItem>[0];

const config = (language: 'hu' | 'en'): Config =>
  ({
    project: { language, timezone: 'Europe/Budapest' },
    team: {
      members: [
        { kind: 'ai', handle: 'lead', displayName: 'Vezető', role: 'lead_developer', sponsor: 'owner' },
        { kind: 'ai', handle: 'cr', displayName: 'Átnéző', role: 'code_reviewer', sponsor: 'owner' },
      ],
    },
  }) as unknown as Config;

const fixLimit: FixLimitDecisionPayload = {
  taskKey: 'AR-1',
  rounds: 3,
  limit: 3,
  changeRequests: 2,
  designChangeRequests: 0,
  sendBacks: 1,
  testsFailed: 1,
  extraRounds: 1,
  remainingExtraRounds: 2,
  extraRoundLimit: 3,
  reason: 'passed_on',
  decider: 'lead',
  note: 'Nem az én döntésem.',
  assessment: {
    recurrence: 'Ugyanaz a teszt bukik újra.',
    currentState: 'A javítás félkész.',
    recommendation: { optionId: 'reassign', reason: 'Friss szem kell.' },
  },
  history: [
    {
      kind: 'code_review',
      round: 1,
      at: '2026-10-18T08:00:00.000Z',
      actor: { kind: 'ai', handle: 'cr' },
      note: 'Első javítás',
    },
    {
      kind: 'tests_failed',
      round: 2,
      at: '2026-10-18T09:00:00.000Z',
      actor: { kind: 'system', handle: null },
      command: 'npm test',
    },
    {
      kind: 'branch_moved',
      round: null,
      at: '2026-10-18T09:30:00.000Z',
      actor: { kind: 'system', handle: null },
      pinned: 'aaaaaaaa11111111',
      head: 'bbbbbbbb22222222',
    },
    {
      kind: 'extra_round',
      round: null,
      at: '2026-10-18T10:00:00.000Z',
      actor: { kind: 'ai', handle: 'lead' },
      extraRound: 1,
      note: 'Még egyet.',
    },
  ],
} as FixLimitDecisionPayload;

describe('formatFixLimitItem', () => {
  it('writes the summary, the assessment, every round and every option in the project language', () => {
    const content = formatFixLimitItem(
      config('hu'),
      fixLimit,
      ['replan', 'reassign', 'another_round'],
      'integrator',
    );
    expect(content.title).toBe('Javítási körök határa: AR-1');
    expect(content.body).toContain('AR-1');
    expect(content.body).toContain('Vezető továbbadta.');
    expect(content.body).toContain('Extra kör: 1 kiadva a 3-ból, 2 maradt.');
    expect(content.body).toContain('Vezető véleménye');
    expect(content.body).toContain('Ismétlődik? Ugyanaz a teszt bukik újra.');
    expect(content.body).toContain('Hol tart most? A javítás félkész.');
    expect(content.body).toContain('Körök (2):');
    expect(content.body).toContain('Kódátnézés · Átnéző');
    expect(content.body).toContain('Első javítás');
    expect(content.body).toContain('Bukott teljes teszt: npm test');
    expect(content.body).toContain('aaaaaaaa → bbbbbbbb');
    expect(content.body).toContain('Még egy kör (1/3) · Vezető');
    for (const id of ['replan', 'reassign', 'another_round']) expect(content.body).toContain(`- ${id} — `);
    expect(content.body).toContain('Friss szem kell.');
    expect(content.options.map((option) => option.id)).toEqual(['replan', 'reassign', 'another_round']);
    expect(content.options.every((option) => option.consequence && option.label !== option.id)).toBe(true);
    expect(content.options.map((option) => option.style)).toEqual(['secondary', 'primary', 'secondary']);
  });

  it('names an outcome that cannot be carried out but does not offer it', () => {
    const content = formatFixLimitItem(config('hu'), fixLimit, ['another_round'], 'owner');
    expect(content.options.map((option) => option.id)).toEqual(['another_round']);
    expect(content.body).toContain('- replan — ');
    expect(content.body).toContain('- reassign — ');
  });

  it('says so when the three extra rounds are used up, and writes an item without history or verdict', () => {
    const plain: FixLimitDecisionPayload = {
      taskKey: 'AR-2',
      rounds: 4,
      limit: 3,
      changeRequests: 4,
      designChangeRequests: 0,
      sendBacks: 0,
      extraRounds: 3,
      remainingExtraRounds: 0,
      reason: 'extra_exhausted',
      decider: null,
      note: null,
    };
    const content = formatFixLimitItem(config('hu'), plain, ['another_round'], 'owner');
    expect(content.body).toContain('A 3 extra kör elfogyott');
    expect(content.body).toContain('nem maradt több');
    expect(content.body).not.toContain('véleménye');
    expect(content.body).not.toContain('Körök (');
    expect(content.options).toHaveLength(1);
  });

  it('writes an old item (no extras, no history) and an English project as well', () => {
    const old: FixLimitDecisionPayload = {
      taskKey: 'AR-3',
      rounds: 3,
      limit: 3,
      changeRequests: 3,
      designChangeRequests: 0,
      sendBacks: 0,
      reason: 'again',
      decider: null,
      note: null,
    };
    expect(formatFixLimitItem(config('hu'), old, ['another_round'], 'owner').body).toContain('AR-3');
    const english = formatFixLimitItem(
      config('en'),
      fixLimit,
      ['replan', 'reassign', 'another_round'],
      'owner',
    );
    expect(english.title).toContain('AR-1');
    expect(english.body).not.toContain('Javítási');
    expect(english.options).toHaveLength(3);
  });
});
