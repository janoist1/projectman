import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolContext } from '../contracts';
import { TeamToolError } from '../contracts';
import { OPERATOR_GUEST_TOOLS, OPERATOR_READ_TOOLS } from '../services/operator';
import { createMcpModule } from './index';
import { createTeamMcpServer, DEFAULT_TOOL_TIMEOUT_MS } from './server';
import {
  createFakeTeamToolsHandler,
  devContext,
  pmContext,
  operatorAudience,
  qaContext,
  type FakeTeamToolsHandler,
} from './testing';

/*
 * The tool tests talk to the tools over an in-memory transport (`startTools`). The endpoint tests
 * (tokens, HTTP methods, localhost) use the real HTTP route (`startServer`): that is their boundary.
 * The tool definitions (descriptions, input schemas, annotations) are guarded by the snapshot in
 * tools.test.ts, and the result texts by format.test.ts: nothing here repeats them.
 */

/* ---------- harness ---------- */

type LogLine = { level: number; msg: string; [key: string]: unknown };

function loggingApp(logs: LogLine[]): FastifyInstance {
  return Fastify({
    logger: { level: 'debug', stream: { write: (line: string) => logs.push(JSON.parse(line)) } },
  });
}

interface Harness {
  app: FastifyInstance;
  baseUrl: string;
  handler: FakeTeamToolsHandler;
  tokens: Map<string, ToolContext>;
  /** Parsed pino log lines of the app. */
  logs: LogLine[];
  resolveCalls: string[];
}

interface ToolSession {
  client: Client;
  handler: FakeTeamToolsHandler;
  logs: LogLine[];
}

const harnesses: Harness[] = [];
const clients: Client[] = [];
const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(cleanups.splice(0).map((close) => close()));
  await Promise.all(harnesses.splice(0).map((h) => h.app.close()));
});

async function startServer(
  options: { toolTimeoutMs?: number; configure?: (app: FastifyInstance) => void } = {},
): Promise<Harness> {
  const logs: LogLine[] = [];
  const app = loggingApp(logs);
  options.configure?.(app);
  const handler = createFakeTeamToolsHandler();
  const tokens = new Map<string, ToolContext>([
    ['token-dev', devContext],
    ['token-qa', qaContext],
    ['token-pm', pmContext],
  ]);
  const resolveCalls: string[] = [];
  createMcpModule({
    audienceOf: () => operatorAudience,
    handler,
    resolveContext: (token) => {
      resolveCalls.push(token);
      return tokens.get(token) ?? null;
    },
    logger: app.log,
    ...(options.toolTimeoutMs ? { toolTimeoutMs: options.toolTimeoutMs } : {}),
  }).registerRoutes(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  const harness = { app, baseUrl: `http://127.0.0.1:${port}`, handler, tokens, logs, resolveCalls };
  harnesses.push(harness);
  return harness;
}

async function connect(h: Harness, token: string): Promise<Client> {
  const client = new Client({ name: 'claude-code-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${h.baseUrl}/mcp/${token}`)));
  clients.push(client);
  return client;
}

/** A client of the tools of one session, without HTTP; `handler` shares one fake between sessions. */
async function startTools(
  ctx: ToolContext = devContext,
  options: { handler?: FakeTeamToolsHandler; toolTimeoutMs?: number } = {},
): Promise<ToolSession> {
  const logs: LogLine[] = [];
  const app = loggingApp(logs);
  const handler = options.handler ?? createFakeTeamToolsHandler();
  const server = createTeamMcpServer(ctx, {
    audienceOf: () => operatorAudience,
    handler,
    logger: app.log,
    toolTimeoutMs: options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'claude-code-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  clients.push(client);
  cleanups.push(
    () => server.close(),
    () => app.close(),
  );
  return { client, handler, logs };
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

function text(result: ToolResult): string {
  return result.content.map((c) => c.text ?? '').join('\n');
}

/** Every variant is an error result and none reaches the handler. */
async function expectRefused(
  { client, handler }: ToolSession,
  name: string,
  variants: Record<string, unknown>[],
): Promise<void> {
  const before = handler.calls.length;
  for (const args of variants) {
    const result = await call(client, name, args);
    expect(result.isError, JSON.stringify(args).slice(0, 80)).toBe(true);
  }
  expect(handler.calls).toHaveLength(before);
}

const initializeRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
};
const mcpHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

/* ---------- protocol ---------- */

describe('team MCP endpoint', () => {
  it('initializes a client statelessly and sends short team instructions', async () => {
    const h = await startServer();
    const client = await connect(h, 'token-dev');

    expect(client.getServerVersion()?.name).toBe('projectman-team');
    expect(client.getServerCapabilities()?.tools).toBeDefined();
    // The team rules are in every member's system prompt; the instructions only point there.
    expect((client.getInstructions() ?? '').length).toBeLessThan(300);
  });

  it('keeps team rules out of the tool descriptions', async () => {
    const { client } = await startTools();
    const { tools } = await client.listTools();

    // Stated once in the system prompt ("How the team works").
    for (const tool of tools) {
      expect(JSON.stringify(tool), tool.name).not.toContain("project's language");
      expect(JSON.stringify(tool), tool.name).not.toMatch(/be concise/i);
    }
  });
});

/* ---------- attachment tools ---------- */

describe('attachment tools', () => {
  it('list_attachments pages by offset and limit and says where the rest is', async () => {
    const { client, handler } = await startTools();
    expect(text(await call(client, 'get_task', { task_key: 'AR-21' }))).toContain('att_screenshot01');

    for (let i = 0; i < 4; i++)
      await call(client, 'attach_file', { task_key: 'AR-21', path: `shots/${i}.png` });
    const page = text(await call(client, 'list_attachments', { task_key: 'AR-21', offset: 1, limit: 2 }));
    expect(handler.calls.at(-1)?.args).toEqual({ taskKey: 'AR-21', offset: 1, limit: 2 });
    expect(page).toContain('2–3 of 5');
    expect(page).toContain('"0.png"');
    expect(page).toContain('list_attachments with task_key AR-21 and offset 3');
    expect(text(await call(client, 'list_attachments', { task_key: 'AR-21', offset: 9 }))).toContain(
      'none from offset 9',
    );
  });

  it('read_attachment gives the local path, never the content, and refuses an id that is no id', async () => {
    const dev = await startTools();
    const own = text(
      await call(dev.client, 'read_attachment', { task_key: 'AR-21', attachment_id: 'att_screenshot01' }),
    );
    expect(own).toContain('Local path: /tmp/attachments/AR/AR-21/att_screenshot01.png');
    expect(own).not.toContain('may ask a human for permission');
    // A session of another work item may be asked before it reads the file.
    const qa = await startTools(qaContext, { handler: dev.handler });
    const other = text(
      await call(qa.client, 'read_attachment', { task_key: 'AR-21', attachment_id: 'att_screenshot01' }),
    );
    expect(other).toContain('may ask a human for permission');

    await expectRefused(dev, 'read_attachment', [{ task_key: 'AR-21', attachment_id: '../../db.sqlite' }]);
  });

  it('read_message_attachment returns an image as an image part, and refuses an id of another shape', async () => {
    const session = await startTools();
    const result = (await session.client.callTool({
      name: 'read_message_attachment',
      arguments: { attachment_id: 'msa_abcdefghij' },
    })) as {
      isError?: boolean;
      content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    };
    expect(result.isError).toBeFalsy();
    expect(result.content.map((part) => part.type)).toEqual(['text', 'image']);
    expect(result.content[1]).toMatchObject({
      mimeType: 'image/webp',
      data: Buffer.from('fake-webp').toString('base64'),
    });
    expect(session.handler.calls.at(-1)).toMatchObject({
      method: 'readMessageAttachment',
      args: { attachmentId: 'msa_abcdefghij' },
    });

    await expectRefused(session, 'read_message_attachment', [{ attachment_id: 'att_abcdefghij' }]);
  });

  it('attach_file passes only the task and the path; the caller is the session the token names', async () => {
    const session = await startTools();
    const result = await call(session.client, 'attach_file', { task_key: 'AR-21', path: 'shots/after.png' });
    expect(result.isError).toBeFalsy();
    expect(session.handler.calls.at(-1)).toEqual({
      method: 'attachFile',
      ctx: devContext,
      args: { taskKey: 'AR-21', path: 'shots/after.png' },
    });
    // A working directory, an uploader or a storage place cannot be passed.
    await expectRefused(
      session,
      'attach_file',
      [{ cwd: '/' }, { uploaded_by: 'owner' }, { storage_path: '/tmp' }].map((extra) => ({
        task_key: 'AR-21',
        path: 'a.png',
        ...extra,
      })),
    );
  });

  it('hand_off passes the task and the trimmed note; an empty note or an extra field is refused (PM-342)', async () => {
    const session = await startTools();
    const result = await call(session.client, 'hand_off', {
      task_key: 'AR-21',
      note: '  Form done; API call missing.  ',
    });
    expect(result.isError).toBeFalsy();
    expect(session.handler.calls.at(-1)).toEqual({
      method: 'handOff',
      ctx: devContext,
      args: { taskKey: 'AR-21', note: 'Form done; API call missing.' },
    });
    await expectRefused(
      session,
      'hand_off',
      [{ note: '   ' }, { note: 'x'.repeat(10_001) }, { note: 'ok', member: 'dev-2' }].map((bad) => ({
        task_key: 'AR-21',
        ...bad,
      })),
    );
  });

  it('take_screenshots passes only the validated fields; only the scenario is required', async () => {
    const session = await startTools();
    const result = await call(session.client, 'take_screenshots', {
      scenario: 'scripts/scenarios/card.mjs',
      widths: [1512, 390],
      full_page: true,
      scale: 2,
      timeout_seconds: 120,
      seed: 'none',
    });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('/sessions/ses_dev/shots/card/card-1512.png');
    expect(session.handler.calls.at(-1)).toEqual({
      method: 'takeScreenshots',
      ctx: devContext,
      args: {
        scenario: 'scripts/scenarios/card.mjs',
        widths: [1512, 390],
        fullPage: true,
        scale: 2,
        timeoutSeconds: 120,
        seed: 'none',
      },
    });
    await call(session.client, 'take_screenshots', { scenario: 'a.mjs' });
    expect(session.handler.calls.at(-1)?.args).toEqual({ scenario: 'a.mjs' });
  });

  it('take_screenshots refuses what is out of bounds, and an output folder or a command of the caller’s', async () => {
    const session = await startTools();
    await expectRefused(session, 'take_screenshots', [
      { scenario: '' },
      { scenario: 'a'.repeat(501) },
      { scenario: 'a.mjs', widths: [] },
      { scenario: 'a.mjs', widths: [199] },
      { scenario: 'a.mjs', widths: [4001] },
      { scenario: 'a.mjs', widths: [300, 400, 500, 600, 700, 800, 900, 1000, 1100] },
      { scenario: 'a.mjs', scale: 3 },
      { scenario: 'a.mjs', timeout_seconds: 0 },
      { scenario: 'a.mjs', timeout_seconds: 601 },
      { scenario: 'a.mjs', seed: 'other' },
      { scenario: 'a.mjs', out: '/tmp/x' },
      { scenario: 'a.mjs', keep_data: true },
      { scenario: 'a.mjs', machine: 'm.json' },
      { scenario: 'a.mjs', args: ['--out', '/'] },
    ]);
  });

  it('get_screenshot_run shows a run that goes on, and an unknown run as an error', async () => {
    const { client } = await startTools();
    expect(text(await call(client, 'get_screenshot_run', { run_id: 'shr_fake0001' }))).toContain(
      'is running',
    );
    const unknown = await call(client, 'get_screenshot_run', { run_id: 'shr_other' });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toContain('Error [not_found]');
    for (const run_id of ['', 'x'.repeat(65)])
      expect((await call(client, 'get_screenshot_run', { run_id })).isError, run_id).toBe(true);
  });

  it('delete_attachment deletes the caller’s own attachment and reports the refusal of others’', async () => {
    const { client } = await startTools();
    await call(client, 'attach_file', { task_key: 'AR-21', path: 'mistake.png' });
    const deleted = await call(client, 'delete_attachment', {
      task_key: 'AR-21',
      attachment_id: 'att_fake00000001',
    });
    expect(deleted.isError).toBeFalsy();
    const refused = await call(client, 'delete_attachment', {
      task_key: 'AR-21',
      attachment_id: 'att_screenshot01',
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('Error [forbidden]');
  });
});

/* ---------- tools ---------- */

describe('team tools', () => {
  it.each([
    { topic: 'rules', heading: '# Team rules' },
    { topic: 'role', heading: '# Role guide' },
  ])('get_guide returns $topic markdown for the caller session', async ({ topic, heading }) => {
    expect(OPERATOR_READ_TOOLS.has('get_guide')).toBe(true);
    expect(OPERATOR_GUEST_TOOLS.has('get_guide')).toBe(true);
    const { client, handler } = await startTools();
    const result = await call(client, 'get_guide', { topic });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain(heading);
    expect(handler.calls.at(-1)).toEqual({ method: 'getGuide', ctx: devContext, args: { topic } });
  });
  it('get_guide preserves a missing session role refusal', async () => {
    const { client, handler } = await startTools();
    handler.failNext('getGuide', new TeamToolError('not_found', 'This session has no role guide.'));
    const missing = await call(client, 'get_guide', { topic: 'role' });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain('[not_found]');
  });
  it('get_guide refuses unknown topics before calling the handler', async () => {
    await expectRefused(await startTools(), 'get_guide', [{ topic: 'unknown' }]);
  });
  it('forwards the arguments of the simple tools with the caller context', async () => {
    const { client, handler } = await startTools();
    const cases: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
      ['get_project_state', { task_key: 'AR-21' }, 'getProjectState', { taskKey: 'AR-21' }],
      [
        'link_pull_request',
        { task_key: 'AR-21', repo: 'acme/web', number: 42 },
        'linkPullRequest',
        { taskKey: 'AR-21', repo: 'acme/web', number: 42 },
      ],
      [
        'withdraw_question',
        { item_id: 'inbox_1', reason: 'Decided in chat.' },
        'withdrawQuestion',
        { itemId: 'inbox_1', reason: 'Decided in chat.' },
      ],
      [
        'save_memory',
        { note: 'E2E tests run with npm run e2e.' },
        'saveMemory',
        { note: 'E2E tests run with npm run e2e.' },
      ],
      [
        'set_current_work',
        { summary: 'The gateway tests are being written', detail: 'More.' },
        'setCurrentWork',
        { summary: 'The gateway tests are being written', detail: 'More.' },
      ],
    ];
    for (const [tool, args, method, expected] of cases) {
      const result = await call(client, tool, args);
      expect(result.isError, tool).toBeFalsy();
      expect(handler.calls.at(-1), tool).toEqual({ method, ctx: devContext, args: expected });
    }
  });

  it('get_project_state preserves the Operator refusal', async () => {
    const { client, handler } = await startTools();
    handler.failNext(
      'getProjectState',
      new TeamToolError('forbidden', 'operator_only: only the Operator may read project state.'),
    );
    const refused = await call(client, 'get_project_state', {});
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('Error [forbidden]: operator_only:');
  });

  it('send_message passes the caller context, drops repeated and trimmed recipients, defaults the task', async () => {
    const { client, handler } = await startTools();

    const result = await call(client, 'send_message', {
      kind: 'action',
      to: ['cr', 'fe-1', 'cr', 'owner'],
      text: '  Ready for review ✅ — naïve café  ',
    });

    expect(result.isError).toBeFalsy();
    expect(handler.calls).toEqual([
      {
        method: 'sendMessage',
        ctx: devContext,
        args: {
          kind: 'action',
          to: ['cr', 'owner'],
          text: 'Ready for review ✅ — naïve café',
          taskKey: 'AR-21',
        },
      },
    ]);
  });

  it('send_message passes the file paths once each and accepts at most ten (PM-520)', async () => {
    const session = await startTools();

    const result = await call(session.client, 'send_message', {
      kind: 'info',
      to: ['owner'],
      text: 'Screenshot',
      attachments: ['shots/a.png', ' shots/a.png ', 'b.txt'],
    });
    expect(result.isError).toBeFalsy();
    expect(session.handler.calls[0]).toMatchObject({
      method: 'sendMessage',
      args: { attachments: ['shots/a.png', 'b.txt'] },
    });

    await expectRefused(
      session,
      'send_message',
      [[], Array.from({ length: 11 }, (_, i) => `f${i}.txt`), ['']].map((attachments) => ({
        kind: 'info',
        to: ['owner'],
        text: 'x',
        attachments,
      })),
    );
  });

  it('send_message refuses a message addressed only to the caller', async () => {
    const { client, handler } = await startTools();

    const result = await call(client, 'send_message', { kind: 'action', to: ['fe-1'], text: 'Note to self' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Error [invalid]: You cannot send a message to yourself');
    expect(handler.calls).toEqual([]);
  });

  it('send_message from a session without a task sends a general message unless a task is named', async () => {
    const { client, handler } = await startTools(qaContext);

    await call(client, 'send_message', { kind: 'action', to: ['fe-1'], text: 'Hi' });
    await call(client, 'send_message', {
      kind: 'action',
      to: ['fe-1'],
      text: 'About the login',
      task_key: 'AR-21',
    });

    expect(handler.calls.map((c) => c.args)).toEqual([
      { kind: 'action', to: ['fe-1'], text: 'Hi' },
      { kind: 'action', to: ['fe-1'], text: 'About the login', taskKey: 'AR-21' },
    ]);
  });

  it('list_members marks the caller in the roster', async () => {
    const { client, handler } = await startTools();

    const out = text(await call(client, 'list_members'));

    expect(out).toContain('fe-1 (you)');
    expect(out).not.toContain('qa (you)');
    expect(handler.calls[0]).toMatchObject({ method: 'listMembers', ctx: devContext });
  });

  it('list_tasks returns compact JSON and passes defaults and filters to the handler', async () => {
    const session = await startTools();
    const { client, handler } = session;
    const tasks = JSON.parse(text(await call(client, 'list_tasks')));
    expect(tasks).toEqual([
      {
        key: 'AR-21',
        title: 'Validate the login form',
        stageId: 'dev',
        status: 'active',
        assignee: 'fe-1',
        labels: ['frontend'],
        updatedAt: '2026-09-29T09:00:00.000Z',
      },
    ]);
    expect(handler.calls.at(-1)).toEqual({
      method: 'listTasks',
      ctx: devContext,
      args: { status: 'open', limit: 50 },
    });
    await call(client, 'list_tasks', { status: 'done', stage: 'done', assignee: 'me', limit: 200 });
    expect(handler.calls.at(-1)?.args).toEqual({
      status: 'done',
      stage: 'done',
      assignee: 'me',
      limit: 200,
    });
    await expectRefused(session, 'list_tasks', [
      { limit: 201 },
      { limit: 0 },
      { limit: 1.5 },
      { status: 'unknown' },
      { extra: true },
    ]);
  });

  it('a description longer than 15 000 characters survives get_task and an edit with update_task', async () => {
    const { client, handler } = await startTools(qaContext);
    const tail = `${'Technical plan, step by step. '.repeat(520)}\n## Last section\nKeep this.`;
    const description = `## Goal\nOld goal.\n\n${tail}`;
    expect(description.length).toBeGreaterThan(15_000);
    handler.tasks.get('AR-21')!.task.description = description;

    const out = text(await call(client, 'get_task', { task_key: 'AR-21' }));
    expect(handler.calls[0]).toEqual({ method: 'getTask', ctx: qaContext, args: { taskKey: 'AR-21' } });
    expect(out).toContain(`Description:\n${description}\n`);
    expect(out).not.toContain('only part of it');

    const result = await call(client, 'update_task', {
      task_key: 'AR-21',
      description: description.replace('Old goal.', 'New goal.'),
    });
    expect(result.isError).toBeFalsy();
    expect(handler.tasks.get('AR-21')!.task.description).toBe(`## Goal\nNew goal.\n\n${tail}`);
  });

  it('get_task reads a description longer than update_task accepts in parts, saying what is missing', async () => {
    const { client, handler } = await startTools(qaContext);
    handler.tasks.get('AR-21')!.task.description = `${'a'.repeat(20_000)}${'b'.repeat(1_500)}`;

    const first = text(await call(client, 'get_task', { task_key: 'AR-21' }));
    expect(first).toContain('characters 1–20000 of 21500; only part of it');
    expect(first).toContain('1500 more characters are not shown');
    expect(first).toContain('description_offset 20000');

    const rest = text(await call(client, 'get_task', { task_key: 'AR-21', description_offset: 20_000 }));
    expect(rest).toContain(`characters 20001–21500 of 21500; only part of it):\n${'b'.repeat(1_500)}\n`);
    expect((await call(client, 'get_task', { task_key: 'AR-21', description_offset: -1 })).isError).toBe(
      true,
    );
  });

  it('get_task shows the recommended developer only when one is set (PM-347)', async () => {
    const { client } = await startTools();

    expect(text(await call(client, 'get_task', { task_key: 'AR-21' }))).not.toContain(
      'Recommended developer',
    );
    await call(client, 'update_task', {
      task_key: 'AR-21',
      developer_level: 'senior',
      developer_level_reason: 'the runner',
    });
    expect(text(await call(client, 'get_task', { task_key: 'AR-21' }))).toContain(
      'Recommended developer: senior (the runner)',
    );
  });

  it('update_task passes each field on, trimmed and in the shape of the handler', async () => {
    const { client, handler } = await startTools();
    const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      [
        'title and description',
        { title: '  New title ', description: '## Goal\nText.' },
        { title: 'New title', description: '## Goal\nText.' },
      ],
      ['repo', { repo: ' api ' }, { repo: 'api' }],
      ['repo cleared', { repo: null }, { repo: null }],
      ['priority', { priority: 'high' }, { priority: 'high' }],
      ['priority cleared', { priority: null }, { priority: null }],
      [
        'relations',
        {
          add_relations: [
            { kind: 'prerequisite', task_key: 'AR-19' },
            { kind: 'related', task_key: 'AR-20' },
          ],
          remove_relations: [{ kind: 'prerequisite_of', task_key: 'AR-22' }],
        },
        {
          relations: {
            add: [
              { kind: 'prerequisite', key: 'AR-19' },
              { kind: 'related', key: 'AR-20' },
            ],
            remove: [{ kind: 'prerequisite_of', key: 'AR-22' }],
          },
        },
      ],
      [
        'recommended developer',
        { developer_level: 'senior', developer_level_reason: 'the runner' },
        { developerLevel: { level: 'senior', reason: 'the runner' } },
      ],
      [
        'recommended developer without a reason',
        { developer_level: 'any' },
        { developerLevel: { level: 'any', reason: null } },
      ],
      ['theme', { theme_key: 'AR-30' }, { themeKey: 'AR-30' }],
      ['theme removed', { theme_key: null }, { themeKey: null }],
      [
        'labels, note and stage move',
        { add_labels: ['code-review-ok'], note: 'No findings.', stage_id: 'qa' },
        { stageId: 'qa', addLabels: ['code-review-ok'], note: 'No findings.' },
      ],
    ];
    for (const [label, args, expected] of cases) {
      const result = await call(client, 'update_task', { task_key: 'AR-21', ...args });
      expect(result.isError, label).toBeFalsy();
      expect(handler.calls.at(-1), label).toEqual({
        method: 'updateTask',
        ctx: devContext,
        args: { taskKey: 'AR-21', ...expected },
      });
    }
  });

  it('update_task refuses an invalid or empty change before the handler', async () => {
    const session = await startTools();
    const nothing = await call(session.client, 'update_task', { task_key: 'AR-21' });
    expect(nothing.isError).toBe(true);
    expect(text(nothing)).toContain('Error [invalid]: Nothing to update');

    await expectRefused(
      session,
      'update_task',
      [
        { priority: 'medium' },
        { description: '   ' },
        { repo: '' },
        { repo: '   ' },
        { repo: 'x'.repeat(65) },
        { repo: 42 },
        { theme_key: 'nope' },
        { developer_level: 'boss' },
        { developer_level_reason: 'why' },
        { developer_level: 'senior', developer_level_reason: '' },
        { developer_level: 'senior', developer_level_reason: 'x'.repeat(301) },
        // A relation kind that cannot be added, a bad card key, a kind that does not exist.
        { add_relations: [{ kind: 'prerequisite_of', task_key: 'AR-19' }] },
        { add_relations: [{ kind: 'duplicated_by', task_key: 'AR-19' }] },
        { add_relations: [{ kind: 'related', task_key: 'nope' }] },
        { remove_relations: [{ kind: 'blocks', task_key: 'AR-19' }] },
      ].map((bad) => ({ task_key: 'AR-21', ...bad })),
    );
  });

  it('update_task passes the refusal of the handler on, and changes nothing', async () => {
    const { client, handler } = await startTools();

    const unknown = await call(client, 'update_task', { task_key: 'AR-21', repo: 'mobile' });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toContain('Error [invalid]: unknown repository: mobile');
    expect(handler.tasks.get('AR-21')!.task.repo).toBe('web');
  });

  it('create_task passes each field on in the shape of the handler', async () => {
    const { client, handler } = await startTools();
    const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      [
        'description and deduplicated labels',
        { title: 'Bug', description: 'Steps to reproduce.', labels: ['bug', 'bug'] },
        { title: 'Bug', description: 'Steps to reproduce.', labels: ['bug'] },
      ],
      [
        'relations',
        { title: 'Follow-up', relations: [{ kind: 'prerequisite', task_key: 'AR-21' }] },
        { title: 'Follow-up', relations: [{ kind: 'prerequisite', key: 'AR-21' }] },
      ],
      ['parent', { title: 'Child', parent_key: 'AR-21' }, { title: 'Child', parentKey: 'AR-21' }],
      ['theme of the card', { title: 'Card', theme_key: 'AR-30' }, { title: 'Card', themeKey: 'AR-30' }],
      ['theme kind', { title: 'Epic', kind: 'theme' }, { title: 'Epic', kind: 'theme' }],
      ['plain kind is no kind to send', { title: 'Plain', kind: 'task' }, { title: 'Plain' }],
      [
        'recommended developer',
        { title: 'Planned', developer_level: 'senior', developer_level_reason: 'the sandbox' },
        { title: 'Planned', developerLevel: { level: 'senior', reason: 'the sandbox' } },
      ],
    ];
    for (const [label, args, expected] of cases) {
      const result = await call(client, 'create_task', args);
      expect(result.isError, label).toBeFalsy();
      expect(handler.calls.at(-1), label).toEqual({ method: 'createTask', ctx: devContext, args: expected });
    }
  });

  it('create_task refuses a priority and any other invalid field before the handler', async () => {
    const session = await startTools();
    const priority = await call(session.client, 'create_task', { title: 'New card', priority: null });
    expect(priority.isError).toBe(true);
    expect(text(priority)).toContain('priority is set by people only');

    await expectRefused(session, 'create_task', [
      { title: 'x', visibility: 'public' },
      { title: 'Card', kind: 'epic' },
      { title: 'Card', developer_level_reason: 'why' },
    ]);
  });

  it('set_current_work refuses a long or many-line sentence and a session without a task', async () => {
    const dev = await startTools();
    await expectRefused(dev, 'set_current_work', [
      { summary: 'x'.repeat(81) },
      { summary: 'First line\nsecond line' },
      { summary: '   ' },
      { summary: 'Fine', detail: 'x'.repeat(301) },
    ]);

    const qa = await startTools(qaContext);
    const refused = await call(qa.client, 'set_current_work', { summary: 'Something is being tested' });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('only for a session working on a task');
  });

  it('ask_human trims the question and the options, and passes the recipient, the recommendation and the details', async () => {
    const { client, handler } = await startTools();
    const details = '`EmailField` already renders `aria-live` errors.\n\nA toast needs a new provider.';

    const result = await call(client, 'ask_human', {
      question: '  Should a wrong email show its error under the field or as a pop-up?  ',
      options: [
        { label: ' Under the field ', consequence: ' The message stays until the address is fixed. ' },
        { label: 'Pop-up', consequence: 'It disappears after a few seconds, so it can be missed.' },
        'Nowhere',
      ],
      recommended: ' Under the field ',
      recommendation_reason: 'It is easier to read on a phone.',
      details,
      to: ['owner'],
    });

    expect(result.isError).toBeFalsy();
    expect(handler.calls).toEqual([
      {
        method: 'askHuman',
        ctx: devContext,
        args: {
          question: 'Should a wrong email show its error under the field or as a pop-up?',
          options: [
            { label: 'Under the field', consequence: 'The message stays until the address is fixed.' },
            { label: 'Pop-up', consequence: 'It disappears after a few seconds, so it can be missed.' },
            'Nowhere',
          ],
          recommended: 'Under the field',
          recommendationReason: 'It is easier to read on a phone.',
          details,
          taskKey: 'AR-21',
          to: ['owner'],
        },
      },
    ]);
  });

  it('ask_human refuses a recommendation that is not one of the options, before the handler', async () => {
    const session = await startTools();
    const question = 'Should the error be shown inline or as a toast?';
    const options = ['Inline', { label: 'Toast', consequence: 'It disappears.' }];

    await expectRefused(session, 'ask_human', [
      { question, options, recommended: 'Dialog' },
      { question, recommended: 'Inline' },
      { question, recommendation_reason: 'It is clearer.' },
      { question, options: [{ label: 'Inline', description: 'It is clearer.' }] },
    ]);

    // A recommendation that matches an option goes through, however the option was written.
    for (const recommended of ['Inline', 'Toast']) {
      const ok = await call(session.client, 'ask_human', {
        question,
        options,
        recommended,
        recommendation_reason: 'It is clearer.',
      });
      expect(ok.isError).toBeFalsy();
    }
    expect(session.handler.calls.map((c) => (c.args as { recommended: string }).recommended)).toEqual([
      'Inline',
      'Toast',
    ]);
  });

  it('ask_human keeps every plain-language field optional', async () => {
    const { client, handler } = await startTools(qaContext);

    const result = await call(client, 'ask_human', { question: 'Which staging URL should I test?' });

    expect(result.isError).toBeFalsy();
    expect(handler.calls[0]).toEqual({
      method: 'askHuman',
      ctx: qaContext,
      args: { question: 'Which staging URL should I test?' },
    });
  });
});

/* ---------- feedback tools ---------- */

describe('feedback tools', () => {
  const MARK = 'fbm_fake0000000001';

  it('get_feedback lists the marks to decide with defaults, and takes a status and a limit', async () => {
    const { client, handler } = await startTools(pmContext);
    expect(text(await call(client, 'get_feedback'))).toContain(MARK);
    expect(handler.calls.find((c) => c.method === 'getFeedbackList')!.args).toEqual({
      status: 'todo',
      limit: 30,
    });
    await call(client, 'get_feedback', { status: 'all', limit: 5 });
    expect(handler.calls.filter((c) => c.method === 'getFeedbackList').at(-1)!.args).toEqual({
      status: 'all',
      limit: 5,
    });
  });

  it('get_feedback with a mark shows it in full and where its screenshot is', async () => {
    const { client, handler } = await startTools(pmContext);
    const read = text(await call(client, 'get_feedback', { mark_id: MARK }));
    expect(read).toContain(MARK);
    expect(read).toContain('/tmp/feedback/AR/fbm_fake0000000001.jpg');
    expect(handler.calls.filter((c) => c.method === 'getFeedbackMark')).toHaveLength(1);
  });

  it('reports each decision with the state the mark is in now', async () => {
    const { client, handler } = await startTools(pmContext);
    await call(client, 'reply_feedback', { mark_id: MARK, body: 'Which page?' });
    const created = text(
      await call(client, 'create_task_from_feedback', {
        mark_id: MARK,
        title: 'Fix the total',
        description: 'The total is wrong.',
        reply: 'A card is open.',
      }),
    );
    expect(created).toContain('AR-77');
    expect(created).toContain('card_created');
    await call(client, 'link_feedback', { mark_id: MARK, task_key: 'AR-21' });
    const forwarded = text(
      await call(client, 'forward_feedback', { mark_id: MARK, reason: 'Price decision', reply: 'Asked.' }),
    );
    expect(forwarded).toContain('waiting_owner');
    await call(client, 'close_feedback', { mark_id: MARK });

    expect(handler.calls.map((c) => c.method)).toEqual([
      'replyFeedback',
      'createTaskFromFeedback',
      'linkFeedback',
      'forwardFeedback',
      'closeFeedback',
    ]);
  });

  it('refuses invalid arguments before the handler', async () => {
    const { client, handler } = await startTools(pmContext);
    const refusals: Array<[string, Record<string, unknown>]> = [
      ['get_feedback', { mark_id: 'AR-1' }],
      ['get_feedback', { limit: 101 }],
      ['reply_feedback', { mark_id: MARK, body: '  ' }],
      ['forward_feedback', { mark_id: MARK, reason: 'Why' }],
      ['close_feedback', { mark_id: MARK, reply: 'x'.repeat(4001) }],
    ];
    for (const [name, args] of refusals)
      expect((await call(client, name, args)).isError, `${name} ${JSON.stringify(args).slice(0, 40)}`).toBe(
        true,
      );
    expect(handler.calls).toEqual([]);
  });

  it('tells a member that does not process feedback why it is refused', async () => {
    const { client } = await startTools();
    for (const [name, args] of [
      ['get_feedback', {}],
      ['close_feedback', { mark_id: MARK }],
    ] as const) {
      const refused = await call(client, name, args);
      expect(refused.isError, name).toBe(true);
      expect(text(refused), name).toContain('Error [forbidden]: feedback_processor_only');
    }
  });
});

/* ---------- errors ---------- */

describe('tool errors', () => {
  it('rejects invalid arguments without calling the handler', async () => {
    const { client, handler } = await startTools();

    const badHandle = await call(client, 'send_message', { to: ['@qa'], text: 'hi' });
    const unknownKey = await call(client, 'update_task', { task_key: 'AR-21', comment: 'typo' });
    const missing = await call(client, 'get_task', {});

    for (const result of [badHandle, unknownKey, missing]) {
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('Input validation error');
    }
    expect(text(unknownKey)).toContain('comment');
    expect(handler.calls).toEqual([]);
  });

  it('turns TeamToolError into an error result carrying its code', async () => {
    const { client } = await startTools();

    const blocked = await call(client, 'update_task', { task_key: 'AR-21', stage_id: 'qa' });

    expect(blocked).toMatchObject({ isError: true });
    expect(text(blocked)).toBe('Error [gate_blocked]: Stage "qa" requires the label "code-review-ok".');
  });

  it('hides unexpected errors from the model and logs them', async () => {
    const { client, handler, logs } = await startTools();
    handler.failNext('listMembers', new Error('database is locked'));

    const result = await call(client, 'list_members');

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Error [internal]');
    expect(text(result)).not.toContain('database is locked');
    const logged = logs.find((l) => l.msg === 'team tool failed');
    expect(logged).toMatchObject({ level: 50, tool: 'list_members', member: 'fe-1', sessionId: 'ses_dev' });
    expect(JSON.stringify(logged)).toContain('database is locked');
  });

  it('answers a handler that does not settle with a timeout error', async () => {
    const { client, handler } = await startTools(devContext, { toolTimeoutMs: 50 });
    handler.failNext('getTask', 'hang');

    const result = await call(client, 'get_task', { task_key: 'AR-21' });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^Error \[timeout\]: The team service did not answer/);
    // The endpoint keeps working afterwards.
    expect((await call(client, 'get_task', { task_key: 'AR-21' })).isError).toBeFalsy();
  });
});

/* ---------- tokens, sessions and HTTP methods ---------- */

describe('tokens and HTTP methods', () => {
  it('rejects an unknown token with 404 and never reaches the handler', async () => {
    const h = await startServer();

    await expect(connect(h, 'secret-unknown-token')).rejects.toMatchObject({ code: 404 });
    const response = await fetch(`${h.baseUrl}/mcp/secret-unknown-token`, {
      method: 'POST',
      headers: mcpHeaders,
      body: JSON.stringify(initializeRequest),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 }, id: null });
    expect(h.handler.calls).toEqual([]);
    // The token is part of the URL: it must not end up in the logs.
    expect(JSON.stringify(h.logs)).not.toContain('secret-unknown-token');
  });

  it('enforces its one MiB body limit', async () => {
    const h = await startServer();
    const response = await h.app.inject({
      method: 'POST',
      url: '/mcp/token-dev',
      headers: mcpHeaders,
      payload: JSON.stringify({ padding: 'x'.repeat(1024 * 1024) }),
    });
    expect(response.statusCode).toBe(413);
    expect(h.handler.calls).toEqual([]);
  });

  it('rechecks a token revoked while its body was being received', async () => {
    let revoke = () => {};
    const h = await startServer({
      configure: (app) => {
        app.addHook('preHandler', async () => {
          revoke();
        });
      },
    });
    revoke = () => {
      h.tokens.delete('token-dev');
    };
    const response = await h.app.inject({
      method: 'POST',
      url: '/mcp/token-dev',
      headers: mcpHeaders,
      payload: JSON.stringify(initializeRequest),
    });
    expect(response.statusCode).toBe(404);
    expect(h.handler.calls).toEqual([]);
  });

  it('resolves the token on every request, so a revoked token stops working at once', async () => {
    const h = await startServer();
    const client = await connect(h, 'token-dev');
    expect((await call(client, 'list_members')).isError).toBeFalsy();

    h.tokens.delete('token-dev');

    await expect(call(client, 'list_members')).rejects.toMatchObject({ code: 404 });
  });

  it('keeps concurrent sessions apart', async () => {
    const h = await startServer();
    const [dev, qa] = await Promise.all([connect(h, 'token-dev'), connect(h, 'token-qa')]);

    await Promise.all([
      ...Array.from({ length: 5 }, (_, i) => call(dev, 'save_memory', { note: `dev ${i}` })),
      ...Array.from({ length: 5 }, (_, i) => call(qa, 'save_memory', { note: `qa ${i}` })),
    ]);

    expect(h.handler.memory.get('fe-1')?.sort()).toEqual(['dev 0', 'dev 1', 'dev 2', 'dev 3', 'dev 4']);
    expect(h.handler.memory.get('qa')?.sort()).toEqual(['qa 0', 'qa 1', 'qa 2', 'qa 3', 'qa 4']);
  });

  it('answers GET and DELETE with 405 (no server stream, no MCP session)', async () => {
    const h = await startServer();

    const get = await fetch(`${h.baseUrl}/mcp/token-dev`, { headers: { accept: 'text/event-stream' } });
    const del = await fetch(`${h.baseUrl}/mcp/token-dev`, { method: 'DELETE' });
    const unknown = await fetch(`${h.baseUrl}/mcp/nope`, { headers: { accept: 'text/event-stream' } });

    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect(del.status).toBe(405);
    expect(unknown.status).toBe(404);
  });

  it('answers a 2026-07-28 server/discover probe so that clients fall back to initialize', async () => {
    // Claude Code's client may probe with server/discover before the legacy initialize
    // handshake. Any JSON-RPC error except -32022 (unsupported version, with a list of
    // modern versions) makes it fall back to initialize, which this server speaks.
    const h = await startServer();
    const probe = {
      jsonrpc: '2.0',
      id: 0,
      method: 'server/discover',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
    };
    const post = (headers: Record<string, string>) =>
      fetch(`${h.baseUrl}/mcp/token-dev`, { method: 'POST', headers, body: JSON.stringify(probe) });

    const plain = await post(mcpHeaders);
    const versioned = await post({ ...mcpHeaders, 'mcp-protocol-version': '2026-07-28' });

    expect(plain.status).toBe(200);
    expect(await plain.json()).toMatchObject({ id: 0, error: { code: -32601 } });
    expect(versioned.status).toBe(400);
    expect(await versioned.json()).toMatchObject({ error: { code: -32000 } });
  });

  it('answers malformed JSON with a JSON-RPC parse error', async () => {
    const h = await startServer();

    const response = await fetch(`${h.baseUrl}/mcp/token-dev`, {
      method: 'POST',
      headers: mcpHeaders,
      body: '{"jsonrpc": "2.0", ',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: -32700 } });
  });

  it('parses bodies itself, whatever JSON parser the application uses', async () => {
    const h = await startServer({
      configure: (app) => {
        app.removeContentTypeParser('application/json');
        app.addContentTypeParser('application/json', (_request, _payload, done) =>
          done(new Error('the application parser must not run for /mcp'), undefined),
        );
      },
    });
    const client = await connect(h, 'token-dev');

    expect((await call(client, 'get_task', { task_key: 'AR-21' })).isError).toBeFalsy();
  });
});

/* ---------- localhost only ---------- */

describe('localhost enforcement', () => {
  interface InjectOptions {
    remoteAddress?: string;
    headers?: Record<string, string>;
  }

  async function inject(h: Harness, options: InjectOptions) {
    return h.app.inject({
      method: 'POST',
      url: '/mcp/token-dev',
      remoteAddress: options.remoteAddress ?? '127.0.0.1',
      headers: { host: '127.0.0.1:4700', ...mcpHeaders, ...options.headers },
      payload: JSON.stringify(initializeRequest),
    });
  }

  it('accepts local callers', async () => {
    const h = await startServer();

    const local: InjectOptions[] = [
      {},
      { remoteAddress: '::1', headers: { host: '[::1]:4700' } },
      { remoteAddress: '::ffff:127.0.0.1', headers: { host: 'localhost:4700' } },
      { headers: { origin: 'http://localhost:5173' } },
    ];
    for (const options of local) {
      const response = await inject(h, options);
      expect(response.statusCode, JSON.stringify(options)).toBe(200);
      expect(response.json()).toMatchObject({ result: { serverInfo: { name: 'projectman-team' } } });
    }
  });

  it.each([
    ['a non-local address', { remoteAddress: '192.168.1.20' }],
    ['a request relayed by a local proxy', { headers: { 'x-forwarded-for': '100.101.102.103' } }],
    ['a Forwarded header', { headers: { forwarded: 'for=100.101.102.103' } }],
    ['a non-local Host (DNS rebinding)', { headers: { host: 'evil.example:4700' } }],
    ['a Host with user info', { headers: { host: 'evil.example@127.0.0.1' } }],
    ['a foreign Origin', { headers: { origin: 'https://evil.example' } }],
    ['an opaque Origin', { headers: { origin: 'null' } }],
  ])('rejects %s with 403 before the token is resolved', async (_label, options) => {
    const h = await startServer();

    const response = await inject(h, options);

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 } });
    expect(h.resolveCalls).toEqual([]);
    expect(h.handler.calls).toEqual([]);
  });
});
