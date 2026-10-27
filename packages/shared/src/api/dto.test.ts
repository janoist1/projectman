import { expect, it } from 'vitest';
import { BoardView, Me, RoleView } from './dto';

it.each([
  ['instance ownership', Me.pick({ instanceOwner: true }), { instanceOwner: false }],
  ['role guidance', RoleView.pick({ whenToAsk: true }), { whenToAsk: '' }],
  ['AI admission', BoardView.pick({ aiEnabled: true }), { aiEnabled: false }],
] as const)('requires the server to supply %s', (_name, schema, value) => {
  expect(schema.safeParse({}).success).toBe(false);
  expect(schema.parse(value)).toEqual(value);
});
