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
import { waitFor } from './helpers/wait';

const OWNER_AUTHOR = { name: 'Owner', email: 'owner@example.com' };

describe('attachment uploads over a real connection', () => {
  let h: AppHarness;
  let clock: Date;
  let owner: string;
  let developer: string;
  let url: string;
  let expectedErrors: RegExp[];

  beforeEach(async () => {
    clock = new Date();
    expectedErrors = [];
    h = await createAppHarness({ now: () => clock, expectedErrors });
    owner = await setupOwner(h.app);
    await createProject(h, owner);
    developer = await addHumanAndLogin(h.app, { handle: 'robin', access: 'developer' });
    const { tasks } = h.app.projectman.domain;
    await tasks.create('AR', { title: 'Internal task' }, OWNER_ACTOR);
    await tasks.create('AR', { title: 'Shared task' }, OWNER_ACTOR);
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
  const midUpload = async () => {
    await waitFor(() => pending().length === 1 && stored().length === 1, 'the upload to start');
  };
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
    await waitFor(() => stored().length === 0 && pending().length === 0, 'the cleanup');
    nothingLeft();
  }, 30_000);

  it('cleans up after a client that goes away mid-upload', async () => {
    expectedErrors.push(/^attachment content could not be written$/, /^request failed$/);
    const result = await chunkedPost(endpoint(), developer, fileBody(pngBytes(400_000)), {
      between: midUpload,
      abort: true,
    });
    expect(result.status).toBe(0);
    await waitFor(() => stored().length === 0 && pending().length === 0, 'the cleanup');
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
    await waitFor(() => stored().length === 0 && pending().length === 0, 'the cleanup');
    nothingLeft();
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
    await waitFor(() => stored().length === 0 && pending().length === 0, 'the cleanup');
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
    await tasks.create('AR', { title: 'Shared task' }, OWNER_ACTOR);
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
      await tasks.create('AR', { title: `Marker ${sockets.length}` }, OWNER_ACTOR);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return events;
  }

  const attachmentEvents = (events: ServerEvent[]) =>
    events.filter((e) => e.type === 'task_attachments_changed');

  it('tells members, clients included, after the commit, with nothing but the task key', async () => {
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
    await waitFor(() => attachmentEvents(ownerEvents).length === 2, 'the owner events');
    expect(attachmentEvents(ownerEvents)).toEqual([
      { type: 'task_attachments_changed', projectKey: 'AR', taskKey: 'AR-1' },
      { type: 'task_attachments_changed', projectKey: 'AR', taskKey: 'AR-2' },
    ]);
    await waitFor(() => attachmentEvents(clientEvents).length === 2, 'the client events');
    expect(attachmentEvents(clientEvents)).toEqual(attachmentEvents(ownerEvents));

    await attachments.delete('AR', 'AR-2', shared.id, OWNER_ACTOR);
    await attachments.delete('AR', 'AR-1', internal.id, OWNER_ACTOR);
    await waitFor(() => attachmentEvents(clientEvents).length === 4, 'the delete events');
  });
});
