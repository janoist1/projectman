import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { routes } from '@projectman/shared';
import type { BoardMoveResult, ServerEvent, Task } from '@projectman/shared';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { flush } from './helpers/fakes';

interface TestSocket {
  send(data: string): void;
  terminate(): void;
  on(event: 'message', listener: (data: Buffer) => void): void;
}

/** The manual card order over REST and the websocket (PM-118), seen by two clients. */
describe('board order API', () => {
  let h: AppHarness;
  let cookie: string;
  const sockets: TestSocket[] = [];
  beforeEach(async () => {
    h = await createAppHarness();
    cookie = await setupOwner(h.app);
    await createProject(h, cookie);
  });
  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    await h.close();
  });

  const post = (taskKey: string, body: unknown, as: string = cookie) =>
    inject(h.app, 'POST', routes.boardMoveTask('AR', taskKey), as, body);
  const list = async (as: string = cookie) =>
    (await inject(h.app, 'GET', routes.tasks('AR'), as)).json<Task[]>();
  const todo = async () =>
    (await list())
      .filter((task) => task.stageId === 'backlog')
      .sort((a, b) => a.boardRank! - b.boardRank!)
      .map((task) => task.key);

  async function client(as: string = cookie): Promise<ServerEvent[]> {
    const events: ServerEvent[] = [];
    const ws = (await h.app.injectWS(
      '/ws',
      { headers: { cookie: as } },
      {
        onInit: (socket) =>
          (socket as unknown as TestSocket).on('message', (data) =>
            events.push(JSON.parse(data.toString()) as ServerEvent),
          ),
      },
    )) as unknown as TestSocket;
    sockets.push(ws);
    ws.send(JSON.stringify({ type: 'subscribe_project', projectKey: 'AR' }));
    await flush();
    return events;
  }
  const upserted = (events: ServerEvent[]) =>
    events.flatMap((event) => (event.type === 'task_upserted' ? [event.task] : []));

  it('moves a card, tells both clients once, and refuses a stale picture without telling anyone', async () => {
    for (const title of ['A', 'B', 'C']) await inject(h.app, 'POST', routes.tasks('AR'), cookie, { title });
    expect(await todo()).toEqual(['AR-3', 'AR-2', 'AR-1']);
    const first = await client();
    const second = await client();
    const before = first.length;

    const moved = await post('AR-1', {
      columnId: 'todo',
      fromStageId: 'backlog',
      placement: { at: 'before', anchor: 'AR-3' },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json<BoardMoveResult>()).toMatchObject({ outcome: 'reordered', reranked: ['AR-1'] });
    await flush();
    for (const events of [first, second])
      expect(upserted(events.slice(before)).map((task) => task.key)).toEqual(['AR-1']);
    expect(await todo()).toEqual(['AR-1', 'AR-3', 'AR-2']);
    // The card the clients were told about carries its rank, like the list does.
    const told = upserted(first).at(-1)!;
    expect(told.boardRank).toBe((await list()).find((task) => task.key === 'AR-1')!.boardRank);

    const seen = first.length;
    const stale = await post('AR-2', {
      columnId: 'todo',
      fromStageId: 'backlog',
      placement: { at: 'before', anchor: 'AR-9' },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json<{ error: { code: string } }>().error.code).toBe('board_stale');
    await flush();
    expect(first.length).toBe(seen);
    expect(await todo()).toEqual(['AR-1', 'AR-3', 'AR-2']);
  });

  it('refuses a body with a raw rank, an unknown placement or a missing source', async () => {
    await inject(h.app, 'POST', routes.tasks('AR'), cookie, { title: 'A' });
    for (const body of [
      { columnId: 'todo', fromStageId: 'backlog', placement: { at: 'top' }, rank: 5 },
      { columnId: 'todo', fromStageId: 'backlog', placement: { at: 'middle' } },
      { columnId: 'todo', placement: { at: 'top' } },
      { columnId: 'todo', fromStageId: 'backlog', placement: { at: 'before' } },
    ]) {
      const res = await post('AR-1', body);
      expect(res.statusCode).toBe(400);
    }
  });

  it('is for a developer: a viewer cannot reorder', async () => {
    await inject(h.app, 'POST', routes.tasks('AR'), cookie, { title: 'A' });
    const viewer = await addHumanAndLogin(h.app, { handle: 'viewer', access: 'viewer' });
    const res = await post(
      'AR-1',
      { columnId: 'todo', fromStageId: 'backlog', placement: { at: 'top' } },
      viewer,
    );
    expect(res.statusCode).toBe(403);
  });

  it('changes the stage of a card dropped on another column and the order with it', async () => {
    for (const title of ['A', 'B']) await inject(h.app, 'POST', routes.tasks('AR'), cookie, { title });
    const res = await post('AR-1', {
      columnId: 'doing',
      fromStageId: 'backlog',
      placement: { at: 'top' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<BoardMoveResult>()).toMatchObject({
      outcome: 'moved',
      task: { key: 'AR-1', stageId: 'development' },
    });
    expect(await todo()).toEqual(['AR-2']);
  });
});
