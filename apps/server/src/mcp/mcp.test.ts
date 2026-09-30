import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolContext } from '../contracts';
import { createMcpModule, TEAM_TOOL_NAMES } from './index';
import { createFakeTeamToolsHandler, devContext, qaContext, type FakeTeamToolsHandler } from './testing';

/* ---------- harness ---------- */

interface Harness {
  app: FastifyInstance;
  baseUrl: string;
  handler: FakeTeamToolsHandler;
  tokens: Map<string, ToolContext>;
  /** Parsed pino log lines of the app. */
  logs: Array<{ level: number; msg: string; [key: string]: unknown }>;
  resolveCalls: string[];
}

const harnesses: Harness[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(harnesses.splice(0).map((h) => h.app.close()));
});

async function startServer(
  options: { toolTimeoutMs?: number; configure?: (app: FastifyInstance) => void } = {},
): Promise<Harness> {
  const logs: Harness['logs'] = [];
  const app = Fastify({
    logger: { level: 'debug', stream: { write: (line: string) => logs.push(JSON.parse(line)) } },
  });
  options.configure?.(app);
  const handler = createFakeTeamToolsHandler();
  const tokens = new Map<string, ToolContext>([
    ['token-dev', devContext],
    ['token-qa', qaContext],
  ]);
  const resolveCalls: string[] = [];
  createMcpModule({
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

const initializeRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
};
const mcpHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

/* ---------- protocol ---------- */

describe('team MCP endpoint', () => {
  it('initializes a client statelessly and sends the team instructions', async () => {
    const h = await startServer();
    const client = await connect(h, 'token-dev');

    expect(client.getServerVersion()?.name).toBe('projectman-team');
    expect(client.getServerCapabilities()?.tools).toBeDefined();
    // The team rules are in every member's system prompt; the instructions only point there.
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('humans and other AI members');
    expect(instructions).toContain('"How the team works"');
    expect(instructions.length).toBeLessThan(300);
  });

  it('keeps tool-specific guidance in the tools and team rules out of them', async () => {
    const h = await startServer();
    const client = await connect(h, 'token-dev');
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, JSON.stringify(t)]));

    // Stated once in the system prompt ("How the team works").
    for (const [name, tool] of byName) {
      expect(tool, name).not.toContain("project's language");
      expect(tool, name).not.toMatch(/be concise/i);
    }
    expect(byName.get('ask_human')).toContain('the answer arrives later in this session as a team message');
    expect(byName.get('ask_human')).toContain('Do not wait or poll for it');
    // Written for a human who is not a specialist: the decision first, the consequences, a
    // recommendation, and the technical reasoning folded away.
    expect(byName.get('ask_human')).toContain('usually not a specialist');
    expect(byName.get('ask_human')).toContain('one plain sentence that names the decision');
    expect(byName.get('ask_human')).toContain('what happens if it is picked');
    expect(byName.get('ask_human')).toContain('always recommend one option with a one-sentence reason');
    expect(byName.get('ask_human')).toContain('Put code, file names and technical reasoning into details');
    expect(byName.get('create_task')).toContain('where humans prioritise it');
    expect(byName.get('create_task')).toContain('note the new key there with update_task');
  });

  it('lists exactly the team tools with strict input schemas', async () => {
    const h = await startServer();
    const client = await connect(h, 'token-dev');
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([...TEAM_TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.description?.length).toBeGreaterThan(80);
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
    const byName = new Map(tools.map((t) => [t.name, t]));
    const schema = (name: string) => byName.get(name)!.inputSchema as Record<string, any>;

    expect(schema('send_message').required).toEqual(['to', 'text']);
    expect(schema('send_message').properties.to.items.pattern).toBe('^[a-z0-9][a-z0-9-]{0,31}$');
    expect(schema('send_message').properties.task_key.pattern).toBe('^[A-Z][A-Z0-9]{0,9}-\\d+$');
    expect(schema('list_members').properties).toEqual({});
    expect(schema('get_task').required).toEqual(['task_key']);
    expect(schema('update_task').required).toEqual(['task_key']);
    expect(schema('update_task').properties.add_labels.items.maxLength).toBe(40);
    expect(schema('update_task').properties.remove_labels.type).toBe('array');
    expect(schema('update_task').properties.check).toBeUndefined();
    expect(schema('update_task').properties.title.maxLength).toBe(200);
    expect(schema('update_task').properties.description.type).toBe('string');
    // A repository name, or null to clear it.
    expect(schema('update_task').properties.repo.anyOf).toEqual([
      { type: 'string', minLength: 1, maxLength: 64 },
      { type: 'null' },
    ]);
    expect(schema('create_task').required).toEqual(['title']);
    expect(schema('create_task').properties.visibility.enum).toEqual(['internal', 'shared']);
    expect(schema('create_task').properties.labels.items.type).toBe('string');
    expect(byName.get('create_task')!.annotations?.readOnlyHint).toBe(false);
    expect(schema('link_pull_request').required).toEqual(['task_key', 'repo', 'number']);
    expect(schema('link_pull_request').properties.number.type).toBe('integer');
    expect(schema('ask_human').required).toEqual(['question']);
    // The plain-language fields are all optional; an option is a label or a label with its consequence.
    expect(Object.keys(schema('ask_human').properties).sort()).toEqual(
      ['details', 'options', 'question', 'recommendation_reason', 'recommended', 'task_key', 'to'].sort(),
    );
    expect(schema('ask_human').properties.options.items.anyOf).toEqual([
      { type: 'string', minLength: 1, maxLength: 200 },
      expect.objectContaining({
        type: 'object',
        required: ['label'],
        additionalProperties: false,
        properties: expect.objectContaining({
          label: expect.objectContaining({ type: 'string' }),
          consequence: expect.objectContaining({ type: 'string' }),
        }),
      }),
    ]);
    expect(schema('ask_human').properties.recommended.type).toBe('string');
    expect(schema('ask_human').properties.recommendation_reason.type).toBe('string');
    expect(schema('ask_human').properties.details.type).toBe('string');
    expect(schema('save_memory').required).toEqual(['note']);
    expect(byName.get('get_task')!.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('list_tasks')!.annotations?.readOnlyHint).toBe(true);
    expect(schema('list_tasks').properties.limit.maximum).toBe(200);
    expect(byName.get('update_task')!.annotations?.readOnlyHint).toBe(false);
  });
});

/* ---------- tools ---------- */

describe('team tools', () => {
  it('send_message passes the caller context and defaults the task to the session task', async () => {
    const h = await startServer();
    const client = await connect(h, 'token-dev');

    const result = await call(client, 'send_message', {
      to: ['cr', 'fe-1', 'cr', 'owner'],
      text: '  Ready for review ✅ — naïve café  ',
    });

    expect(result.isError).toBeFalsy();
    expect(h.handler.calls).toEqual([
      {
        method: 'sendMessage',
        ctx: devContext,
        args: { to: ['cr', 'owner'], text: 'Ready for review ✅ — naïve café', taskKey: 'AR-21' },
      },
    ]);
    expect(text(result)).toBe('Message msg_1 about AR-21 sent to cr, owner.');
  });

  it('send_message refuses a message addressed only to the caller', async () => {
    const h = await startServer();
    const client = await connect(h, 'token-dev');

    const result = await call(client, 'send_message', { to: ['fe-1'], text: 'Note to self' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Error [invalid]: You cannot send a message to yourself');
    expect(h.handler.calls).toEqual([]);
  });

  it('send_message from a session without a task sends a general message unless a task is named', async () => {
    const h = await startServer();
    const client = await connect(h, 'token-qa');

    expect(text(await call(client, 'send_message', { to: ['fe-1'], text: 'Hi' }))).toBe(
      'Message msg_1 sent to fe-1.',
    );
    await call(client, 'send_message', { to: ['fe-1'], text: 'About the login', task_key: 'AR-21' });

    expect(h.handler.calls.map((c) => c.args)).toEqual([
      { to: ['fe-1'], text: 'Hi' },
      { to: ['fe-1'], text: 'About the login', taskKey: 'AR-21' },
    ]);
    expect(h.handler.calls.every((c) => c.ctx === qaContext || c.ctx.member === 'qa')).toBe(true);
  });

  it('list_members returns the roster and marks the caller', async () => {
    const h = await startServer();
    const client = await connect(h, 'token-dev');

    const out = text(await call(client, 'list_members'));

    expect(out).toContain('Team (4 members, address them by handle):');
    expect(out).toContain('- owner — Anna · human owner; roles: operator, product_owner · online');
    expect(out).toContain(
      '- fe-1 (you) — Ben · AI developer (frontend) · working: Bash: npm test · tasks: AR-21',
    );
    expect(out).toContain('- qa — Quinn · AI qa · idle');
    expect(h.handler.calls[0]).toMatchObject({ method: 'listMembers', ctx: devContext });
  });

  it('list_tasks returns compact JSON and passes defaults and filters to the handler', async () => {
    const h = await startServer();
    const client = await connect(h, 'token-dev');
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
    expect(h.handler.calls.at(-1)).toEqual({
      method: 'listTasks',
      ctx: devContext,
      args: { status: 'open', limit: 50 },
    });
    await call(client, 'list_tasks', { status: 'done', stage: 'done', assignee: 'me', limit: 200 });
    expect(h.handler.calls.at(-1)?.args).toEqual({
      status: 'done',
      stage: 'done',
      assignee: 'me',
      limit: 200,
    });
    for (const args of [
      { limit: 201 },
      { limit: 0 },
      { limit: 1.5 },
      { status: 'unknown' },
      { extra: true },
    ]) {
      expect((await call(client, 'list_tasks', args)).isError).toBe(true);
    }
  });

  it('get_task returns the task, its links, sessions and timeline', async () => {
    const h = await startServer();
    const client = await connect(h, 'token-qa');

    const out = text(await call(client, 'get_task', { task_key: 'AR-21' }));

    expect(h.handler.calls[0]).toEqual({ method: 'getTask', ctx: qaContext, args: { taskKey: 'AR-21' } });
    expect(out).toContain('AR-21 — Validate the login form');
    expect(out).toContain('Stage: dev · Status: active · Assignee: fe-1 · Labels: frontend');
    expect(out).toContain('Links: Branch: ar-21-login-validation in web');
    expect(out).toContain('Show an error message when the email address is invalid.');
    expect(out).toContain('Repo: web · Visibility: internal · Priority: 2');
    expect(out).toContain('Sessions: fe-1 (working)');
    expect(out).toContain('- 2026-09-29 09:00 UTC · owner: moved it from ready to dev');
  });

  it('update_task records labels, their note and a stage move in one call', async () => {
    const h = await startServer();
    const client = await connect(h, 'token-dev');

    const result = await call(client, 'update_task', {
      task_key: 'AR-21',
      add_labels: ['code-review-ok'],
      note: 'No findings.',
      stage_id: 'qa',
    });

    expect(result.isError).toBeFalsy();
    expect(h.handler.calls[0]).toEqual({
      method: 'updateTask',
      ctx: devContext,
      args: {
        taskKey: 'AR-21',
        stageId: 'qa',
        addLabels: ['code-review-ok'],
        note: 'No findings.',
      },
    });
    expect(text(result)).toBe(
      'Updated AR-21: labels added: code-review-ok; note added; moved to qa.\n' +
        'Now: Stage: qa · Status: active · Assignee: fe-1 · Labels: frontend, code-review-ok',
    );
  });

  it('update_task without anything to change is refused before reaching the handler', async () => {
    const h = await startServer();
    const client = await connect(h, 'token-dev');

    const result = await call(client, 'update_task', { task_key: 'AR-21' });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      'Error [invalid]: Nothing to update: pass stage_id, add_labels, remove_labels, note, title, description and/or repo.',
    );
    expect(h.handler.calls).toEqual([]);
  });

  it('update_task rewrites the title and the description', async () => {
    const h = await startServer();
    const client = await connect(h, 'token-dev');

    const result = await call(client, 'update_task', {
      task_key: 'AR-21',
      title: '  Validate the login and signup forms ',
      description: '## Goal\nShow an error for an invalid email.\n\n## Acceptance criteria\n1. ...',
    });

    expect(result.isError).toBeFalsy();
    expect(h.handler.calls[0]).toEqual({
      method: 'updateTask',
      ctx: devContext,
      args: {
        taskKey: 'AR-21',
        title: 'Validate the login and signup forms',
        description: '## Goal\nShow an error for an invalid email.\n\n## Acceptance criteria\n1. ...',
      },
    });
    expect(text(result)).toBe(
      'Updated AR-21: title changed; description replaced.\n' +
        'Now: Stage: dev · Status: active · Assignee: fe-1 · Labels: frontend',
    );
    expect(h.handler.tasks.get('AR-21')!.task.title).toBe('Validate the login and signup forms');
    const empty = await call(client, 'update_task', { task_key: 'AR-21', description: '   ' });
    expect(empty.isError).toBe(true);
    expect(text(empty)).toContain('Input validation error');
  });

  it('update_task sets the repository, clears it with null and reports what it did', async () => {
    const h = await startServer();
    const client = await connect(h, 'token-dev');

    const set = await call(client, 'update_task', { task_key: 'AR-21', repo: ' api ' });

    expect(set.isError).toBeFalsy();
    expect(h.handler.calls[0]).toEqual({
      method: 'updateTask',
      ctx: devContext,
      args: { taskKey: 'AR-21', repo: 'api' },
    });
    expect(text(set)).toBe(
      'Updated AR-21: repo set to api.\n' +
        'Now: Stage: dev · Status: active · Assignee: fe-1 · Labels: frontend',
    );
    expect(h.handler.tasks.get('AR-21')!.task.repo).toBe('api');
    expect(h.handler.tasks.get('AR-21')!.timeline.at(-1)).toMatchObject({
      type: 'task_updated',
      data: { fields: ['repo'], repo: 'api', previousRepo: 'web' },
    });

    // null clears the repository and is a change on its own: nothing else has to be passed.
    const cleared = await call(client, 'update_task', { task_key: 'AR-21', repo: null });
    expect(cleared.isError).toBeFalsy();
    expect(h.handler.calls[1]).toMatchObject({ args: { taskKey: 'AR-21', repo: null } });
    expect(text(cleared)).toContain('Updated AR-21: repo cleared.');
    expect(h.handler.tasks.get('AR-21')!.task.repo).toBeNull();
  });

  it('update_task refuses an empty or unknown repository and passes the handler refusal on', async () => {
    const h = await startServer();
    const client = await connect(h, 'token-dev');

    for (const repo of ['', '   ', 'x'.repeat(65), 42]) {
      const result = await call(client, 'update_task', { task_key: 'AR-21', repo });
      expect(result.isError, String(repo)).toBe(true);
      expect(text(result), String(repo)).toContain('Input validation error');
    }
    expect(h.handler.calls).toEqual([]);

    const unknown = await call(client, 'update_task', { task_key: 'AR-21', repo: 'mobile' });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toBe('Error [invalid]: unknown repository: mobile (the project has: web, api)');
    expect(h.handler.tasks.get('AR-21')!.task.repo).toBe('web');
  });

  it('create_task forwards optional parent_key and describes one-level subtasks', async () => {
    const h = await startServer();
    const client = await connect(h, 'token-qa');
    const result = await call(client, 'create_task', { title: 'Example child', parent_key: 'AR-21' });
    expect(result.isError).toBeFalsy();
    expect(h.handler.calls[0]).toMatchObject({
      method: 'createTask',
      args: { title: 'Example child', parentKey: 'AR-21' },
    });
  });

  it('create_task creates an unassigned task in the first stage for humans to prioritise', async () => {
    const h = await startServer();
    const client = await connect(h, 'token-qa');

    const result = await call(client, 'create_task', {
      title: 'Login button overlaps the footer on small screens',
      description: 'Steps to reproduce: open /login at 320 px width.',
      labels: ['bug', 'bug'],
    });

    expect(result.isError).toBeFalsy();
    expect(h.handler.calls[0]).toEqual({
      method: 'createTask',
      ctx: qaContext,
      args: {
        title: 'Login button overlaps the footer on small screens',
        description: 'Steps to reproduce: open /login at 320 px width.',
        labels: ['bug'],
      },
    });
    expect(text(result)).toBe(
      'Created AR-22 "Login button overlaps the footer on small screens" in stage ready, unassigned ' +
        '(visibility internal · Labels: bug).',
    );
    const invalid = await call(client, 'create_task', { title: 'x', visibility: 'public' });
    expect(invalid.isError).toBe(true);
    expect(text(invalid)).toContain('Input validation error');
  });

  it('link_pull_request attaches the PR', async () => {
    const h = await startServer();
    const client = await connect(h, 'token-dev');

    const out = text(
      await call(client, 'link_pull_request', { task_key: 'AR-21', repo: 'acme/web', number: 42 }),
    );

    expect(h.handler.calls[0]?.args).toEqual({ taskKey: 'AR-21', repo: 'acme/web', number: 42 });
    expect(out).toBe('Linked PR acme/web#42 to AR-21.\nPull requests on AR-21: acme/web#42 (open)');
  });

  it('ask_human queues the question and tells the model not to wait', async () => {
    const h = await startServer();
    const client = await connect(h, 'token-dev');

    const out = text(
      await call(client, 'ask_human', {
        question: 'Should the error be shown inline or as a toast?',
        options: ['Inline', 'Toast'],
        recommended: 'Inline',
        recommendation_reason: 'It stays visible until the email is fixed.',
        to: ['owner'],
      }),
    );

    expect(h.handler.calls[0]).toEqual({
      method: 'askHuman',
      ctx: devContext,
      args: {
        question: 'Should the error be shown inline or as a toast?',
        options: ['Inline', 'Toast'],
        recommended: 'Inline',
        recommendationReason: 'It stays visible until the email is fixed.',
        taskKey: 'AR-21',
        to: ['owner'],
      },
    });
    expect(out).toBe('Question inbox_1 is waiting in the inbox of owner.');
  });

  it('ask_human passes options with their consequences, the recommendation and the details on', async () => {
    const h = await startServer();
    const client = await connect(h, 'token-dev');
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
    });

    expect(result.isError).toBeFalsy();
    expect(h.handler.calls).toEqual([
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
        },
      },
    ]);
    expect(text(result)).toBe('Question inbox_1 is waiting in the inbox.');
  });

  it('ask_human refuses a recommendation that is not one of the options, before the handler', async () => {
    const h = await startServer();
    const client = await connect(h, 'token-dev');
    const question = 'Should the error be shown inline or as a toast?';

    const unknown = await call(client, 'ask_human', {
      question,
      options: ['Inline', { label: 'Toast', consequence: 'It disappears.' }],
      recommended: 'Dialog',
    });
    const noOptions = await call(client, 'ask_human', { question, recommended: 'Inline' });
    const reasonOnly = await call(client, 'ask_human', { question, recommendation_reason: 'It is clearer.' });
    const misspelled = await call(client, 'ask_human', {
      question,
      options: [{ label: 'Inline', description: 'It is clearer.' }],
    });

    for (const result of [unknown, noOptions, reasonOnly, misspelled]) {
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('Input validation error');
    }
    expect(text(unknown)).toContain('recommended must be exactly one of the options: "Inline", "Toast".');
    expect(text(noOptions)).toContain('recommended must name one of the options, but there are none');
    expect(text(reasonOnly)).toContain('recommendation_reason needs recommended');
    expect(h.handler.calls).toEqual([]);

    // A recommendation that matches an option goes through, however the option was written.
    for (const recommended of ['Inline', 'Toast']) {
      const ok = await call(client, 'ask_human', {
        question,
        options: ['Inline', { label: 'Toast', consequence: 'It disappears.' }],
        recommended,
        recommendation_reason: 'It is clearer.',
      });
      expect(ok.isError).toBeFalsy();
    }
    expect(h.handler.calls.map((c) => (c.args as { recommended: string }).recommended)).toEqual([
      'Inline',
      'Toast',
    ]);
  });

  it('ask_human keeps every plain-language field optional', async () => {
    const h = await startServer();
    const client = await connect(h, 'token-qa');

    const result = await call(client, 'ask_human', { question: 'Which staging URL should I test?' });

    expect(result.isError).toBeFalsy();
    expect(h.handler.calls[0]).toEqual({
      method: 'askHuman',
      ctx: qaContext,
      args: { question: 'Which staging URL should I test?' },
    });
  });

  describe('ask_human hint', () => {
    const recommendation = {
      options: ['Yes', 'No'],
      recommended: 'Yes',
      recommendation_reason: 'It is the usual choice.',
    };
    const MOVE_DETAIL = 'Consider moving detail into details.';
    const RECOMMEND =
      'Consider adding a recommendation with a one-sentence reason (recommended, recommendation_reason).';
    // The question is already asked; the hint says it is for the next one.
    const TIP = 'Tip for your next question: ';

    it('says nothing about a short question with a recommendation', async () => {
      const h = await startServer();
      const client = await connect(h, 'token-dev');

      const out = text(await call(client, 'ask_human', { question: 'x'.repeat(300), ...recommendation }));

      expect(out).toBe('Question inbox_1 is waiting in the inbox.');
    });

    it('suggests moving detail into details when the question is long, and still asks it', async () => {
      const h = await startServer();
      const client = await connect(h, 'token-dev');

      const result = await call(client, 'ask_human', { question: 'x'.repeat(301), ...recommendation });

      expect(result.isError).toBeFalsy();
      expect(text(result)).toBe(`Question inbox_1 is waiting in the inbox.\n${TIP}${MOVE_DETAIL}`);
      expect(h.handler.calls).toHaveLength(1);
    });

    it('suggests a recommendation when there is none, and still asks the question', async () => {
      const h = await startServer();
      const client = await connect(h, 'token-dev');

      const result = await call(client, 'ask_human', {
        question: 'Should the error be shown inline or as a toast?',
        options: ['Inline', 'Toast'],
        to: ['owner'],
      });

      expect(result.isError).toBeFalsy();
      expect(text(result)).toBe(`Question inbox_1 is waiting in the inbox of owner.\n${TIP}${RECOMMEND}`);
      expect(h.handler.calls).toHaveLength(1);
    });

    it('gives both hints in one line when the question is long and has no recommendation', async () => {
      const h = await startServer();
      const client = await connect(h, 'token-dev');

      const out = text(await call(client, 'ask_human', { question: 'x'.repeat(301) }));

      expect(out).toBe(`Question inbox_1 is waiting in the inbox.\n${TIP}${MOVE_DETAIL} ${RECOMMEND}`);
    });
  });

  it('save_memory appends to the caller memory', async () => {
    const h = await startServer();
    const client = await connect(h, 'token-qa');

    const out = text(await call(client, 'save_memory', { note: 'E2E tests run with npm run e2e.' }));

    expect(out).toContain('Saved to your memory');
    expect(h.handler.memory.get('qa')).toEqual(['E2E tests run with npm run e2e.']);
  });
});

/* ---------- errors ---------- */

describe('tool errors', () => {
  it('rejects invalid arguments without calling the handler', async () => {
    const h = await startServer();
    const client = await connect(h, 'token-dev');

    const badHandle = await call(client, 'send_message', { to: ['@qa'], text: 'hi' });
    const unknownKey = await call(client, 'update_task', { task_key: 'AR-21', comment: 'typo' });
    const missing = await call(client, 'get_task', {});

    for (const result of [badHandle, unknownKey, missing]) {
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('Input validation error');
    }
    expect(text(unknownKey)).toContain('comment');
    expect(h.handler.calls).toEqual([]);
  });

  it('turns TeamToolError into an error result carrying its code', async () => {
    const h = await startServer();
    const client = await connect(h, 'token-dev');

    const blocked = await call(client, 'update_task', { task_key: 'AR-21', stage_id: 'qa' });
    const missing = await call(client, 'get_task', { task_key: 'AR-99' });
    const notHuman = await call(client, 'ask_human', { question: 'Ok?', to: ['qa'] });

    expect(blocked).toMatchObject({ isError: true });
    expect(text(blocked)).toBe('Error [gate_blocked]: Stage "qa" requires the label "code-review-ok".');
    expect(text(missing)).toBe('Error [not_found]: Task AR-99 does not exist.');
    expect(text(notHuman)).toBe('Error [invalid]: Only humans can be asked: qa.');
  });

  it('hides unexpected errors from the model and logs them', async () => {
    const h = await startServer();
    const client = await connect(h, 'token-dev');
    h.handler.failNext('listMembers', new Error('database is locked'));

    const result = await call(client, 'list_members');

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      'Error [internal]: list_members failed because of an internal error. Try again later; if it keeps failing, tell a human.',
    );
    const logged = h.logs.find((l) => l.msg === 'team tool failed');
    expect(logged).toMatchObject({ level: 50, tool: 'list_members', member: 'fe-1', sessionId: 'ses_dev' });
    expect(JSON.stringify(logged)).toContain('database is locked');
  });

  it('answers a handler that does not settle with a timeout error', async () => {
    const h = await startServer({ toolTimeoutMs: 50 });
    const client = await connect(h, 'token-dev');
    h.handler.failNext('getTask', 'hang');

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
    ['a LAN address', { remoteAddress: '192.168.1.20' }],
    ['a tailnet address', { remoteAddress: '100.101.102.103' }],
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
