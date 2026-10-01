import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Task, TaskDetail, routes } from '@projectman/shared';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

let h: AppHarness;
const cookies: Record<string, string> = {};
beforeEach(async () => {
  h = await createAppHarness();
  cookies.owner = await setupOwner(h.app);
  await createProject(h, cookies.owner);
  cookies.developer = await addHumanAndLogin(h.app, { handle: 'robin', access: 'developer' });
  cookies.viewer = await addHumanAndLogin(h.app, { handle: 'vera', access: 'viewer' });
  cookies.client = await addHumanAndLogin(h.app, { handle: 'cecil', access: 'client' });
});
afterEach(() => h.close());
const call = (who: string, method: 'POST' | 'PATCH' | 'GET', url: string, payload?: object) =>
  inject(h.app, method, url, cookies[who]!, payload);
const create = async (title: string, extra: object = {}) =>
  Task.parse((await call('owner', 'POST', routes.tasks('AR'), { title, ...extra })).json());

describe('card relations over REST', () => {
  it('adds and removes all four kinds with PATCH, and reads them back from the links', async () => {
    const [one, two, three, four] = [
      await create('One'),
      await create('Two'),
      await create('Three'),
      await create('Four'),
    ];
    const added = await call('developer', 'PATCH', routes.task('AR', one.key), {
      relations: {
        add: [
          { kind: 'part_of', key: two.key },
          { kind: 'prerequisite', key: three.key },
          { kind: 'related', key: four.key },
        ],
      },
    });
    expect(added.statusCode).toBe(200);
    const task = Task.parse(added.json());
    expect(task.parentKey).toBe(two.key);
    expect(task.links).toEqual([
      { kind: 'prerequisite', ref: three.key },
      { kind: 'related', ref: four.key },
    ]);
    const duplicated = await call('developer', 'PATCH', routes.task('AR', four.key), {
      relations: { add: [{ kind: 'duplicate_of', key: three.key }] },
    });
    expect(Task.parse(duplicated.json())).toMatchObject({ status: 'cancelled' });
    const detail = TaskDetail.parse((await call('owner', 'GET', routes.task('AR', two.key))).json());
    expect(detail.subtasks?.map((t) => t.key)).toEqual([one.key]);
    const removed = await call('owner', 'PATCH', routes.task('AR', three.key), {
      relations: { remove: [{ kind: 'prerequisite_of', key: one.key }] },
    });
    expect(removed.statusCode).toBe(200);
    const list = z_tasks((await call('owner', 'GET', routes.tasks('AR'))).json());
    expect(list.find((t) => t.key === one.key)!.links).toEqual([{ kind: 'related', ref: four.key }]);
  });

  it('creates a card with relations with POST', async () => {
    const one = await create('One');
    const made = await call('developer', 'POST', routes.tasks('AR'), {
      title: 'Next',
      relations: [{ kind: 'prerequisite', key: one.key }],
    });
    expect(made.statusCode).toBe(201);
    expect(Task.parse(made.json()).links).toEqual([{ kind: 'prerequisite', ref: one.key }]);
  });

  it('refuses with the reason: a loop, itself, a missing card, a kind that cannot be added', async () => {
    const one = await create('One');
    const two = await create('Two');
    await call('owner', 'PATCH', routes.task('AR', one.key), {
      relations: { add: [{ kind: 'prerequisite', key: two.key }] },
    });
    const code = async (key: string, relations: object) => {
      const res = await call('owner', 'PATCH', routes.task('AR', key), { relations });
      return [res.statusCode, res.json().error.code, res.json().error.message];
    };
    expect(await code(two.key, { add: [{ kind: 'prerequisite', key: one.key }] })).toEqual([
      400,
      'relation_cycle',
      `that would make a loop of prerequisites: ${two.key} needs ${one.key} needs ${two.key}`,
    ]);
    expect((await code(one.key, { add: [{ kind: 'related', key: one.key }] }))[1]).toBe('relation_self');
    expect((await code(one.key, { add: [{ kind: 'related', key: 'AR-99' }] }))[1]).toBe(
      'relation_target_not_found',
    );
    expect((await code(one.key, { add: [{ kind: 'prerequisite_of', key: two.key }] }))[1]).toBe(
      'invalid_request',
    );
    expect((await code(one.key, { remove: [{ kind: 'related', key: two.key }] }))[1]).toBe(
      'relation_not_found',
    );
  });

  it('lets a developer mark a card that has not started as a duplicate, and only an admin or owner one that has', async () => {
    const one = await create('One');
    const two = await create('Two');
    const three = await create('Three');
    const ok = await call('developer', 'PATCH', routes.task('AR', one.key), {
      relations: { add: [{ kind: 'duplicate_of', key: three.key }] },
    });
    expect(ok.statusCode).toBe(200);
    expect(Task.parse(ok.json()).status).toBe('cancelled');
    // A card in a work stage has started.
    await call('owner', 'PATCH', routes.task('AR', two.key), { stageId: 'development' });
    const refused = await call('developer', 'PATCH', routes.task('AR', two.key), {
      relations: { add: [{ kind: 'duplicate_of', key: three.key }] },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('duplicate_not_allowed');
    const done = await call('owner', 'PATCH', routes.task('AR', two.key), {
      relations: { add: [{ kind: 'duplicate_of', key: three.key }] },
    });
    expect(done.statusCode).toBe(200);
  });

  it('is for developers and up: a viewer and a client cannot set relations', async () => {
    const one = await create('One', { visibility: 'shared' });
    const two = await create('Two');
    for (const who of ['viewer', 'client']) {
      const res = await call(who, 'PATCH', routes.task('AR', one.key), {
        relations: { add: [{ kind: 'related', key: two.key }] },
      });
      expect(res.statusCode, who).toBe(403);
    }
    expect(Task.parse((await call('owner', 'GET', routes.tasks('AR'))).json()[0]).links).toEqual([]);
  });

  it('shows a client only the links to the cards shared with them', async () => {
    const shared = await create('Shared', { visibility: 'shared' });
    const other = await create('Other shared', { visibility: 'shared' });
    const internal = await create('Internal');
    await call('owner', 'PATCH', routes.task('AR', shared.key), {
      relations: {
        add: [
          { kind: 'related', key: other.key },
          { kind: 'prerequisite', key: internal.key },
        ],
      },
    });
    const seen = z_tasks((await call('client', 'GET', routes.tasks('AR'))).json());
    expect(seen.map((t) => t.key)).toEqual([shared.key, other.key]);
    expect(seen[0]!.links).toEqual([{ kind: 'related', ref: other.key }]);
    const detail = TaskDetail.parse((await call('client', 'GET', routes.task('AR', shared.key))).json());
    expect(detail.task.links).toEqual([{ kind: 'related', ref: other.key }]);
    const asDeveloper = z_tasks((await call('developer', 'GET', routes.tasks('AR'))).json());
    expect(asDeveloper[0]!.links).toHaveLength(2);
  });
});

function z_tasks(json: unknown): Task[] {
  return (json as unknown[]).map((item) => Task.parse(item));
}
