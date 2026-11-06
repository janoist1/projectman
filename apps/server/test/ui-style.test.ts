import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Me } from '@projectman/shared';
import { routes } from '@projectman/shared';
import { createAppHarness, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

let h: AppHarness;
let cookie: string;

beforeEach(async () => {
  h = await createAppHarness();
  cookie = await setupOwner(h.app);
});
afterEach(async () => {
  await h.close();
});

const me = async () => (await inject(h.app, 'GET', routes.me(), cookie)).json() as Me;

it('shows no style until the user chooses one, then keeps the choice (PM-363)', async () => {
  expect((await me()).uiStyle).toBeUndefined();
  const saved = await inject(h.app, 'PUT', routes.meUiStyle(), cookie, { style: 'win311' });
  expect(saved.statusCode).toBe(200);
  expect((saved.json() as Me).uiStyle).toBe('win311');
  expect((await me()).uiStyle).toBe('win311');
});

it('refuses a style that does not exist (PM-363)', async () => {
  const res = await inject(h.app, 'PUT', routes.meUiStyle(), cookie, { style: 'neon' });
  expect(res.statusCode).toBe(400);
});
