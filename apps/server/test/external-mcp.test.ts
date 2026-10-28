import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { FIX_ANOTHER_ROUND_OPTION, routes } from '@projectman/shared';
import { ingressRules } from '../../../scripts/cloud/cloudflare';
import type { CloudConfig } from '../../../scripts/cloud/config';
import { DomainError, humanActor } from '../src/kernel';
import { EXTERNAL_DENIED, EXTERNAL_TOOLS } from '../src/mcp/super-operator/registry';
import { TEAM_TOOL_NAMES } from '../src/mcp';
import { addHumanAndLogin, createAppHarness, createProject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

type Mode = 'super' | 'read';

interface ToolResult {
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, any>;
  isError?: boolean;
}

const ACCEPT = 'application/json, text/event-stream';
/** The tools that take no (or an optional) `project_key`. */
const PROJECTLESS_TOOLS = [
  'list_projects',
  'list_integrator_inbox',
  'get_operator_instance_knowledge',
  'update_operator_instance_knowledge',
];

describe('the bearer MCP endpoint (PM-760)', () => {
  let h: AppHarness;
  let cookie: string;
  let now: Date;

  beforeEach(async () => {
    now = new Date('2026-10-18T10:00:00.000Z');
    h = await createAppHarness({ now: () => now, real: { mcp: true } });
    cookie = await setupOwner(h.app);
    await createProject(h, cookie);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.close();
  });

  function key(mode: Mode, expiresInDays: 1 | 7 | 30 = 7) {
    const { auth, repos } = h.app.projectman;
    const user = repos.users.list()[0]!;
    const created = auth.createIntegratorAccessKey(user.id, { mode, expiresInDays });
    return { secret: created.secret, userId: user.id, keyId: created.key.id, prefix: created.key.prefix };
  }

  /** One HTTP request of a client: stateless, so no session header is ever sent or expected. */
  function post(secret: string | null, message: unknown, headers: Record<string, string> = {}) {
    return h.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: ACCEPT,
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        ...headers,
      },
      payload: JSON.stringify(message),
    });
  }

  let nextId = 1;
  const rpc = (method: string, params?: unknown) => ({ jsonrpc: '2.0', id: nextId++, method, params });

  async function listTools(secret: string): Promise<{ name: string; inputSchema: any }[]> {
    const response = await post(secret, rpc('tools/list'));
    expect(response.statusCode, response.body).toBe(200);
    return response.json().result.tools;
  }

  async function call(secret: string, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const response = await post(secret, rpc('tools/call', { name, arguments: args }));
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().error, response.body).toBeUndefined();
    return response.json().result;
  }

  const audit = () => h.app.projectman.repos.superAudit.list('AR', { limit: 100 }).entries;

  it('offers own-todo resolution only to super credentials and resolves it without a relay', async () => {
    const { secret } = key('super');
    expect((await listTools(secret)).map((tool) => tool.name)).toContain('resolve_integrator_todo');
    for (const mode of ['read'] as const)
      expect((await listTools(key(mode).secret)).map((tool) => tool.name)).not.toContain(
        'resolve_integrator_todo',
      );
    const { domain } = h.app.projectman;
    const item = domain.inbox.create({
      projectKey: 'AR',
      kind: 'question',
      source: 'dev-1',
      assignees: ['owner'],
      title: 'Measure',
      payload: {
        question: 'Measure',
        recipient: 'integrator',
        integratorOpenedAt: now.toISOString(),
        screening: {
          until: now.toISOString(),
          outcome: 'todo',
          todo: { what: 'Measure', where: 'Hub', expected: 'Result', recipient: 'integrator' },
        },
      },
      options: [
        { id: 'todo_done', label: 'Done', style: 'primary' },
        { id: 'todo_cannot', label: 'Cannot', style: 'secondary' },
      ],
    });
    const listed = await call(secret, 'list_integrator_inbox', { project_key: 'AR' });
    const text = listed.content[0]!.text!;
    for (const field of ['What: Measure', 'Where: Hub', 'Expected: Result']) expect(text).toContain(field);
    const result = await call(secret, 'resolve_integrator_todo', {
      project_key: 'AR',
      item_id: item.id,
      option_id: 'todo_done',
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.item.resolution).toMatchObject({
      integratorTodo: true,
      via: 'integrator',
    });
    expect(result.structuredContent?.item.resolution.ownerAnswerRelayed).toBeUndefined();
    expect(TEAM_TOOL_NAMES).not.toContain('resolve_integrator_todo');
  });

  /** A held card AR-1 with its fix limit decision item, addressed as the current access decides. */
  async function heldCard() {
    const { domain, repos } = h.app.projectman;
    await domain.tasks.create('AR', { title: 'Login page' }, humanActor('owner'));
    const config = await domain.projects.config('AR');
    const fixLimit = {
      taskKey: 'AR-1',
      rounds: 2,
      limit: 2,
      changeRequests: 2,
      designChangeRequests: 0,
      sendBacks: 0,
      reason: 'passed_on' as const,
      decider: 'lead',
      note: 'Not my call.',
      assessment: {
        recurrence: 'The same test fails again.',
        currentState: 'Half done.',
        recommendation: { optionId: 'another_round' as const, reason: 'Cheap to try.' },
      },
    };
    const item = domain.inbox.createFixLimitDecision(config, {
      projectKey: 'AR',
      taskKey: 'AR-1',
      assignees: ['owner'],
      fixLimit,
      options: [FIX_ANOTHER_ROUND_OPTION],
    });
    repos.taskFixLimits.save({
      taskKey: 'AR-1',
      projectKey: 'AR',
      countedFrom: null,
      extraRounds: 0,
      holdPhase: 'owner',
      heldAt: now.toISOString(),
      decider: null,
      deciders: ['owner'],
      reason: 'passed_on',
      inboxItemId: item.id,
    });
    return item;
  }

  it('lists the fix limit item with its whole text and decides it only through its own tool', async () => {
    const { secret } = key('super');
    const created = await heldCard();
    expect(created.payload.recipient).toBe('integrator');
    for (const name of ['resolve_integrator_fix_limit', 'list_integrator_inbox']) {
      expect(
        (await listTools(secret)).map((tool) => tool.name),
        name,
      ).toContain(name);
      for (const mode of ['read'] as const) {
        expect(
          (await listTools(key(mode).secret)).map((tool) => tool.name),
          name,
        ).not.toContain(name);
        const denied = await call(key(mode).secret, name, {
          project_key: 'AR',
          item_id: 'x',
          option_id: 'x',
        });
        expect(denied.isError, name).toBe(true);
      }
    }
    expect(TEAM_TOOL_NAMES).not.toContain('resolve_integrator_fix_limit');

    const listed = await call(secret, 'list_integrator_inbox', { project_key: 'AR' });
    expect(listed.structuredContent?.items.map((entry: { id: string }) => entry.id)).toEqual([created.id]);
    const text = listed.content[0]!.text!;
    expect(text).toContain(created.id);
    expect(text).toContain('The same test fails again.');
    expect(text).toContain('another_round');

    // Any other item is refused, whatever the integrator calls.
    const other = h.app.projectman.domain.inbox.create({
      projectKey: 'AR',
      kind: 'decision',
      assignees: ['owner'],
      source: 'system',
      title: 'Plain',
      payload: {},
      options: [{ id: 'another_round', label: 'Another', style: 'primary' }],
    });
    const refused = await call(secret, 'resolve_integrator_fix_limit', {
      project_key: 'AR',
      item_id: other.id,
      option_id: 'another_round',
    });
    expect(refused).toMatchObject({ isError: true, structuredContent: { errorCode: 'super_relay_refused' } });
    const noReason = await call(secret, 'resolve_integrator_fix_limit', {
      project_key: 'AR',
      item_id: created.id,
      option_id: 'to_owner',
    });
    expect(noReason.structuredContent?.errorCode).toBe('invalid_request');

    const result = await call(secret, 'resolve_integrator_fix_limit', {
      project_key: 'AR',
      item_id: created.id,
      option_id: 'another_round',
      note: 'One more.',
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.item.resolution).toMatchObject({
      via: 'integrator',
      integratorFixLimit: true,
      optionId: 'another_round',
    });
    expect(h.app.projectman.repos.taskFixLimits.get('AR-1')).toMatchObject({
      holdPhase: null,
      extraRounds: 1,
    });
    const after = await call(secret, 'list_integrator_inbox', { project_key: 'AR' });
    expect(after.structuredContent?.items).toEqual([]);
    expect(after.content[0]!.text).toBe('Nothing is addressed to you.');
    const all = await call(secret, 'list_integrator_inbox', { project_key: 'AR', state: 'all' });
    expect(all.structuredContent?.items.map((entry: { id: string }) => entry.id)).toEqual([created.id]);
    // The member tool of the lead stays a team tool the integrator cannot call.
    const member = await call(secret, 'decide_fix_limit', { project_key: 'AR', task_key: 'AR-1' });
    expect(member.structuredContent?.errorCode).toBe('integrator_not_allowed');
  });

  it('reads and writes the Operator’s instance knowledge with a super key only, and audits the write', async () => {
    const { secret } = key('super');
    const agreement = { summary: 'Ask before risky steps', involvement: 'important', extraCritical: [] };
    const principle = {
      example: 'A failed deploy',
      principle: 'Check the logs first',
      effect: 'Less guessing',
    };
    expect((await call(secret, 'get_operator_instance_knowledge')).structuredContent).toMatchObject({
      revision: 0,
      agreement: null,
      principles: [],
    });

    const written = await call(secret, 'update_operator_instance_knowledge', {
      expected_revision: 0,
      agreement,
      principles: [principle],
    });
    expect(written.isError, written.content[0]!.text).toBeUndefined();
    expect(written.structuredContent).toMatchObject({
      revision: 1,
      agreement: { version: 1, data: agreement },
    });
    const stored = (await call(secret, 'get_operator_instance_knowledge')).structuredContent!;
    expect(stored.principles).toHaveLength(1);
    expect(stored.principles[0]).toMatchObject(principle);
    expect(stored.principles[0].id).toBeTruthy();
    expect(audit().some((entry) => entry.operation === 'mcp_update_operator_instance_knowledge')).toBe(true);

    const stale = await call(secret, 'update_operator_instance_knowledge', {
      expected_revision: 0,
      agreement,
    });
    expect(stale.structuredContent?.errorCode).toBe('operator_knowledge_stale');

    const { secret: other } = key('read');
    const denied = await call(other, 'update_operator_instance_knowledge', {
      expected_revision: 1,
      agreement,
    });
    expect(denied.structuredContent?.errorCode).toBe('integrator_read_only');
    expect((await call(other, 'get_operator_instance_knowledge')).isError).toBe(true);
  });

  it('lists the integrator inbox of every owned project without project_key and leaves out one it does not own', async () => {
    const { secret } = key('super');
    await createProject(h, cookie, 'BR');
    await createProject(h, cookie, 'CR');
    // The key's holder stops being an owner of CR: another owner takes over in the same commit.
    await addHumanAndLogin(h.app, {
      handle: 'boss',
      access: 'owner',
      projectKey: 'CR',
      adjust: (draft) => {
        for (const member of draft.team.members)
          if (member.kind === 'human' && member.handle === 'owner') member.access = 'developer';
      },
    });
    const { domain } = h.app.projectman;
    const todo = (projectKey: string, title: string) =>
      domain.inbox.create({
        projectKey,
        kind: 'question',
        source: 'dev-1',
        assignees: ['owner'],
        title,
        payload: {
          question: title,
          recipient: 'integrator',
          integratorOpenedAt: now.toISOString(),
          screening: {
            until: now.toISOString(),
            outcome: 'todo',
            todo: { what: title, where: 'Hub', expected: 'Result', recipient: 'integrator' },
          },
        },
        options: [
          { id: 'todo_done', label: 'Done', style: 'primary' },
          { id: 'todo_cannot', label: 'Cannot', style: 'secondary' },
        ],
      });
    const inAr = todo('AR', 'First todo');
    now = new Date(now.getTime() + 1000);
    const inBr = todo('BR', 'Second todo');
    todo('CR', 'Foreign todo');

    const all = await call(secret, 'list_integrator_inbox');
    expect(all.isError, all.content[0]!.text).toBeUndefined();
    expect(
      all.structuredContent?.items.map((entry: { id: string; projectKey: string }) => [
        entry.projectKey,
        entry.id,
      ]),
    ).toEqual([
      ['BR', inBr.id],
      ['AR', inAr.id],
    ]);
    const only = await call(secret, 'list_integrator_inbox', { project_key: 'AR' });
    expect(only.structuredContent?.items.map((entry: { id: string }) => entry.id)).toEqual([inAr.id]);
  });

  it('initializes, lists, reads and writes with no session and no engine', async () => {
    const { secret } = key('super');
    const initialized = await post(
      secret,
      rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'fake-integrator', version: '1' },
      }),
    );
    expect(initialized.statusCode, initialized.body).toBe(200);
    expect(initialized.json().result.serverInfo.name).toBe('projectman-team');
    expect(initialized.headers['mcp-session-id']).toBeUndefined();
    const notification = await post(secret, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(notification.statusCode).toBe(202);

    const names = (await listTools(secret)).map((tool) => tool.name);
    expect(names).toContain('list_projects');
    expect(names).toContain('create_task');

    const projects = await call(secret, 'list_projects');
    expect(projects.structuredContent).toEqual({ projects: [{ key: 'AR', name: 'acme' }] });

    const created = await call(secret, 'create_task', {
      project_key: 'AR',
      title: 'Over MCP',
    });
    expect(created.isError).toBeUndefined();
    const task = h.app.projectman.domain.tasks.list('AR').find((entry) => entry.title === 'Over MCP');
    expect(task).toBeDefined();

    const listed = await call(secret, 'list_tasks', { project_key: 'AR' });
    expect(listed.content[0]!.text).toContain('Over MCP');
    const detail = await call(secret, 'get_task', { project_key: 'AR', task_key: task!.key });
    expect(detail.content[0]!.text).toContain('Over MCP');
  });

  it('refuses GET and DELETE with 405 and Allow: POST, and a missing or wrong credential with 401', async () => {
    const { secret } = key('super');
    for (const method of ['GET', 'DELETE'] as const) {
      const response = await h.app.inject({
        method,
        url: '/mcp',
        headers: { authorization: `Bearer ${secret}` },
      });
      expect(response.statusCode, method).toBe(405);
      expect(response.headers.allow).toBe('POST');
    }
    for (const headers of [
      {} as Record<string, string>,
      { authorization: 'Bearer pmi_unknown' },
      { authorization: 'Bearer notakey' },
      { authorization: `Basic ${secret}` },
    ]) {
      const response = await post(null, rpc('tools/list'), headers);
      expect(response.statusCode, JSON.stringify(headers)).toBe(401);
      expect(response.json().error.code).toBe('integrator_key_invalid');
      expect(response.body).not.toContain(secret);
    }
    // A bad token is never the member door's 404, which would make an MCP client start an OAuth flow.
    const bad = await post('pmi_unknown', rpc('tools/list'));
    expect(bad.statusCode).toBe(401);
  });

  it('does not take the login cookie for a credential, and lets the bearer decide in a mixed request', async () => {
    const { secret } = key('read');
    const cookieOnly = await post(null, rpc('tools/list'), { cookie });
    expect(cookieOnly.statusCode).toBe(401);
    expect(cookieOnly.json().error.code).toBe('integrator_key_invalid');
    // The owner's cookie does not rescue a wrong bearer, and does not widen a right one.
    const wrongBearer = await post('pmi_unknown', rpc('tools/list'), { cookie });
    expect(wrongBearer.statusCode).toBe(401);
    const mixed = await post(secret, rpc('tools/list'), { cookie });
    expect(mixed.statusCode).toBe(200);
    const names = mixed.json().result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain('list_tasks');
    expect(names).not.toContain('create_task');
    const refused = await post(
      secret,
      rpc('tools/call', { name: 'create_task', arguments: { project_key: 'AR', title: 'Nope' } }),
      { cookie },
    );
    expect(refused.json().result.structuredContent.errorCode).toBe('integrator_read_only');
    expect(h.app.projectman.domain.tasks.list('AR').map((t) => t.title)).not.toContain('Nope');
  });

  it('authenticates every request afresh: expiry and revoke between two requests take effect at once', async () => {
    const expiring = key('super', 1);
    expect((await post(expiring.secret, rpc('tools/list'))).statusCode).toBe(200);
    now = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
    const expired = await post(expiring.secret, rpc('tools/list'));
    expect(expired.statusCode).toBe(401);
    expect(expired.json().error.code).toBe('integrator_key_invalid');

    const revocable = key('super');
    expect((await post(revocable.secret, rpc('tools/list'))).statusCode).toBe(200);
    h.app.projectman.auth.revokeIntegratorAccessKey(revocable.userId, revocable.keyId);
    const revoked = await post(revocable.secret, rpc('tools/call', { name: 'list_projects', arguments: {} }));
    expect(revoked.statusCode).toBe(401);
    expect(revoked.json().error.code).toBe('integrator_key_invalid');
  });

  it('authenticates notifications and batches, and turns a key revoked during a request into a 401', async () => {
    const { secret } = key('super');
    const notification = await post('pmi_unknown', { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(notification.statusCode).toBe(401);
    const batch = await post(secret, [
      rpc('tools/call', { name: 'list_projects', arguments: {} }),
      rpc('tools/call', { name: 'list_tasks', arguments: { project_key: 'AR' } }),
    ]);
    expect(batch.statusCode, batch.body).toBe(200);
    expect(batch.json()).toHaveLength(2);

    // The key is found revoked after the request was admitted: still a 401, not a 200 with an error text.
    const { auth } = h.app.projectman;
    const original = auth.assertActive.bind(auth);
    let checks = 0;
    vi.spyOn(auth, 'assertActive').mockImplementation((principal) => {
      if (++checks > 1)
        throw new DomainError('integrator_key_invalid', 'Integrator key is invalid, revoked or expired', {
          status: 401,
        });
      original(principal);
    });
    const midway = await post(secret, [
      rpc('tools/call', { name: 'list_projects', arguments: {} }),
      rpc('tools/call', { name: 'list_projects', arguments: {} }),
    ]);
    expect(midway.statusCode, midway.body).toBe(401);
    expect(midway.json().error.code).toBe('integrator_key_invalid');
  });

  it('lists only the tools of the credential mode, and refuses a forbidden one called directly', async () => {
    const superTools = (await listTools(key('super').secret)).map((tool) => tool.name);
    const readTools = (await listTools(key('read').secret)).map((tool) => tool.name);
    const superOnly = [
      'list_super_handoffs',
      'execute_super_handoff',
      'super_operate',
      'get_super_operation',
      'query_super_diagnostics',
      'get_administration_status',
      'get_administration_logs',
      'get_machine_snapshot',
      'relay_owner_answer',
      'resolve_integrator_todo',
      'resolve_integrator_fix_limit',
      'list_integrator_inbox',
      'get_operator_instance_knowledge',
      'update_operator_instance_knowledge',
    ];
    for (const name of superOnly) {
      expect(superTools, name).toContain(name);
      expect(readTools, name).not.toContain(name);
    }
    for (const mode of [readTools]) expect(mode).toContain('list_projects');
    expect(readTools).toContain('list_tasks');
    expect(readTools).not.toContain('create_task');
    expect(readTools).not.toContain('send_message');
    // Nothing of the member's session, decision or file tools is offered to anybody.
    for (const name of ['attach_file', 'merge_task', 'hand_off', 'operate', 'save_memory'])
      for (const tools of [superTools, readTools]) expect(tools, name).not.toContain(name);
    // The Operator's tools the super mode got (PM-784): readers also in the read mode, writers super only,
    const superWriters = [
      'write_project_docs',
      'propose_release',
      'request_structural_review',
      'ask_human',
      'withdraw_question',
    ];
    const superReaders = [
      'read_project_doc',
      'get_role_configuration',
      'read_attachment',
      'get_super_question',
      'get_project_doc_write',
    ];
    for (const name of superWriters) {
      expect(superTools, name).toContain(name);
      expect(readTools, name).not.toContain(name);
    }
    for (const name of superReaders) {
      expect(superTools, name).toContain(name);
      expect(readTools, name).toContain(name);
    }

    const read = key('read').secret;
    const superKey = key('super').secret;
    const readWrite = await call(read, 'create_task', { project_key: 'AR', title: 'No' });
    expect(readWrite).toMatchObject({
      isError: true,
      structuredContent: { errorCode: 'integrator_read_only' },
    });
    expect(
      (await call(read, 'list_super_handoffs', { project_key: 'AR' })).structuredContent?.errorCode,
    ).toBe('integrator_not_allowed');
    for (const name of ['attach_file', 'merge_task', 'operate']) {
      const denied = await call(superKey, name, { project_key: 'AR' });
      expect(denied.isError, name).toBe(true);
      expect(denied.structuredContent?.errorCode, name).toBe('integrator_not_allowed');
    }
    for (const name of superWriters) {
      const denied = await call(read, name, { project_key: 'AR' });
      expect(denied.structuredContent?.errorCode, name).toMatch(
        /integrator_not_allowed|integrator_read_only/,
      );
    }
    const unknown = await call(superKey, 'no_such_tool', {});
    expect(unknown.structuredContent?.errorCode).toBe('not_found');
    expect(h.app.projectman.domain.tasks.list('AR').map((t) => t.title)).not.toContain('No');
  });

  it('requires project_key on every project tool and validates the arguments', async () => {
    const { secret } = key('super');
    const tools = await listTools(secret);
    for (const tool of tools) {
      if (PROJECTLESS_TOOLS.includes(tool.name)) {
        expect(tool.inputSchema.required ?? [], tool.name).not.toContain('project_key');
        continue;
      }
      expect(tool.inputSchema.required, tool.name).toContain('project_key');
      expect(Object.keys(tool.inputSchema.properties), tool.name).not.toContain('session_id');
    }
    for (const args of [{}, { project_key: 'ar' }, { project_key: 'AR', surprise: 1 }]) {
      const refused = await call(secret, 'list_tasks', args);
      expect(refused.structuredContent?.errorCode, JSON.stringify(args)).toBe('invalid_request');
    }
  });

  it('does not offer the places of a message to the integrator', async () => {
    const send = (await listTools(key('super').secret)).find((tool) => tool.name === 'send_message');
    expect(send).toBeDefined();
    expect(Object.keys(send!.inputSchema.properties)).not.toContain('places');
  });

  it('keeps projects apart: only the current owner projects, and no tell between unknown and foreign ones', async () => {
    const workspace = join(h.home, 'other-project');
    mkdirSync(workspace);
    const created = await h.app.inject({
      method: 'POST',
      url: routes.projects(),
      headers: { cookie },
      payload: {
        key: 'BR',
        name: 'Other project',
        workspacePath: workspace,
        templateId: 'test',
        repos: [{ name: 'web', path: '.', github: 'acme/web' }],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const { secret } = key('super');
    const both = await call(secret, 'list_projects');
    expect(both.structuredContent?.projects.map((p: { key: string }) => p.key).sort()).toEqual(['AR', 'BR']);
    const task = await call(secret, 'create_task', { project_key: 'BR', title: 'In BR' });
    expect(task.isError).toBeUndefined();
    expect(h.app.projectman.domain.tasks.list('BR').map((t) => t.title)).toContain('In BR');
    expect(h.app.projectman.domain.tasks.list('AR').map((t) => t.title)).not.toContain('In BR');
    const creates = h.app.projectman.repos.superAudit
      .list('BR', { limit: 100 })
      .entries.map((e) => e.operation)
      .filter((operation) => operation === 'mcp_create_task');
    expect(creates.length).toBeGreaterThan(0);

    await h.app.projectman.domain.projects.update(
      'BR',
      { actor: { kind: 'human', handle: 'owner' }, author: { name: 'Owner', email: 'owner@example.com' } },
      (draft) => {
        const owner = draft.team.members.find((m) => m.handle === 'owner')!;
        if (owner.kind === 'human') owner.access = 'admin';
        draft.team.members.push({
          kind: 'human',
          handle: 'other-owner',
          displayName: 'Other owner',
          access: 'owner',
          roles: [],
          email: 'other@example.invalid',
        });
        return 'Transfer project ownership';
      },
    );
    expect((await call(secret, 'list_projects')).structuredContent).toEqual({
      projects: [{ key: 'AR', name: 'acme' }],
    });
    const foreign = await call(secret, 'list_tasks', { project_key: 'BR' });
    const unknown = await call(secret, 'list_tasks', { project_key: 'ZZ' });
    expect(foreign.structuredContent?.errorCode).toBe('insufficient_access');
    expect(unknown.structuredContent?.errorCode).toBe('insufficient_access');
    expect(foreign.structuredContent?.message.replace('BR', 'XX')).toBe(
      unknown.structuredContent?.message.replace('ZZ', 'XX'),
    );
    const write = await call(secret, 'create_task', { project_key: 'BR', title: 'Not any more' });
    expect(write.structuredContent?.errorCode).toBe('insufficient_access');
    expect(h.app.projectman.domain.tasks.list('BR').map((t) => t.title)).not.toContain('Not any more');
    // The refused calls left no audit row in the project the holder no longer owns.
    const operations = h.app.projectman.repos.superAudit
      .list('BR', { limit: 100 })
      .entries.map((e) => e.operation);
    expect(operations).not.toContain('mcp_list_tasks');
    expect(operations.filter((operation) => operation === 'mcp_create_task')).toEqual(creates);
  });

  it('audits a super key and a read key by their prefix', async () => {
    expect(audit().filter((e) => e.operation.startsWith('mcp_'))).toEqual([]);
    const readKey = key('read');
    await call(readKey.secret, 'list_tasks', { project_key: 'AR' });
    const readEntries = audit().filter((e) => e.operation.startsWith('mcp_'));
    expect(readEntries.map((e) => e.operation)).toContain('mcp_list_tasks');
    expect(new Set(readEntries.map((e) => e.prefix))).toEqual(new Set([readKey.prefix]));
    expect(JSON.stringify(readEntries)).not.toContain(readKey.secret);
    const superKey = key('super');
    await call(superKey.secret, 'create_task', { project_key: 'AR', title: 'Audited' });
    await call(superKey.secret, 'list_tasks', { project_key: 'AR' });
    const entries = audit().filter((e) => e.operation.startsWith('mcp_'));
    expect(entries.map((e) => e.operation)).toEqual(
      expect.arrayContaining(['mcp_create_task', 'mcp_list_tasks']),
    );
    expect(JSON.stringify(entries)).not.toContain(superKey.secret);
  });

  it('answers a super tool with structured JSON and keeps the domain error code', async () => {
    const { secret } = key('super');
    const handoffs = await call(secret, 'list_super_handoffs', { project_key: 'AR' });
    expect(handoffs.structuredContent).toEqual({ handoffs: [] });
    expect(JSON.parse(handoffs.content[0]!.text!)).toEqual({ handoffs: [] });
    const missing = await call(secret, 'get_super_operation', {
      project_key: 'AR',
      operation_id: 'sop_missing',
    });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent?.errorCode).toEqual(expect.any(String));
    expect(missing.structuredContent?.errorCode).not.toBe('internal_error');
    const relay = await call(secret, 'relay_owner_answer', {
      project_key: 'AR',
      item_id: 'inb_missing',
      answer: 'yes',
    });
    expect(relay.isError).toBe(true);
    expect(relay.structuredContent?.errorCode).toBe('not_found');
  });

  describe('a step on a queue item (decision 66)', () => {
    const createItem = (source: string, assignees: string[]) =>
      h.app.projectman.domain.inbox.create({
        projectKey: 'AR',
        kind: 'question',
        source,
        assignees,
        title: 'Fictional queue item',
        payload: {
          question: 'Fictional',
          recipient: 'integrator',
          integratorOpenedAt: now.toISOString(),
          screening: {
            until: now.toISOString(),
            outcome: 'todo',
            todo: { what: 'Fictional', where: 'Hub', expected: 'Result', recipient: 'integrator' },
          },
        },
        options: [
          { id: 'todo_done', label: 'Done', style: 'primary' },
          { id: 'todo_cannot', label: 'Cannot', style: 'secondary' },
        ],
      });
    const operate = (secret: string, queueItemId: string) =>
      call(secret, 'super_operate', {
        project_key: 'AR',
        request_id: randomUUID(),
        queue_item_id: queueItemId,
        command: { kind: 'operate', operation: { op: 'message_send', to: ['dev-2'], text: 'Fictional' } },
      });

    it('refuses an item that is not open for the key’s holder', async () => {
      const item = createItem('dev-1', ['dev-1']);
      const result = await operate(key('super').secret, item.id);
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.errorCode).toBe('queue_item_not_yours');
    });

    it('refuses an item whose issuer has no machine access', async () => {
      const item = createItem('ghost', ['owner']);
      const result = await operate(key('super').secret, item.id);
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.errorCode).toBe('issuer_without_machine_access');
    });

    describe('with an issuer that has machine access', () => {
      const grantMachineAccess = () =>
        h.app.projectman.domain.projects.update(
          'AR',
          { actor: humanActor('owner'), author: { name: 'Owner', email: 'owner@example.com' } },
          (draft) => {
            const issuer = draft.team.members.find((m) => m.handle === 'dev-1');
            if (issuer?.kind === 'ai') issuer.machineAccess = true;
            draft.pipeline.labels.push({
              id: 'owner-tag',
              name: 'Owner tag',
              setBy: { members: ['owner'] },
            });
            return 'Grant machine access and add an owner label';
          },
        );
      const runCommand = (secret: string, queueItemId: string | undefined, command: unknown) =>
        call(secret, 'super_operate', {
          project_key: 'AR',
          request_id: randomUUID(),
          ...(queueItemId ? { queue_item_id: queueItemId } : {}),
          command,
        });

      it('records the step under the issuer’s name with the holder behind it', async () => {
        await grantMachineAccess();
        const { secret, keyId, prefix } = key('super');
        const item = createItem('dev-1', ['owner']);
        const result = await operate(secret, item.id);
        expect(result.structuredContent?.operation.state).toBe('succeeded');
        const sent = h.app.projectman.repos.messages
          .list('AR')
          .find((m) => m.to.includes('dev-2') && m.body.includes('Fictional'));
        expect(sent?.from).toBe('dev-1');
        expect(sent?.actor).toEqual({
          kind: 'ai',
          handle: 'dev-1',
          via: 'integrator',
          through: { holder: 'owner', credential: { id: keyId, prefix } },
        });
      });

      it.each([
        [
          'inbox_resolve',
          (itemId: string) => ({ kind: 'inbox_resolve', itemId, request: { optionId: 'todo_done' } }),
        ],
        ['merge', () => ({ kind: 'merge', taskKey: 'AR-1', request: {} })],
        [
          'workspace_release',
          () => ({ kind: 'workspace_release', scopeId: 'fictional', reason: 'Fictional' }),
        ],
      ])('refuses %s, which needs the owner’s own request', async (_kind, command) => {
        await grantMachineAccess();
        const item = createItem('dev-1', ['owner']);
        const result = await runCommand(key('super').secret, item.id, command(item.id));
        expect(result.isError).toBe(true);
        expect(result.structuredContent?.errorCode).toBe('operator_owner_only');
      });

      it.each([
        ['owner-tag', 'label_not_allowed'],
        ['merge-ok', 'owner_approval_required'],
      ])(
        'lends no owner authority to the label %s, which a direct instruction does hold',
        async (labelId, refusal) => {
          await grantMachineAccess();
          const { secret } = key('super');
          await call(secret, 'create_task', { project_key: 'AR', title: 'Fictional card' });
          const taskKey = h.app.projectman.domain.tasks
            .list('AR')
            .find((entry) => entry.title === 'Fictional card')!.key;
          const item = createItem('dev-1', ['owner']);
          const labelsOf = () => h.app.projectman.domain.tasks.get('AR', taskKey).labels;
          const label = (queueItemId?: string) =>
            runCommand(secret, queueItemId, {
              kind: 'task_labels',
              taskKey,
              request: { add: [labelId], remove: [] },
            });

          const onQueueItem = await label(item.id);
          expect(onQueueItem.structuredContent?.operation).toMatchObject({
            state: 'failed',
            errorCode: refusal,
          });
          expect(labelsOf()).not.toContain(labelId);

          const direct = await label();
          expect(direct.structuredContent?.operation.state).toBe('succeeded');
          expect(labelsOf()).toContain(labelId);
        },
      );
    });
  });

  describe('behind the Cloudflare Access front and the tunnel', () => {
    const front = {
      host: 'board.example.com',
      'x-forwarded-proto': 'https',
      'cf-connecting-ip': '203.0.113.7',
      'cf-access-jwt-assertion': 'fake.access.jwt',
      'cf-access-authenticated-user-email': 'owner@example.com',
    };

    it('takes the bearer behind HTTPS, and the Access identity headers are no credential', async () => {
      const { secret } = key('super');
      const through = await post(secret, rpc('tools/call', { name: 'list_projects', arguments: {} }), front);
      expect(through.statusCode, through.body).toBe(200);
      expect(through.json().result.structuredContent.projects).toEqual([{ key: 'AR', name: 'acme' }]);
      const identityOnly = await post(null, rpc('tools/list'), front);
      expect(identityOnly.statusCode).toBe(401);
      expect(identityOnly.json().error.code).toBe('integrator_key_invalid');
      const plain = await post(secret, rpc('tools/list'), { ...front, 'x-forwarded-proto': 'http' });
      expect(plain.statusCode).toBe(401);
      expect(plain.json().error.code).toBe('integrator_https_required');
      const spoofed = await h.app.inject({
        method: 'POST',
        url: '/mcp',
        remoteAddress: '203.0.113.9',
        headers: {
          ...front,
          authorization: `Bearer ${secret}`,
          'content-type': 'application/json',
          accept: ACCEPT,
        },
        payload: JSON.stringify(rpc('tools/list')),
      });
      expect(spoofed.statusCode).toBe(401);
      expect(spoofed.json().error.code).toBe('integrator_https_required');
    });

    function reaches(config: Pick<CloudConfig, 'access'>, path: string): string {
      const rules = ingressRules(
        { ...config, cloudflare: { hostname: 'board.example.com' } } as unknown as CloudConfig,
        'team',
        { app: 'board-aud', engine: 'engine-aud', integrator: null },
      ) as { hostname?: string; path?: string; service: string }[];
      const rule = rules.find(
        (r) =>
          (!r.hostname || r.hostname === 'board.example.com') && (!r.path || new RegExp(r.path).test(path)),
      );
      return rule!.service;
    }

    it.each(['private', 'public'] as const)(
      'keeps legacy private MCP access and closes the public board MCP door (%s board)',
      (boardMode) => {
        const config = { access: { boardMode } } as unknown as Pick<CloudConfig, 'access'>;
        expect(reaches(config, '/mcp')).toBe(
          boardMode === 'private' ? 'http://127.0.0.1:4700' : 'http_status:404',
        );
        for (const path of [
          '/mcp/',
          '/mcp/token',
          '/mcp/token/x',
          '/hooks',
          '/hooks/token',
          '/hooks/token/Stop',
        ])
          expect(reaches(config, path), path).toBe('http_status:404');
      },
    );

    it('answers 404 to a spelling that the tunnel rule does not catch, and opens no member door to a bearer', async () => {
      const { secret } = key('super');
      for (const url of ['/%6dcp/token', '/%68ooks/token']) {
        const response = await h.app.inject({
          method: 'POST',
          url,
          headers: { ...front, authorization: `Bearer ${secret}` },
        });
        expect(response.statusCode, url).toBe(404);
        expect(response.json().error.code, url).toBe('not_found');
      }
      // The member door neither takes the integrator's bearer nor a remote caller.
      const member = await h.app.inject({
        method: 'POST',
        url: '/mcp/token',
        headers: {
          ...front,
          authorization: `Bearer ${secret}`,
          'content-type': 'application/json',
          accept: ACCEPT,
        },
        payload: JSON.stringify(rpc('tools/list')),
      });
      expect(member.statusCode).toBe(403);
    });
  });
});

describe('the external tool registry (PM-760)', () => {
  it('denies every shared tool that has no binding, and names no tool both bound and denied', () => {
    const bound = new Set(EXTERNAL_TOOLS.map((tool) => tool.name));
    for (const name of TEAM_TOOL_NAMES) {
      const denied = name in EXTERNAL_DENIED;
      expect(bound.has(name) && denied, `${name} is both bound and denied`).toBe(false);
      expect(bound.has(name) || denied, `${name} is neither bound nor denied`).toBe(true);
    }
    for (const name of Object.keys(EXTERNAL_DENIED))
      expect(TEAM_TOOL_NAMES as readonly string[], name).toContain(name);
  });

  it('serves each tool under one name', () => {
    const names = EXTERNAL_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
