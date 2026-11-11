import { expect, it } from 'vitest';
import { BoardView, Me, OperatorMemberChanges, PlanUsage, RoleView, UpdateMemberRequest } from './dto';

it('drops the five-hour fields of an older engine answer and keeps the weekly ones (PM-1293)', () => {
  const old = {
    fiveHourPercent: 42,
    fiveHourResetsAt: '2026-01-01T05:00:00.000Z',
    weeklyPercent: 17.5,
    weeklyResetsAt: null,
    fetchedAt: '2026-01-01T00:00:00.000Z',
  };
  expect(PlanUsage.parse(old)).toEqual({
    weeklyPercent: 17.5,
    weeklyResetsAt: null,
    fetchedAt: '2026-01-01T00:00:00.000Z',
  });
});

it.each([
  ['a member update', UpdateMemberRequest],
  ['an Operator member change', OperatorMemberChanges],
] as const)('refuses a separate mailbox name in %s, naming the card (PM-1039)', (_name, schema) => {
  const result = schema.safeParse({ email: { enabled: true, mailbox: 'builder' } });
  expect(result.success).toBe(false);
  expect(result.error?.issues.map((issue) => issue.message).join(' ')).toContain('PM-1039');
  expect(schema.safeParse({ email: { enabled: true } }).success).toBe(true);
});

it.each([
  ['instance ownership', Me.pick({ instanceOwner: true }), { instanceOwner: false }],
  ['role guidance', RoleView.pick({ whenToAsk: true }), { whenToAsk: '' }],
  ['AI admission', BoardView.pick({ aiEnabled: true }), { aiEnabled: false }],
] as const)('requires the server to supply %s', (_name, schema, value) => {
  expect(schema.safeParse({}).success).toBe(false);
  expect(schema.parse(value)).toEqual(value);
});
