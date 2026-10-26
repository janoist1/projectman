import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROJECT_FOCUS_MAX_ITEMS, routes } from '@projectman/shared';
import type { ServerEvent, Task, TaskDetail } from '@projectman/shared';
import { aiActor } from '../src/kernel';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { flush } from './helpers/fakes';

interface TestSocket {
  send(data: string): void;
  terminate(): void;
  on(event: 'message', listener: (data: Buffer) => void): void;
}

const OWNER_ACTOR = { kind: 'human' as const, handle: 'owner' };

/** The project's focus service and its websocket event (PM-427). */
describe('project focus', () => {
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

  const focus = () => h.app.projectman.domain.projectFocus;
  const card = async (title: string): Promise<Task> => {
    const res = await inject(h.app, 'POST', routes.tasks('AR'), owner, { title });
    expect(res.statusCode).toBe(201);
    return res.json<Task>();
  };
  const add = (key: string, position?: number, actor = OWNER_ACTOR) =>
    focus().add('AR', key, actor, position);
  const keys = () =>
    focus()
      .get('AR')
      .items.map((item) => item.key);
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

  it('starts empty and lets the owner add, move and remove in order', async () => {
    expect(await focus().view('AR', OWNER_ACTOR)).toEqual({ items: [], canEdit: true });
    const [a, b, c] = [await card('A'), await card('B'), await card('C')];
    await add(a!.key);
    await add(b!.key);
    await add(c!.key, 2);
    expect(keys()).toEqual(['AR-1', 'AR-3', 'AR-2']);
    await focus().move('AR', c!.key, 99, OWNER_ACTOR);
    expect(keys()).toEqual(['AR-1', 'AR-2', 'AR-3']);
    await focus().move('AR', a!.key, 2, OWNER_ACTOR);
    expect(keys()).toEqual(['AR-2', 'AR-1', 'AR-3']);
    await focus().remove('AR', b!.key, OWNER_ACTOR);
    expect(keys()).toEqual(['AR-1', 'AR-3']);
    expect(focus().get('AR').items[0]).toMatchObject({
      key: 'AR-1',
      addedBy: { kind: 'human', handle: 'owner' },
    });
  });

  it('refuses a repeated, unknown, closed or too many items', async () => {
    const a = await card('A');
    await add(a.key);
    await expect(add(a.key)).rejects.toMatchObject({ status: 409, code: 'focus_item_exists' });
    await expect(add('AR-99')).rejects.toMatchObject({ code: 'not_found' });
    await expect(add('ZZ-1')).rejects.toMatchObject({ code: 'not_found' });
    const done = await card('Done');
    close(done);
    await expect(add(done.key)).rejects.toMatchObject({ status: 409, code: 'focus_task_closed' });
    await expect(focus().move('AR', 'AR-5', 1, OWNER_ACTOR)).rejects.toMatchObject({
      status: 404,
      code: 'focus_item_unknown',
    });
    await expect(focus().remove('AR', 'AR-5', OWNER_ACTOR)).rejects.toMatchObject({
      code: 'focus_item_unknown',
    });
    for (let i = 1; i < PROJECT_FOCUS_MAX_ITEMS; i++) await add((await card(`C${i}`)).key);
    await expect(add((await card('One more')).key)).rejects.toMatchObject({
      status: 409,
      code: 'focus_full',
    });
  });

  it('lets a closed item stay in the list and count in the numbering', async () => {
    const [a, b] = [await card('A'), await card('B')];
    await add(a!.key);
    await add(b!.key);
    close(a!);
    expect(keys()).toEqual([a!.key, b!.key]);
    expect(focus().places('AR').get(b!.key)).toEqual({ position: 2 });
  });

  it('writes focus_changed with the item as its card, and moved without a card', async () => {
    const [a, b] = [await card('A'), await card('B')];
    await add(a!.key);
    await add(b!.key);
    await focus().move('AR', b!.key, 1, OWNER_ACTOR);
    await focus().move('AR', b!.key, 1, OWNER_ACTOR);
    await focus().remove('AR', a!.key, OWNER_ACTOR);
    const events = focus().changes('AR', 50);
    expect(events.map((e) => [e.taskKey, e.data])).toEqual([
      ['AR-1', { action: 'removed', key: 'AR-1', title: 'A', position: null, previous: 2 }],
      [null, { action: 'moved', key: 'AR-2', title: 'B', position: 1, previous: 2 }],
      ['AR-2', { action: 'added', key: 'AR-2', title: 'B', position: 2, previous: null }],
      ['AR-1', { action: 'added', key: 'AR-1', title: 'A', position: 1, previous: null }],
    ]);
    expect(events.every((e) => e.type === 'focus_changed' && e.actor.handle === 'owner')).toBe(true);
    const onCard = await inject(h.app, 'GET', routes.task('AR', a!.key), owner);
    expect(onCard.json<TaskDetail>().timeline.filter((e) => e.type === 'focus_changed')).toHaveLength(2);
    expect(focus().changes('AR', 2)).toHaveLength(2);
  });

  it('writes nothing when an item stays where it was', async () => {
    const [a, b] = [await card('A'), await card('B')];
    await add(a!.key);
    await add(b!.key);
    const owned = await socket(owner);
    const before = focus().changes('AR', 50).length;
    await focus().move('AR', a!.key, 1, OWNER_ACTOR);
    await focus().move('AR', b!.key, 50, OWNER_ACTOR);
    await flush();
    expect(keys()).toEqual(['AR-1', 'AR-2']);
    expect(focus().changes('AR', 50)).toHaveLength(before);
    expect(owned.some((e) => e.type === 'project_focus_changed')).toBe(false);
  });

  it('lets a prioritizing person write and sends the websocket event after every write', async () => {
    const po = await addHumanAndLogin(h.app, { handle: 'po', roles: ['product_owner'] });
    const actor = { kind: 'human' as const, handle: 'po' };
    const events = await socket(po);
    const a = await card('A');
    await add(a.key, undefined, actor);
    await focus().move('AR', a.key, 1, actor);
    await focus().remove('AR', a.key, actor);
    await flush();
    const sizes = events.flatMap((e) => (e.type === 'project_focus_changed' ? [e.focus.items.length] : []));
    expect(sizes).toEqual([1, 0]);
    expect(events.find((e) => e.type === 'project_focus_changed')).toMatchObject({ projectKey: 'AR' });
  });

  it('lets other people read but not write, and tells them so', async () => {
    await addHumanAndLogin(h.app, { handle: 'dev1', roles: ['developer'] });
    const dev = { kind: 'human' as const, handle: 'dev1' };
    const a = await card('A');
    await add(a.key);
    expect(await focus().view('AR', dev)).toMatchObject({ canEdit: false, items: [{ key: 'AR-1' }] });
    for (const attempt of [
      add('AR-1', 1, dev),
      focus().move('AR', a.key, 1, dev),
      focus().remove('AR', a.key, dev),
    ])
      await expect(attempt).rejects.toMatchObject({ status: 403, code: 'focus_not_allowed' });
    expect(keys()).toEqual(['AR-1']);
  });

  it('refuses an AI actor with focus_humans_only and changes nothing', async () => {
    const a = await card('A');
    const system = { kind: 'system' as const, handle: null };
    for (const actor of [aiActor('dev-1'), system]) {
      await expect(focus().add('AR', a.key, actor)).rejects.toMatchObject({
        status: 403,
        code: 'focus_humans_only',
      });
    }
    await add(a.key);
    await expect(focus().move('AR', a.key, 1, aiActor('dev-1'))).rejects.toMatchObject({
      code: 'focus_humans_only',
    });
    await expect(focus().remove('AR', a.key, aiActor('dev-1'))).rejects.toMatchObject({
      code: 'focus_humans_only',
    });
    expect(focus().get('AR').items).toHaveLength(1);
  });

  it('runs the change listeners after a write, and not after a refusal', async () => {
    const called: string[] = [];
    focus().onChange((projectKey) => called.push(projectKey));
    const a = await card('A');
    await add(a.key);
    await expect(add(a.key)).rejects.toMatchObject({ code: 'focus_item_exists' });
    await focus().remove('AR', a.key, OWNER_ACTOR);
    expect(called).toEqual(['AR', 'AR']);
  });

  it('lets a client see the focus like any member (PM-79): the event, the timeline and the pulled reason', async () => {
    const client = await addHumanAndLogin(h.app, { handle: 'acme-client', access: 'client' });
    const events = await socket(client);
    const shared = await card('Shared');
    await add(shared.key);
    await flush();
    expect(events.some((e) => e.type === 'project_focus_changed')).toBe(true);

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
    expect(seen.timeline.some((e) => e.type === 'focus_changed')).toBe(true);
    const moved = seen.timeline.find((e) => e.type === 'task_stage_changed' && e.data.to === 'dev');
    expect(moved!.data).toHaveProperty('pulled');
    const team = (await inject(h.app, 'GET', routes.task('AR', shared.key), owner)).json<TaskDetail>();
    expect(team.timeline.some((e) => e.type === 'focus_changed')).toBe(true);
    expect(
      team.timeline.find((e) => e.type === 'task_stage_changed' && e.data.to === 'dev')!.data,
    ).toHaveProperty('pulled');
  });
});
