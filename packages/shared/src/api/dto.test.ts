import { expect, it } from 'vitest';
import { BoardView, Me, OperatorMemberChanges, RoleView, UpdateMemberRequest } from './dto';

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
