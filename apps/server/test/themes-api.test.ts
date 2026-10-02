import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Task, routes } from '@projectman/shared';
import type { ConfigView } from '@projectman/shared';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

/** PM-205: themes over REST: creating, putting cards into them, closing, and what they do not do. */
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
const create = async (title: string, extra: object = {}, who = 'developer') => {
  const response = await call(who, 'POST', routes.tasks('AR'), { title, ...extra });
  expect(response.statusCode).toBe(201);
  return Task.parse(response.json());
};
const errorOf = (response: { json: () => unknown }) =>
  (response.json() as { error: { code: string } }).error.code;

describe('themes over REST', () => {
  it('creates a theme and lists it as one', async () => {
    const theme = await create('Epic', { kind: 'theme', description: 'The big picture.' });
    expect(theme).toMatchObject({ kind: 'theme', title: 'Epic', status: 'active', assignee: null });
    const list = (await call('owner', 'GET', routes.tasks('AR'))).json<Task[]>();
    expect(list.find((t) => t.key === theme.key)).toMatchObject({ kind: 'theme' });
    // A card made without a kind is a task, and carries no theme.
    const card = await create('Card');
    expect(card.kind).toBeUndefined();
    expect(card.themeKey ?? null).toBeNull();
  });

  it('refuses a stage, a repository and a parent on a theme with the reason', async () => {
    const parent = await create('Parent');
    for (const [extra, code] of [
      [{ stageId: 'development' }, 'task_is_theme'],
      [{ repo: 'web' }, 'task_is_theme'],
      [{ parentKey: parent.key }, 'subtask_theme'],
    ] as const) {
      const response = await call('developer', 'POST', routes.tasks('AR'), {
        title: 'Epic',
        kind: 'theme',
        ...extra,
      });
      expect(response.statusCode).toBe(400);
      expect(errorOf(response)).toBe(code);
    }
  });

  it('puts a card into a theme with PATCH and takes it out with null', async () => {
    const theme = await create('Epic', { kind: 'theme' });
    const card = await create('Card');
    const put = await call('developer', 'PATCH', routes.task('AR', card.key), { themeKey: theme.key });
    expect(put.statusCode).toBe(200);
    expect(Task.parse(put.json()).themeKey).toBe(theme.key);
    const detail = (await call('owner', 'GET', routes.task('AR', card.key))).json<{
      task: Task;
      timeline: Array<{ type: string; data: Record<string, unknown> }>;
    }>();
    expect(detail.task.themeKey).toBe(theme.key);
    expect(detail.timeline.filter((e) => e.type === 'task_theme_changed').map((e) => e.data)).toEqual([
      { themeKey: theme.key, previous: null },
    ]);

    const cleared = await call('developer', 'PATCH', routes.task('AR', card.key), { themeKey: null });
    expect(cleared.statusCode).toBe(200);
    expect(Task.parse(cleared.json()).themeKey ?? null).toBeNull();
  });

  it('refuses a theme that is not one, and a subtask’s own theme, with the reason', async () => {
    const theme = await create('Epic', { kind: 'theme' });
    const parent = await create('Parent');
    const child = await create('Child', { parentKey: parent.key });
    const other = await create('Other');
    const refuse = async (key: string, themeKey: string) => {
      const response = await call('developer', 'PATCH', routes.task('AR', key), { themeKey });
      expect(response.statusCode).toBe(400);
      return errorOf(response);
    };
    expect(await refuse(other.key, parent.key)).toBe('theme_not_a_theme');
    expect(await refuse(other.key, 'AR-99')).toBe('theme_not_found');
    expect(await refuse(child.key, theme.key)).toBe('theme_on_subtask');
    expect(await refuse(theme.key, theme.key)).toBe('theme_on_theme');
  });

  it('shows a subtask the theme of its collecting card, in the list and in the detail', async () => {
    const theme = await create('Epic', { kind: 'theme' });
    const parent = await create('Parent', { themeKey: theme.key });
    const child = await create('Child', { parentKey: parent.key });
    const list = (await call('owner', 'GET', routes.tasks('AR'))).json<Task[]>();
    expect(list.find((t) => t.key === child.key)?.themeKey).toBe(theme.key);
    const detail = (await call('owner', 'GET', routes.task('AR', parent.key))).json<{ subtasks: Task[] }>();
    expect(detail.subtasks.map((t) => [t.key, t.themeKey])).toEqual([[child.key, theme.key]]);
  });

  it('does not move, start or cancel a theme', async () => {
    const theme = await create('Epic', { kind: 'theme' });
    const move = await call('owner', 'PATCH', routes.task('AR', theme.key), { stageId: 'development' });
    expect(move.statusCode).toBe(409);
    expect(errorOf(move)).toBe('task_is_theme');
    const start = await call('owner', 'POST', routes.startTask('AR', theme.key), {});
    expect(start.statusCode).toBe(409);
    expect(errorOf(start)).toBe('task_is_theme');
    const assign = await call('owner', 'PATCH', routes.task('AR', theme.key), { assignee: 'dev-1' });
    expect(errorOf(assign)).toBe('task_is_theme');
    const cancel = await call('owner', 'POST', routes.cancelTask('AR', theme.key), {});
    expect(cancel.statusCode).toBe(409);
    expect(errorOf(cancel)).toBe('task_is_theme');
    expect(Task.parse((await call('owner', 'GET', routes.tasks('AR'))).json<unknown[]>()[0])).toMatchObject({
      key: theme.key,
      stageId: 'backlog',
      status: 'active',
      assignee: null,
    });
  });

  it('is closed by a developer, who also reopens it; a viewer and a client cannot', async () => {
    const theme = await create('Epic', { kind: 'theme' });
    for (const who of ['viewer', 'client'])
      expect((await call(who, 'POST', routes.closeTheme('AR', theme.key), {})).statusCode).toBe(403);

    const closed = await call('developer', 'POST', routes.closeTheme('AR', theme.key), {});
    expect(closed.statusCode).toBe(200);
    expect(Task.parse(closed.json())).toMatchObject({ kind: 'theme', status: 'cancelled' });
    const again = await call('developer', 'POST', routes.closeTheme('AR', theme.key), {});
    expect(again.statusCode).toBe(409);
    expect(errorOf(again)).toBe('task_closed');

    expect((await call('viewer', 'POST', routes.reopenTask('AR', theme.key), {})).statusCode).toBe(403);
    const reopened = await call('developer', 'POST', routes.reopenTask('AR', theme.key), {});
    expect(reopened.statusCode).toBe(200);
    expect(Task.parse(reopened.json())).toMatchObject({ status: 'active', closedAt: null });
  });

  it('closes only a theme, and reopens a card as before (admin or owner)', async () => {
    const card = await create('Card');
    const close = await call('developer', 'POST', routes.closeTheme('AR', card.key), {});
    expect(close.statusCode).toBe(409);
    expect(errorOf(close)).toBe('task_not_theme');

    await call('owner', 'POST', routes.cancelTask('AR', card.key), {});
    expect((await call('developer', 'POST', routes.reopenTask('AR', card.key), {})).statusCode).toBe(403);
    expect((await call('owner', 'POST', routes.reopenTask('AR', card.key), {})).statusCode).toBe(200);
  });

  it('refuses a new card in a closed theme, and keeps the cards it has', async () => {
    const theme = await create('Epic', { kind: 'theme' });
    const card = await create('Card', { themeKey: theme.key });
    await call('developer', 'POST', routes.closeTheme('AR', theme.key), {});
    const late = await call('developer', 'POST', routes.tasks('AR'), { title: 'Late', themeKey: theme.key });
    expect(late.statusCode).toBe(400);
    expect(errorOf(late)).toBe('theme_closed');
    const list = (await call('owner', 'GET', routes.tasks('AR'))).json<Task[]>();
    expect(list.find((t) => t.key === card.key)).toMatchObject({ themeKey: theme.key, status: 'active' });
  });
});

describe('a theme does not hold a stage in the configuration', () => {
  it('lets a stage be removed that only a theme is in, and still refuses one a card is in', async () => {
    const theme = await create('Epic', { kind: 'theme' });
    const card = await create('Card');
    const view = async (): Promise<ConfigView> =>
      (await call('owner', 'GET', routes.config('AR'))).json<ConfigView>();
    const without = (config: ConfigView) => {
      const pipeline = structuredClone(config.config.pipeline);
      pipeline.stages = pipeline.stages.filter((stage) => stage.id !== 'code_review');
      return pipeline;
    };
    const repos = h.app.projectman.repos.tasks;
    // The theme carries the id of a stage because the field is required; the card really is in it.
    repos.update(repos.get(theme.key)!.id, { stageId: 'code_review' });
    repos.update(repos.get(card.key)!.id, { stageId: 'code_review' });
    const current = await view();
    const refused = await inject(h.app, 'PATCH', routes.config('AR'), cookies.owner!, {
      baseVersion: current.version,
      pipeline: without(current),
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({
      code: 'stage_in_use',
      details: { stageId: 'code_review', tasks: 1 },
    });

    repos.update(repos.get(card.key)!.id, { stageId: 'development' });
    const removed = await inject(h.app, 'PATCH', routes.config('AR'), cookies.owner!, {
      baseVersion: current.version,
      pipeline: without(current),
    });
    expect(removed.statusCode).toBe(200);
  });
});
