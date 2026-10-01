import { readFileSync, readdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_ATTACHMENT_BYTES, routes } from '@projectman/shared';
import type { ServerEvent } from '@projectman/shared';
import { SESSION_TTL_MS } from '../src/auth';
import { addHumanAndLogin, createAppHarness, createProject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { OWNER_ACTOR } from './helpers/domain-harness';
import { chunkedPost, fileBody, pngBytes } from './helpers/attachments';

const OWNER_AUTHOR = { name: 'Owner', email: 'owner@example.com' };

async function waitUntil(condition: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('attachment uploads over a real connection', () => {
  let h: AppHarness;
  let clock: Date;
  let owner: string;
  let client: string;
  let developer: string;
  let url: string;

  beforeEach(async () => {
    clock = new Date();
    h = await createAppHarness({ now: () => clock });
    owner = await setupOwner(h.app);
    await createProject(h, owner);
    developer = await addHumanAndLogin(h.app, { handle: 'robin', access: 'developer' });
    client = await addHumanAndLogin(h.app, { handle: 'cleo', access: 'client' });
    const { tasks } = h.app.projectman.domain;
    await tasks.create('AR', { title: 'Internal task' }, OWNER_ACTOR);
    await tasks.create('AR', { title: 'Shared task', visibility: 'shared' }, OWNER_ACTOR);
    await h.app.listen({ host: '127.0.0.1', port: 0 });
    url = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
  });
  afterEach(async () => h.close());

  const endpoint = (taskKey = 'AR-1') => `${url}${routes.taskAttachments('AR', taskKey)}`;
  const pending = () => h.app.projectman.repos.attachments.inState('pending');
  const stored = (taskKey = 'AR-1') => {
    try {
      return readdirSync(join(h.home, 'attachments', 'AR', taskKey));
    } catch {
      return [];
    }
  };
  /** Mid-upload: the server holds the pending row and the temporary file. */
  const midUpload = () =>
    waitUntil(() => pending().length === 1 && stored().length === 1, 'the upload to start');
  const nothingLeft = (taskKey = 'AR-1') => {
    expect(pending()).toEqual([]);
    expect(stored(taskKey)).toEqual([]);
    expect(h.app.projectman.repos.timeline.list('AR', { taskKey }).map((e) => e.type)).not.toContain(
      'attachment_added',
    );
  };

  it('counts the bytes it receives, whatever the client says', async () => {
    const bytes = pngBytes(300_000);
    const response = await chunkedPost(endpoint(), developer, fileBody(bytes, 'big.png'));
    expect(response.status, response.body).toBe(201);
    const { attachment } = JSON.parse(response.body) as { attachment: { id: string; size: number } };
    expect(attachment.size).toBe(300_000);
    expect(readFileSync(join(h.home, 'attachments', 'AR', 'AR-1', attachment.id)).equals(bytes)).toBe(true);
  });

  it('refuses a chunked upload that crosses the limit and cleans up', async () => {
    const response = await chunkedPost(
      endpoint(),
      developer,
      fileBody(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 5)),
    );
    expect(response.status).toBe(413);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: 'attachment_too_large' } });
    expect(response.headers.connection).toBe('close');
    await waitUntil(() => stored().length === 0 && pending().length === 0, 'the cleanup');
    nothingLeft();
  }, 30_000);

  it('cleans up after a client that goes away mid-upload', async () => {
    const result = await chunkedPost(endpoint(), developer, fileBody(pngBytes(400_000)), {
      between: midUpload,
      abort: true,
    });
    expect(result.status).toBe(0);
    await waitUntil(() => stored().length === 0 && pending().length === 0, 'the cleanup');
    nothingLeft();
  });

  it('refuses a stale login at the end of the upload', async () => {
    const result = await chunkedPost(endpoint(), developer, fileBody(pngBytes(400_000)), {
      between: async () => {
        await midUpload();
        clock = new Date(clock.getTime() + SESSION_TTL_MS + 60_000);
      },
    });
    expect(result.status).toBe(401);
    await waitUntil(() => stored().length === 0 && pending().length === 0, 'the cleanup');
    nothingLeft();
  });

  it('checks the access again at the end: a task that turned internal', async () => {
    const result = await chunkedPost(endpoint('AR-2'), client, fileBody(pngBytes(400_000)), {
      between: async () => {
        await waitUntil(() => pending().length === 1, 'the upload to start');
        await h.app.projectman.domain.tasks.update('AR', 'AR-2', { visibility: 'internal' }, OWNER_ACTOR);
      },
    });
    expect(result.status).toBe(404);
    await waitUntil(() => stored('AR-2').length === 0 && pending().length === 0, 'the cleanup');
    nothingLeft('AR-2');
  });

  it.each([
    ['demoted to a viewer', 403, 'insufficient_access'],
    ['removed from the project', 403, 'not_a_member'],
  ])('checks the access again at the end: the uploader %s', async (_, status, code) => {
    const removed = code === 'not_a_member';
    const result = await chunkedPost(endpoint(), developer, fileBody(pngBytes(400_000)), {
      between: async () => {
        await midUpload();
        await h.app.projectman.domain.projects.update(
          'AR',
          { actor: OWNER_ACTOR, author: OWNER_AUTHOR },
          (draft) => {
            if (removed) draft.team.members = draft.team.members.filter((m) => m.handle !== 'robin');
            else {
              const member = draft.team.members.find((m) => m.handle === 'robin');
              if (member?.kind === 'human') member.access = 'viewer';
            }
            return 'Change robin';
          },
        );
      },
    });
    expect(result.status).toBe(status);
    expect(JSON.parse(result.body)).toMatchObject({ error: { code } });
    await waitUntil(() => stored().length === 0 && pending().length === 0, 'the cleanup');
    nothingLeft();
  });
});

describe('attachment websocket notifications', () => {
  interface TestSocket {
    send(data: string): void;
    terminate(): void;
    on(event: 'message', listener: (data: Buffer) => void): void;
  }
  let h: AppHarness;
  let owner: string;
  let client: string;
  const sockets: TestSocket[] = [];

  beforeEach(async () => {
    h = await createAppHarness();
    owner = await setupOwner(h.app);
    await createProject(h, owner);
    client = await addHumanAndLogin(h.app, { handle: 'cleo', access: 'client' });
    const { tasks } = h.app.projectman.domain;
    await tasks.create('AR', { title: 'Internal task' }, OWNER_ACTOR);
    await tasks.create('AR', { title: 'Shared task', visibility: 'shared' }, OWNER_ACTOR);
  });
  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    await h.close();
  });

  async function connect(cookie: string): Promise<ServerEvent[]> {
    const events: ServerEvent[] = [];
    const ws = (await h.app.injectWS(
      '/ws',
      { headers: { cookie } },
      {
        onInit: (socket) =>
          (socket as unknown as TestSocket).on('message', (data) =>
            events.push(JSON.parse(data.toString()) as ServerEvent),
          ),
      },
    )) as unknown as TestSocket;
    sockets.push(ws);
    ws.send(JSON.stringify({ type: 'subscribe_project', projectKey: 'AR' }));
    // A shared task's change reaches every member, so its arrival proves the subscription is in place.
    const { tasks } = h.app.projectman.domain;
    const deadline = Date.now() + 3000;
    while (!events.some((e) => e.type === 'task_upserted')) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the subscription');
      await tasks.create('AR', { title: `Marker ${sockets.length}`, visibility: 'shared' }, OWNER_ACTOR);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return events;
  }

  const attachmentEvents = (events: ServerEvent[]) =>
    events.filter((e) => e.type === 'task_attachments_changed');

  it('tells members after the commit, with nothing but the task key, and clients only for tasks shared with them', async () => {
    const ownerEvents = await connect(owner);
    const clientEvents = await connect(client);
    const { attachments } = h.app.projectman.domain;
    const add = (taskKey: string) =>
      attachments.upload({
        projectKey: 'AR',
        taskKey,
        actor: OWNER_ACTOR,
        fileName: 'a.png',
        content: Readable.from([pngBytes()]),
      });

    const internal = await add('AR-1');
    const shared = await add('AR-2');
    await waitUntil(() => attachmentEvents(ownerEvents).length === 2, 'the owner events');
    expect(attachmentEvents(ownerEvents)).toEqual([
      { type: 'task_attachments_changed', projectKey: 'AR', taskKey: 'AR-1' },
      { type: 'task_attachments_changed', projectKey: 'AR', taskKey: 'AR-2' },
    ]);
    await waitUntil(() => attachmentEvents(clientEvents).length === 1, 'the client event');
    expect(attachmentEvents(clientEvents)).toEqual([
      { type: 'task_attachments_changed', projectKey: 'AR', taskKey: 'AR-2' },
    ]);

    // A client no longer hears about a task that turned internal; the live timeline never reaches them.
    await h.app.projectman.domain.tasks.update('AR', 'AR-2', { visibility: 'internal' }, OWNER_ACTOR);
    await attachments.delete('AR', 'AR-2', shared.id, OWNER_ACTOR);
    await attachments.delete('AR', 'AR-1', internal.id, OWNER_ACTOR);
    await waitUntil(() => attachmentEvents(ownerEvents).length === 4, 'the delete events');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(attachmentEvents(clientEvents)).toHaveLength(1);
    expect(clientEvents.filter((e) => e.type === 'timeline_appended')).toEqual([]);
    expect(JSON.stringify(clientEvents)).not.toContain('a.png');
  });
});
