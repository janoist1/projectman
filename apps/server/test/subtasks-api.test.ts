import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Task, TaskDetail, routes } from '@projectman/shared';
import { createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

let h: AppHarness;
let cookie: string;
beforeEach(async () => {
  h = await createAppHarness();
  cookie = await setupOwner(h.app);
  await createProject(h, cookie);
});
afterEach(() => h.close());
const call = (method: 'POST' | 'PATCH' | 'GET', url: string, payload?: object) =>
  inject(h.app, method, url, cookie, payload);

describe('subtask HTTP contracts', () => {
  it('creates, attaches and clears parents through POST and PATCH', async () => {
    const parent = Task.parse((await call('POST', routes.tasks('AR'), { title: 'Parent' })).json());
    const created = await call('POST', routes.tasks('AR'), { title: 'Child', parentKey: parent.key });
    expect(created.statusCode).toBe(201);
    const child = Task.parse(created.json());
    expect(child.parentKey).toBe(parent.key);
    const detached = await call('PATCH', routes.task('AR', child.key), { parentKey: null });
    expect(detached.statusCode).toBe(200);
    expect(Task.parse(detached.json()).parentKey).toBeNull();
    const attached = await call('PATCH', routes.task('AR', child.key), { parentKey: parent.key });
    expect(Task.parse(attached.json()).parentKey).toBe(parent.key);
    const detail = TaskDetail.parse((await call('GET', routes.task('AR', parent.key))).json());
    expect(detail.subtasks?.map((task) => task.key)).toEqual([child.key]);
    const refused = await call('PATCH', routes.task('AR', parent.key), { parentKey: child.key });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('subtask_parent_is_subtask');
  });
});
