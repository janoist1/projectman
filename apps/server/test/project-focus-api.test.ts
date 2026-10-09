import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROJECT_FOCUS_MAX_ITEMS, routes } from '@projectman/shared';
import type {
  ProjectFocusChanges,
  ProjectFocusView,
  ServerEvent,
  Task,
  TaskDetail,
} from '@projectman/shared';
import { aiActor } from '../src/domain';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { flush } from './helpers/fakes';

interface TestSocket {
  send(data: string): void;
  terminate(): void;
  on(event: 'message', listener: (data: Buffer) => void): void;
}

/** The project's focus over REST and the websocket (PM-427). */
describe('project focus API', () => {
  let h: AppHarness;
  let owner: string;
  const sockets: TestSocket[] = [];
  beforeEach(async () => {
    h = await createAppHarness();
    owner = await setupOwner(h.app);
    await createProject(h, owner);
  });
  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    await h.close();
  });

  const card = async (title: string, extra: Record<string, unknown> = {}): Promise<Task> => {
    const res = await inject(h.app, 'POST', routes.tasks('AR'), owner, { title, ...extra });
    expect(res.statusCode).toBe(201);
    return res.json<Task>();
  };
  const get = (as: string = owner) => inject(h.app, 'GET', routes.projectFocus('AR'), as);
  const add = (key: string, position?: number, as: string = owner) =>
    inject(h.app, 'POST', routes.projectFocusItems('AR'), as, { key, ...(position ? { position } : {}) });
  const move = (key: string, position: number, as: string = owner) =>
    inject(h.app, 'PATCH', routes.projectFocusItem('AR', key), as, { position });
  const remove = (key: string, as: string = owner) =>
    inject(h.app, 'DELETE', routes.projectFocusItem('AR', key), as);
  const keys = (res: { json: <T>() => T }) => res.json<ProjectFocusView>().items.map((item) => item.key);
  const changes = async (as: string = owner, query = '') =>
    (await inject(h.app, 'GET', routes.projectFocusChanges('AR') + query, as)).json<ProjectFocusChanges>()
      .events;
  const close = (task: Task) => h.app.projectman.repos.tasks.update(task.id, { status: 'done' });

  async function socket(as: string): Promise<ServerEvent[]> {
    const events: ServerEvent[] = [];
    const ws = (await h.app.injectWS(
      '/ws',
      { headers: { cookie: as } },
      {
        onInit: (s) =>
          (s as unknown as TestSocket).on('message', (data) =>
            events.push(JSON.parse(data.toString()) as ServerEvent),
          ),
      },
    )) as unknown as TestSocket;
    sockets.push(ws);
    ws.send(JSON.stringify({ type: 'subscribe_project', projectKey: 'AR' }));
    await flush();
    return events;
  }

  it('starts empty and lets the owner add, move and remove, answering the whole view each time', async () => {
    expect((await get()).json()).toEqual({ items: [], canEdit: true });
    const [a, b, c] = [await card('A'), await card('B'), await card('C')];
    expect(keys(await add(a!.key))).toEqual(['AR-1']);
    expect(keys(await add(b!.key))).toEqual(['AR-1', 'AR-2']);
    expect(keys(await add(c!.key, 1))).toEqual(['AR-3', 'AR-1', 'AR-2']);
    expect(keys(await move(c!.key, 99))).toEqual(['AR-1', 'AR-2', 'AR-3']);
    expect(keys(await move(a!.key, 2))).toEqual(['AR-2', 'AR-1', 'AR-3']);
    const removed = await remove(b!.key);
    expect(removed.statusCode).toBe(200);
    expect(keys(removed)).toEqual(['AR-1', 'AR-3']);
    const view = (await get()).json<ProjectFocusView>();
    expect(view.canEdit).toBe(true);
    expect(view.items[0]).toMatchObject({ key: 'AR-1', addedBy: { kind: 'human', handle: 'owner' } });
  });

  it('refuses a repeated, unknown, closed or too many items', async () => {
    const a = await card('A');
    await add(a.key);
    expect(await add(a.key)).toMatchObject({ statusCode: 409 });
    expect((await add(a.key)).json()).toMatchObject({ error: { code: 'focus_item_exists' } });
    expect((await add('AR-99')).json()).toMatchObject({ error: { code: 'not_found' } });
    expect((await add('ZZ-1')).json()).toMatchObject({ error: { code: 'not_found' } });
    const done = await card('Done');
    close(done);
    const closed = await add(done.key);
    expect(closed.statusCode).toBe(409);
    expect(closed.json()).toMatchObject({ error: { code: 'focus_task_closed' } });
    const unknown = await move('AR-5', 1);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: { code: 'focus_item_unknown' } });
    expect((await remove('AR-5')).json()).toMatchObject({ error: { code: 'focus_item_unknown' } });
    expect(
      (await inject(h.app, 'PATCH', routes.projectFocusItem('AR', a.key), owner, { position: 0 })).statusCode,
    ).toBe(400);
    for (let i = 1; i < PROJECT_FOCUS_MAX_ITEMS; i++)
      expect((await add((await card(`C${i}`)).key)).statusCode).toBe(200);
    const full = await add((await card('One more')).key);
    expect(full.statusCode).toBe(409);
    expect(full.json()).toMatchObject({ error: { code: 'focus_full' } });
  });

  it('lets a closed item stay in the list and count in the numbering', async () => {
    const [a, b] = [await card('A'), await card('B')];
    await add(a!.key);
    await add(b!.key);
    close(a!);
    expect(keys(await get())).toEqual([a!.key, b!.key]);
    expect(h.app.projectman.domain.projectFocus.places('AR').get(b!.key)).toEqual({ position: 2 });
  });

  it('writes focus_changed with the item as its card, and moved without a card', async () => {
    const [a, b] = [await card('A'), await card('B')];
    await add(a!.key);
    await add(b!.key);
    await move(b!.key, 1);
    await move(b!.key, 1);
    await remove(a!.key);
    const events = await changes();
    expect(events.map((e) => [e.taskKey, e.data])).toEqual([
      ['AR-1', { action: 'removed', key: 'AR-1', title: 'A', position: null, previous: 2 }],
      [null, { action: 'moved', key: 'AR-2', title: 'B', position: 1, previous: 2 }],
      ['AR-2', { action: 'added', key: 'AR-2', title: 'B', position: 2, previous: null }],
      ['AR-1', { action: 'added', key: 'AR-1', title: 'A', position: 1, previous: null }],
    ]);
    expect(events.every((e) => e.type === 'focus_changed' && e.actor.handle === 'owner')).toBe(true);
    const onCard = await inject(h.app, 'GET', routes.task('AR', a!.key), owner);
    expect(onCard.json<TaskDetail>().timeline.filter((e) => e.type === 'focus_changed')).toHaveLength(2);
    expect(await changes(owner, '?limit=2')).toHaveLength(2);
    expect(
      (await inject(h.app, 'GET', routes.projectFocusChanges('AR') + '?limit=201', owner)).statusCode,
    ).toBe(400);
  });

  it('writes nothing when an item stays where it was', async () => {
    const [a, b] = [await card('A'), await card('B')];
    await add(a!.key);
    await add(b!.key);
    const owned = await socket(owner);
    const before = (await changes()).length;
    expect(keys(await move(a!.key, 1))).toEqual(['AR-1', 'AR-2']);
    expect(keys(await move(b!.key, 50))).toEqual(['AR-1', 'AR-2']);
    await flush();
    expect(await changes()).toHaveLength(before);
    expect(owned.some((e) => e.type === 'project_focus_changed')).toBe(false);
  });

  it('answers the owner and a prioritizing person, and sends the websocket event after every write', async () => {
    const po = await addHumanAndLogin(h.app, { handle: 'po', roles: ['product_owner'] });
    const events = await socket(po);
    const a = await card('A');
    await add(a.key, undefined, po);
    await move(a.key, 1, po);
    await remove(a.key, po);
    await flush();
    const focus = events.flatMap((e) => (e.type === 'project_focus_changed' ? [e.focus.items.length] : []));
    expect(focus).toEqual([1, 0]);
    expect(events.find((e) => e.type === 'project_focus_changed')).toMatchObject({ projectKey: 'AR' });
  });

  it('lets other people read but not write, and tells them so', async () => {
    const dev = await addHumanAndLogin(h.app, { handle: 'dev1', roles: ['developer'] });
    const a = await card('A');
    await add(a.key);
    expect((await get(dev)).json()).toMatchObject({ canEdit: false, items: [{ key: 'AR-1' }] });
    for (const res of [await add('AR-1', 1, dev), await move(a.key, 1, dev), await remove(a.key, dev)]) {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: { code: 'focus_not_allowed' } });
    }
    expect(keys(await get())).toEqual(['AR-1']);
  });

  it('refuses an AI actor with focus_humans_only and changes nothing', async () => {
    const a = await card('A');
    const service = h.app.projectman.domain.projectFocus;
    const system = { kind: 'system' as const, handle: null };
    for (const actor of [aiActor('dev-1'), system]) {
      await expect(service.add('AR', a.key, actor)).rejects.toMatchObject({
        status: 403,
        code: 'focus_humans_only',
      });
    }
    await service.add('AR', a.key, { kind: 'human', handle: 'owner' });
    await expect(service.move('AR', a.key, 1, aiActor('dev-1'))).rejects.toMatchObject({
      code: 'focus_humans_only',
    });
    await expect(service.remove('AR', a.key, aiActor('dev-1'))).rejects.toMatchObject({
      code: 'focus_humans_only',
    });
    expect(service.get('AR').items).toHaveLength(1);
  });

  it('runs the change listeners after a write, and not after a refusal', async () => {
    const service = h.app.projectman.domain.projectFocus;
    const called: string[] = [];
    service.onChange((projectKey) => called.push(projectKey));
    const a = await card('A');
    await add(a.key);
    await add(a.key);
    await remove(a.key);
    expect(called).toEqual(['AR', 'AR']);
  });

  it('keeps the focus from a client: no endpoint, no websocket event, no timeline entry, no pulled reason', async () => {
    const client = await addHumanAndLogin(h.app, { handle: 'acme-client', access: 'client' });
    const events = await socket(client);
    const shared = await card('Shared', { visibility: 'shared' });
    await add(shared.key);
    await flush();
    for (const res of [
      await get(client),
      await add(shared.key, 1, client),
      await move(shared.key, 1, client),
      await remove(shared.key, client),
      await inject(h.app, 'GET', routes.projectFocusChanges('AR'), client),
    ])
      expect(res.statusCode).toBe(403);
    expect(events.some((e) => e.type === 'project_focus_changed')).toBe(false);

    const { timeline, projects } = h.app.projectman.domain;
    expect(projects.has('AR')).toBe(true);
    timeline.append({
      projectKey: 'AR',
      taskKey: shared.key,
      actor: { kind: 'system', handle: null },
      type: 'task_stage_changed',
      data: {
        from: 'backlog',
        to: 'dev',
        pulled: { reason: 'focus', position: 1, key: 'AR-1', title: 'Shared' },
      },
    });
    const seen = (await inject(h.app, 'GET', routes.task('AR', shared.key), client)).json<TaskDetail>();
    expect(seen.timeline.some((e) => e.type === 'focus_changed')).toBe(false);
    const moved = seen.timeline.find((e) => e.type === 'task_stage_changed' && e.data.to === 'dev');
    expect(moved).toBeDefined();
    expect(moved!.data).not.toHaveProperty('pulled');
    const team = (await inject(h.app, 'GET', routes.task('AR', shared.key), owner)).json<TaskDetail>();
    expect(team.timeline.some((e) => e.type === 'focus_changed')).toBe(true);
    expect(
      team.timeline.find((e) => e.type === 'task_stage_changed' && e.data.to === 'dev')!.data,
    ).toHaveProperty('pulled');
  });
});
