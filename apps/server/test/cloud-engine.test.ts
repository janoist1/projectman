import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '@projectman/shared';
import type { Task } from '@projectman/shared';
import { OWNER_ACTOR } from './helpers/domain-harness';
import { addHumanAndLogin, inject } from './helpers/app-harness';
import { connectRawEngine, createCloudEngineWorld, ENGINE_CORES, filesIn } from './helpers/cloud-engine';
import type { CloudEngineWorld } from './helpers/cloud-engine';

/**
 * The cloud composition and the engine process together (PM-667): the hybrid package of a single-machine
 * home opened by the real `buildApp({ engineMode: 'cloud' })`, joined over the real machine-key link to the
 * real `buildEngineApp` on the Mac's home, with a disposable repository and the fake runner. The
 * cloud-side (`cloud-mode.test.ts`) and engine-side (`engine-app.test.ts`) tests use a fake for the other end;
 * this file is the only place the two real ends meet.
 */

vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });

let world: CloudEngineWorld;
beforeEach(async () => {
  world = await createCloudEngineWorld();
});
afterEach(async () => {
  await world.cleanup();
});

const cloud = () => world.cloud!;
const domain = () => cloud().projectman.domain;
const online = () => vi.waitFor(() => expect(world.engineOnline()).toBe(true), { timeout: 15_000 });
const started = () => world.fake?.runner.started ?? [];

describe('the cloud without an engine', () => {
  beforeEach(async () => {
    await world.startCloud();
  });

  it('serves login, the cards, the files and the clients’ view while no engine is connected', async () => {
    expect(world.engineOnline()).toBe(false);
    const me = await inject(cloud(), 'GET', routes.me(), world.cookie);
    expect(me.statusCode).toBe(200);

    const tasks = await inject(cloud(), 'GET', routes.tasks('AR'), world.cookie);
    expect(tasks.statusCode).toBe(200);
    expect((tasks.json() as Task[]).map((task) => task.key)).toContain(world.src.taskKey);

    // The attachment the package carried is read straight from the cloud's own files.
    const list = await inject(cloud(), 'GET', routes.taskAttachments('AR', world.src.taskKey), world.cookie);
    expect(list.statusCode).toBe(200);
    const [attachment] = (list.json() as { attachments: Array<{ id: string }> }).attachments;
    const content = await inject(
      cloud(),
      'GET',
      routes.attachmentContent('AR', world.src.taskKey, attachment!.id),
      world.cookie,
    );
    expect(content.statusCode).toBe(200);
    expect(content.rawPayload.length).toBeGreaterThan(0);

    // A client sees the board without the machine too.
    const client = await addHumanAndLogin(cloud(), { handle: 'customer', access: 'client' });
    const seen = await inject(cloud(), 'GET', routes.tasks('AR'), client);
    expect(seen.statusCode).toBe(200);

    // Machine work has nowhere to go.
    const machine = await inject(cloud(), 'GET', routes.machine(), world.cookie);
    expect(machine.statusCode).toBe(409);
    expect(machine.json()).toMatchObject({ error: { code: 'engine_offline' } });
  });

  it('keeps a start and a message waiting, and runs each exactly once when the engine connects', async () => {
    const created = await domain().tasks.create('AR', { title: 'Waits for the Mac' }, OWNER_ACTOR);
    await domain().tasks.moveToStage('AR', created.key, 'development', OWNER_ACTOR);
    await vi.waitFor(() =>
      expect(domain().tasks.get('AR', created.key).startWaiting).toMatchObject({ reason: 'engine_offline' }),
    );
    const sent = await domain().messaging.sendReporting('AR', 'owner', {
      to: ['dev-2'],
      taskKey: world.src.taskKey,
      text: 'Please look at the checkout when you can',
    });
    expect(sent.recipients).toEqual([expect.objectContaining({ handle: 'dev-2', delivery: 'held' })]);
    const counters = domain().engineCounters(world.packaged.engine.id);
    expect(counters.waitingStarts).toBe(1);
    expect(counters.waitingMessages).toBe(1);

    await world.startEngine();
    await online();
    await vi.waitFor(() => expect(started().length).toBeGreaterThanOrEqual(2), { timeout: 15_000 });
    await vi.waitFor(() => expect(domain().tasks.get('AR', created.key).startWaiting).toBeUndefined());
    // One session for the card's start and one for the message's recipient, none twice.
    expect(started().map((spec) => spec.sessionId)).toHaveLength(2);
    expect(new Set(started().map((spec) => spec.sessionId)).size).toBe(2);
    expect(domain().engineCounters(world.packaged.engine.id)).toMatchObject({
      waitingStarts: 0,
      waitingMessages: 0,
    });
  });
});

describe('the cloud with its engine connected', () => {
  beforeEach(async () => {
    await world.startCloud();
    await world.startEngine();
    await online();
  });

  /** Opens a card in the development stage: the cloud starts its assignee on the engine. */
  const startCard = async (title: string) => {
    const created = await domain().tasks.create('AR', { title }, OWNER_ACTOR);
    await domain().tasks.moveToStage('AR', created.key, 'development', OWNER_ACTOR);
    await vi.waitFor(() => expect(sessionOf(created.key)).toBeDefined(), { timeout: 15_000 });
    await vi.waitFor(() => expect(started().length).toBeGreaterThan(0), { timeout: 15_000 });
    return { key: created.key, session: sessionOf(created.key)! };
  };
  const sessionOf = (taskKey: string) =>
    domain()
      .sessions.list('AR')
      .find((session) => session.workItem.type === 'task' && session.workItem.taskKey === taskKey);
  const specOf = (sessionId: string) => started().find((spec) => spec.sessionId === sessionId)!;

  it('does the machine and repository work on the engine, never in the cloud', async () => {
    const { key, session } = await startCard('Runs on the Mac');
    expect(session.engineId).toBe(world.packaged.engine.id);

    // The member's checkout lies under the engine's home, the cloud's own home gained nothing of the kind.
    const spec = specOf(session.id);
    expect(spec.cwd.startsWith(world.src.home)).toBe(true);
    expect(filesIn(join(world.src.home, 'workspaces', 'AR'))).toContain('dev-1');
    expect(existsSync(join(world.cloudHome, 'workspaces'))).toBe(false);
    expect(world.cloudWorktreeCalls).toEqual([]);
    expect(domain().sessions.get('AR', session.id).branch).toContain(key);

    // The machine display is the Mac's, read through the link.
    const machine = await inject(cloud(), 'GET', routes.machine(), world.cookie);
    expect(machine.statusCode).toBe(200);
    expect(machine.json()).toMatchObject({ summary: { cores: ENGINE_CORES } });
  });

  it('relays the agent’s team tools over the real route, and refuses a token that is not the engine’s', async () => {
    const { session } = await startCard('Team tools');
    const url = specOf(session.id).mcpUrl;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\//);

    const listed = await mcp(url, 'tools/list');
    expect(listed.status).toBe(200);
    expect(listed.text).toContain('send_message');

    // A token the cloud does not know, and a session token under another path: both are 404.
    const forged = await mcp(url.replace(/\/mcp\/.*$/, '/mcp/not-a-session-token'), 'tools/list');
    expect(forged.status).toBe(404);

    // Another engine's link cannot use this engine's session token either.
    const other = await inject(cloud(), 'POST', routes.engines(), world.cookie, { name: 'Other' });
    expect(other.statusCode).toBe(201);
    const { key } = other.json() as { key: string };
    const intruder = await connectRawEngine(cloud(), key);
    try {
      const reply = await intruder.call('mcp.relay', {
        token: new URL(url).pathname.replace('/mcp/', ''),
        contentType: 'application/json',
        accept: 'application/json, text/event-stream',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      expect(reply).toMatchObject({ ok: true, result: { status: 404 } });
    } finally {
      intruder.close();
    }
  });
});

/** A team tool call as the CLI makes it: JSON-RPC over the engine's loopback endpoint. */
async function mcp(url: string, method: string, params: unknown = {}): Promise<{ status: number; text: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: response.status, text: await response.text() };
}
