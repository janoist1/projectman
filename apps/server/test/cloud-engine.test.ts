import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '@projectman/shared';
import type { Task } from '@projectman/shared';
import { pdfBytes } from './helpers/attachments';
import { OWNER_ACTOR } from './helpers/domain-harness';
import { addHumanAndLogin, inject } from './helpers/app-harness';
import {
  closeCodeOfHello,
  connectRawEngine,
  createCloudEngineWorld,
  dropLinks,
  ENGINE_CORES,
  filesIn,
  rawHello,
  readEngineKey,
} from './helpers/cloud-engine';
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
const sessionOf = (taskKey: string) =>
  domain()
    .sessions.list('AR')
    .find((session) => session.workItem.type === 'task' && session.workItem.taskKey === taskKey);
const specOf = (sessionId: string) => started().find((spec) => spec.sessionId === sessionId)!;

/** Opens a card in the development stage: the cloud starts its assignee (`dev-1`) on the engine. */
async function startCard(title: string) {
  const created = await domain().tasks.create('AR', { title }, OWNER_ACTOR);
  await domain().tasks.moveToStage('AR', created.key, 'development', OWNER_ACTOR);
  await vi.waitFor(() => expect(started().length).toBeGreaterThan(0), { timeout: 15_000 });
  const session = sessionOf(created.key)!;
  return { key: created.key, session, spec: specOf(session.id) };
}

/**
 * What a CLI leaves behind after its first round: a transcript on the engine's disk, which the runner
 * reports. Without it the cloud rightly starts a new conversation instead of resuming one.
 */
async function writeTranscript(sessionId: string): Promise<void> {
  const file = join(world.src.root, 'user', '.claude', 'projects', 'pm-667', `${sessionId}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ type: 'assistant', message: 'Hello' })}\n`);
  world.fake!.runner.emit({ type: 'transcript_path', sessionId, path: file });
  await vi.waitFor(() => expect(domain().sessions.get('AR', sessionId).transcriptPath).toBe(file));
}

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

  it('does the machine and repository work on the engine, never in the cloud', async () => {
    const { key, session, spec } = await startCard('Runs on the Mac');
    expect(session.engineId).toBe(world.packaged.engine.id);

    // The member's checkout lies under the engine's home, the cloud's own home gained nothing of the kind.
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
    const { spec } = await startCard('Team tools');
    const url = spec.mcpUrl;
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

describe('the files of the cloud reach the engine', () => {
  beforeEach(async () => {
    await world.startCloud();
    await world.startEngine();
    await online();
  });

  const toolText = (reply: { text: string }): string => {
    const body = JSON.parse(
      reply.text.startsWith('{') ? reply.text : reply.text.replace(/^[\s\S]*?data: /, ''),
    );
    return (body.result.content as Array<{ type: string; text?: string }>)
      .map((part) => part.text ?? '')
      .join('\n');
  };

  it('puts a card’s attachment into the engine’s cache with the cloud’s bytes', async () => {
    const { spec } = await startCard('Reads the card’s file');
    const list = await inject(cloud(), 'GET', routes.taskAttachments('AR', world.src.taskKey), world.cookie);
    const [attachment] = (list.json() as { attachments: Array<{ id: string }> }).attachments;
    const stored = await inject(
      cloud(),
      'GET',
      routes.attachmentContent('AR', world.src.taskKey, attachment!.id),
      world.cookie,
    );

    const reply = await mcp(spec.mcpUrl, 'tools/call', {
      name: 'read_attachment',
      arguments: { task_key: world.src.taskKey, attachment_id: attachment!.id },
    });
    expect(reply.status).toBe(200);
    const path = /(\/\S*attachments-cache\/\S+)/.exec(toolText(reply))?.[1];
    expect(path, toolText(reply)).toBeDefined();
    expect(path!.startsWith(join(world.src.home, 'attachments-cache', 'AR', world.src.taskKey))).toBe(true);
    expect(readFileSync(path!).equals(stored.rawPayload)).toBe(true);
    // The cloud's own home holds the original only: it has no engine-side cache.
    expect(existsSync(join(world.cloudHome, 'attachments-cache'))).toBe(false);
  });

  it('puts a message’s attachment into the reader’s session folder on the engine', async () => {
    const { spec } = await startCard('Reads the message’s file');
    const bytes = pdfBytes();
    const file = await domain().messageAttachments.upload({
      projectKey: 'AR',
      actor: OWNER_ACTOR,
      fileName: 'plan.pdf',
      content: Readable.from([bytes]),
    });
    await domain().messaging.send(
      'AR',
      'owner',
      { to: ['dev-1'], text: 'See the file.', taskKey: null, attachmentIds: [file.id] },
      { actor: OWNER_ACTOR },
    );

    const reply = await mcp(spec.mcpUrl, 'tools/call', {
      name: 'read_message_attachment',
      arguments: { attachment_id: file.id },
    });
    expect(reply.status).toBe(200);
    const path = /(\/\S*plan\.pdf)/.exec(toolText(reply))?.[1];
    expect(path, toolText(reply)).toBeDefined();
    expect(path!.startsWith(join(world.src.root, 'system-tmp', 'projectman-sessions'))).toBe(true);
    expect(readFileSync(path!).equals(bytes)).toBe(true);
  });
});

describe('the link across drops, restarts and refusals', () => {
  const engineId = () => world.packaged.engine.id;
  const message = (taskKey: string, text: string) =>
    domain().messaging.sendReporting('AR', 'owner', { to: ['dev-1'], taskKey, text });
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  describe('with the engine connected', () => {
    beforeEach(async () => {
      await world.startCloud();
      await world.startEngine();
      await online();
    });

    it('keeps a message sent while the link is down and delivers it once when the link is back', async () => {
      const { key, session } = await startCard('The link drops');
      const runner = world.fake!.runner;
      // The engine records the start before its RPC reply reaches the cloud. Dropping the link
      // before that reply fails the in-flight start and makes the next message wake the member.
      await vi.waitFor(() => expect(domain().sessions.isRunning(session.id)).toBe(true));
      world.reconnectJitter = 1;
      dropLinks(cloud());
      // The registry keeps the engine online for two minutes after a drop; the link itself is what is gone.
      await vi.waitFor(() => expect(cloud().websocketServer.clients.size).toBe(0));
      expect(domain().sessions.isRunning(session.id)).toBe(true);

      const sent = await message(key, 'Written while the Mac was away');
      // The cloud waits for the link rather than failing the delivery: it goes through once the engine is back.
      expect(sent.recipients).toEqual([expect.objectContaining({ handle: 'dev-1', delivery: 'after_turn' })]);
      await online();
      await vi.waitFor(() => expect(runner.messages).toHaveLength(1), { timeout: 10_000 });
      await pause(1500);
      expect(runner.messages).toEqual([
        { sessionId: session.id, text: expect.stringContaining('Written while the Mac was away') },
      ]);
      // The session lived through the drop: nothing was started again, nothing ended.
      expect(started()).toHaveLength(1);
      expect(domain().sessions.get('AR', session.id).state).not.toBe('exited');
      expect(domain().engineCounters(engineId())).toMatchObject({ runningSessions: 1, waitingMessages: 0 });
    });

    it('does not repeat a session start the link dropped in the middle of, and leaves no session running unseen', async () => {
      const runner = world.fake!.runner;
      const original = runner.start.bind(runner);
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let starts = 0;
      runner.start = async (spec) => {
        starts += 1;
        await gate;
        return original(spec);
      };
      const created = await domain().tasks.create('AR', { title: 'Cut in the middle' }, OWNER_ACTOR);
      await domain().tasks.moveToStage('AR', created.key, 'development', OWNER_ACTOR);
      await vi.waitFor(() => expect(starts).toBe(1), { timeout: 15_000 });

      dropLinks(cloud());
      await vi.waitFor(() => expect(sessionOf(created.key)?.state).toBe('failed'));
      release();
      await online();
      // The engine finished the start the cloud had given up on: it ends that session, and nobody starts another.
      await vi.waitFor(() => expect(runner.list()).toEqual([]));
      await pause(1500);
      expect(starts).toBe(1);
      expect(runner.started).toHaveLength(1);
      expect(runner.stopped).toEqual([sessionOf(created.key)!.id]);
      expect(domain().engineCounters(engineId())).toMatchObject({ runningSessions: 0, waitingStarts: 0 });
    });

    it('ends the session an engine no longer reports after it restarted, and resumes it on the next message', async () => {
      const { key, session } = await startCard('The engine restarts');
      await writeTranscript(session.id);
      await world.stopEngine();
      await world.startEngine();
      await online();
      await vi.waitFor(() => expect(domain().sessions.get('AR', session.id).state).toBe('exited'));
      // The new engine process starts nothing by itself.
      await pause(500);
      expect(started()).toEqual([]);

      await message(key, 'Welcome back');
      await vi.waitFor(() => expect(started()).toHaveLength(1), { timeout: 15_000 });
      expect(started()[0]).toMatchObject({ resume: true });
      expect(domain().engineCounters(engineId()).runningSessions).toBe(1);
    });

    it('resumes interrupted remote work after a cloud restart without another start on a new message', async () => {
      const { key, session } = await startCard('The cloud restarts');
      await writeTranscript(session.id);
      const runner = world.fake!.runner;
      await world.stopCloud();
      await world.startCloud();
      await online();
      // The restarted cloud remembers no live session (its team tool tokens were in memory), so it closes
      // the one the engine still reports: no session outlives a cloud restart seamlessly. The shutdown's own
      // stop cannot reach the engine, because the links close before the runner's shutdown runs; the
      // reconciliation on reconnect is what ends it, before admission resumes the interrupted work.
      await vi.waitFor(() => expect(runner.stopped).toContain(session.id), { timeout: 15_000 });
      await vi.waitFor(() => expect(runner.started).toHaveLength(2), { timeout: 15_000 });
      expect(runner.started[1]).toMatchObject({ sessionId: session.id, resume: true });
      await vi.waitFor(() => expect(domain().sessions.isRunning(session.id)).toBe(true));
      expect(runner.list()).toHaveLength(1);
      expect(domain().engineCounters(engineId())).toMatchObject({ runningSessions: 1 });

      await message(key, 'The cloud is back');
      await vi.waitFor(
        () =>
          expect(runner.messages).toEqual(
            expect.arrayContaining([
              { sessionId: session.id, text: expect.stringContaining('The cloud is back') },
            ]),
          ),
        { timeout: 10_000 },
      );
      expect(runner.started).toHaveLength(2);
    });

    it('refuses a hello of another protocol and keeps the link it did not replace', async () => {
      const code = await closeCodeOfHello(cloud(), readEngineKey(world), rawHello({ protocol: 2 as never }));
      expect(code).toBe(4409);
      await pause(300);
      expect(world.engineOnline()).toBe(true);
    });

    it('does not take a revoked engine back, and has no machine to show afterwards', async () => {
      const revoked = await inject(cloud(), 'POST', routes.revokeEngine(engineId()), world.cookie);
      expect(revoked.statusCode).toBeLessThan(300);
      await vi.waitFor(() => expect(world.engineOnline()).toBe(false));
      // The engine's backoff is a few hundred milliseconds here: it would be back by now if it were let in.
      await pause(2500);
      expect(world.engineOnline()).toBe(false);
      const machine = await inject(cloud(), 'GET', routes.machine(), world.cookie);
      expect(machine.statusCode).toBe(409);
      expect(machine.json()).toMatchObject({ error: { code: 'engine_offline' } });
    });
  });

  it('accepts an engine of another version, and flags it', async () => {
    await world.startCloud();
    await world.startEngine({ version: 'an-older-version' });
    await online();
    const status = cloud()
      .projectman.engineRegistry!.list()
      .find((item) => item.id === engineId());
    expect(status).toMatchObject({ online: true, versionMismatch: true });
    const machine = await inject(cloud(), 'GET', routes.machine(), world.cookie);
    expect(machine.statusCode).toBe(200);
  });
});

/** A team tool call as the CLI makes it: JSON-RPC over the engine's loopback endpoint. */
async function mcp(
  url: string,
  method: string,
  params: unknown = {},
): Promise<{ status: number; text: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: response.status, text: await response.text() };
}
