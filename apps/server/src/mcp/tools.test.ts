import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createTeamMcpServer, DEFAULT_TOOL_TIMEOUT_MS, SERVER_INFO, visibleTeamTools } from './server';
import { createFakeTeamToolsHandler, devContext, fullAudience } from './testing';
import type { MemberAudience } from '../contracts';
import { toolVisible, type ToolAudience } from './kit';
import { TEAM_TOOL_GROUPS, TEAM_TOOL_NAMES, TEAM_TOOLS } from './tools';
import { AI_BUILT_IN_ROLE_IDS, BUILT_IN_ROLE_DUTIES } from '@projectman/shared';

/** A description says what the tool does and when; the rules behind it live in the guides (PM-1114). */
const TOOL_DESCRIPTION_MAX = 300;

const developerAudience: MemberAudience = {
  projectManager: false,
  merger: false,
  email: false,
  machineAccess: false,
  hostRequests: false,
  duties: new Set(),
};

async function listToolsFor(audience: MemberAudience) {
  const app = Fastify();
  const server = createTeamMcpServer(devContext, {
    handler: createFakeTeamToolsHandler(),
    logger: app.log,
    toolTimeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
    audienceOf: () => audience,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'audience-test', version: '1.0.0' });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await client.listTools();
  } finally {
    await client.close();
    await server.close();
    await app.close();
  }
}

describe('tool audience', () => {
  it.each(AI_BUILT_IN_ROLE_IDS)('keeps the %s tools/list within its byte budget', async (role) => {
    const result = await listToolsFor({
      ...developerAudience,
      projectManager: role === 'project_manager',
      merger: role === 'developer',
      duties: new Set(BUILT_IN_ROLE_DUTIES[role]),
    });
    const bytes = Buffer.byteLength(JSON.stringify(result));
    const budgets = {
      project_manager: 108_000,
      business_analyst: 40_000,
      architect: 40_000,
      designer: 40_000,
      developer: 42_000,
      lead_developer: 42_000,
      code_review: 40_000,
      security_review: 40_000,
      qa: 40_000,
      devops: 45_000,
      communication: 40_000,
      support: 40_000,
      researcher: 40_000,
      maintainer: 40_000,
      coach: 40_000,
      watchdog: 40_000,
      content: 40_000,
      translator: 40_000,
      docs: 40_000,
    };
    expect(bytes).toBeLessThanOrEqual(budgets[role]);
  });
  it.each([fullAudience, developerAudience, { ...developerAudience, projectManager: true }])(
    'registers exactly the tools listed by the context preview for %o',
    async (audience) => {
      const result = await listToolsFor(audience);
      expect(result.tools.map(({ name, title, description }) => ({ name, title, description }))).toEqual(
        visibleTeamTools(audience),
      );
    },
  );
  // The memoized listing replaces the SDK's own; the SDK registration of the same tools is what it must equal.
  it.each([fullAudience, developerAudience])(
    'lists the tools exactly as the SDK would, also from the memo (%#)',
    async (audience) => {
      const reference = new McpServer(SERVER_INFO);
      const visible = new Set(visibleTeamTools(audience).map((tool) => tool.name));
      for (const tool of TEAM_TOOLS.filter((candidate) => visible.has(candidate.name)))
        reference.registerTool(
          tool.name,
          {
            title: tool.title,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: tool.annotations,
          },
          () => ({ content: [] }),
        );
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'reference-test', version: '1.0.0' });
      await reference.connect(serverTransport);
      await client.connect(clientTransport);
      const fields = ({ name, title, description, inputSchema, annotations }: Tool) => ({
        name,
        title,
        description,
        inputSchema,
        annotations,
      });
      const expected = (await client.listTools()).tools.map(fields);
      await client.close();
      await reference.close();
      expect((await listToolsFor(audience)).tools.map(fields)).toEqual(expected);
      expect((await listToolsFor(audience)).tools.map(fields)).toEqual(expected);
    },
  );
  it.each<{ audience: ToolAudience | undefined; member: MemberAudience; visible: boolean }>([
    { audience: undefined, member: developerAudience, visible: true },
    { audience: {}, member: developerAudience, visible: false },
    { audience: { roles: [] }, member: fullAudience, visible: false },
    {
      audience: { roles: ['project_manager'] },
      member: { ...developerAudience, projectManager: true },
      visible: true,
    },
    { audience: { roles: ['merger'] }, member: { ...developerAudience, merger: true }, visible: true },
    { audience: { duties: ['deployment'] }, member: developerAudience, visible: false },
    { audience: { channels: ['email'] }, member: developerAudience, visible: false },
    { audience: { channels: ['email'] }, member: { ...developerAudience, email: true }, visible: true },
    {
      audience: { duties: ['deployment', 'code_review'] },
      member: { ...developerAudience, duties: new Set(['code_review']) },
      visible: true,
    },
    {
      audience: { roles: ['merger'], duties: ['deployment'] },
      member: { ...developerAudience, duties: new Set(['deployment']) },
      visible: true,
    },
    {
      audience: { roles: ['project_manager'], duties: ['deployment'] },
      member: { ...developerAudience, projectManager: true },
      visible: true,
    },
  ])('resolves audience $audience with member $member to $visible', ({ audience, member, visible }) => {
    expect(toolVisible(audience, member)).toBe(visible);
  });

  it('lists every tool for a full audience and hides restricted tools from a developer', async () => {
    const before = await listToolsFor(fullAudience);
    const after = await listToolsFor(developerAudience);
    expect(before.tools.map((tool) => tool.name).sort()).toEqual([...TEAM_TOOL_NAMES].sort());
    expect(after.tools.map((tool) => tool.name)).not.toContain('operate');
    expect(after.tools.map((tool) => tool.name)).toContain('get_guide');
    console.info('tools/list JSON bytes', {
      before: Buffer.byteLength(JSON.stringify(before)),
      after: Buffer.byteLength(JSON.stringify(after)),
      beforeCount: before.tools.length,
      afterCount: after.tools.length,
      afterDescriptionChars: after.tools.reduce((sum, tool) => sum + (tool.description?.length ?? 0), 0),
    });
  });

  it.each([false, true])(
    'lists the machine todo tool only with machine access (%s)',
    async (machineAccess) => {
      const result = await listToolsFor({ ...developerAudience, machineAccess });
      expect(result.tools.some((tool) => tool.name === 'open_integrator_todo')).toBe(machineAccess);
    },
  );

  it.each([false, true])(
    'lists the requests-to-the-host tools only for a project manager who may ask (%s)',
    async (hostRequests) => {
      const result = await listToolsFor({ ...developerAudience, hostRequests });
      const names = result.tools.map((tool) => tool.name);
      for (const name of ['ask_host', 'list_host_requests', 'withdraw_host_request'])
        expect(names.includes(name)).toBe(hostRequests);
    },
  );

  it.each([false, true])('lists deployment tools only for their duty holder (%s)', async (holdsDuty) => {
    const result = await listToolsFor({
      ...developerAudience,
      duties: new Set(holdsDuty ? ['deployment'] : []),
    });
    for (const name of [
      'publish_release',
      'get_release_status',
      'run_compute_job',
      'get_compute_job',
      'list_compute_jobs',
    ]) {
      expect(result.tools.some((tool) => tool.name === name)).toBe(holdsDuty);
    }
  });

  it('reads the release status of the hub and the engines without writing (PM-1201)', async () => {
    const tool = TEAM_TOOLS.find((candidate) => candidate.name === 'get_release_status')!;
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.audience).toEqual({ duties: ['deployment'] });
    const handler = createFakeTeamToolsHandler();
    const text = await tool.run({ ctx: devContext, handler, args: {} });
    const status = await handler.getReleaseStatus(devContext);
    expect(text).toContain(`hub version=${status.hub.version}`);
    for (const engine of status.engines) expect(text).toContain(`${engine.id} ${engine.name} connected=`);
  });

  it.each([true, false])(
    'lists document tools only for project managers and the Operator (%s)',
    async (pm) => {
      const names = visibleTeamTools({ ...developerAudience, projectManager: pm }).map((tool) => tool.name);
      for (const name of [
        'read_project_doc',
        'write_project_docs',
        'list_decision_candidates',
        'mark_decision_candidates',
      ])
        expect(names.includes(name)).toBe(pm);
    },
  );

  it.each([
    { tools: ['merge_task', 'prioritize_merge'], grant: { merger: true } },
    { tools: ['send_email', 'set_email_contact', 'list_email_contacts'], grant: { email: true } },
    { tools: ['decide_permission_request'], grant: { duties: new Set(['boundary_authorization'] as const) } },
  ])('lists $tools only for who the handler allows', async ({ tools, grant }) => {
    const without = (await listToolsFor(developerAudience)).tools.map((tool) => tool.name);
    const withGrant = (await listToolsFor({ ...developerAudience, ...grant })).tools.map((tool) => tool.name);
    for (const name of tools) {
      expect(without).not.toContain(name);
      expect(withGrant).toContain(name);
    }
  });

  it('keeps the read-only merge check list for every member', async () => {
    const names = (await listToolsFor(developerAudience)).tools.map((tool) => tool.name);
    expect(names).toContain('list_merge_checks');
  });

  it.each([
    {
      audience: { ...developerAudience, projectManager: true },
      present: 'operate',
      absent: 'merge_task',
    },
    {
      audience: { ...developerAudience, projectManager: true },
      present: 'execute_operation',
      absent: 'publish_release',
    },
    {
      audience: { ...developerAudience, projectManager: true },
      present: 'update_checklist',
      absent: 'send_email',
    },
    {
      audience: { ...developerAudience, projectManager: true },
      present: 'get_role_configuration',
      absent: 'ask_host',
    },
    {
      audience: { ...developerAudience, duties: new Set(['feedback_processing'] as const) },
      present: 'get_feedback',
      absent: 'start_task',
    },
  ])('lists the tools for the matching role or duty ($present)', async ({ audience, present, absent }) => {
    const result = await listToolsFor(audience);
    const names = result.tools.map((tool) => tool.name);
    expect(names).toContain(present);
    expect(names).not.toContain(absent);
  });
});

describe('team tool definitions', () => {
  it('preserves the public tool definitions across module moves', async () => {
    const { tools } = await listToolsFor(fullAudience);
    expect(
      tools
        .map(({ name, title, description, inputSchema, annotations }) => ({
          name,
          title,
          description,
          inputSchema,
          annotations,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ).toMatchSnapshot();
  });
});

describe('team tool registration', () => {
  it('collects each known tool exactly once', () => {
    const names = TEAM_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...TEAM_TOOL_NAMES].sort());
  });

  it('keeps every description within the cap, so tools/list stays small', () => {
    const long = TEAM_TOOLS.filter((tool) => tool.description.length > TOOL_DESCRIPTION_MAX).map(
      (tool) => `${tool.name}: ${tool.description.length}`,
    );
    expect(long).toEqual([]);
  });

  it('collects distinct nonempty module groups', () => {
    expect(new Set(TEAM_TOOL_GROUPS.map((group) => group.module)).size).toBe(TEAM_TOOL_GROUPS.length);
    for (const group of TEAM_TOOL_GROUPS) {
      expect(group.tools.length).toBeGreaterThan(0);
      for (const tool of group.tools) expect(TEAM_TOOLS).toContain(tool);
    }
  });

  it('registers the moved tools with their owning modules', () => {
    expect(
      Object.fromEntries(
        TEAM_TOOL_GROUPS.map((group) => [group.module, group.tools.map((tool) => tool.name)]),
      ),
    ).toEqual({
      'services/email-channel': ['send_email', 'set_email_contact', 'list_email_contacts'],
      'services/github': ['link_pull_request'],
      'services/host-requests': ['ask_host', 'list_host_requests', 'withdraw_host_request'],
      'services/coordination': [
        'get_role_configuration',
        'request_structural_review',
        'triage_loop',
        'get_operator_diagnostics',
        'get_checklist',
        'update_checklist',
        'get_operator_knowledge',
        'propose_operator_knowledge',
        'get_operator_preference',
        'set_operator_preference',
        'get_project_state',
        'operate',
        'execute_operation',
        'get_operation',
        'combine_questions',
        'screen_question',
        'dismiss_signal',
        'open_integrator_todo',
        'start_task',
        'reassign_task',
        'cancel_task',
        'reopen_task',
        'start_member',
      ],
      'services/feedback': [
        'get_feedback',
        'reply_feedback',
        'create_task_from_feedback',
        'link_feedback',
        'forward_feedback',
        'close_feedback',
      ],
      'services/feedback/system': ['list_system_feedback', 'record_system_feedback'],
      'core/inbox': ['ask_human', 'withdraw_question', 'decide_permission_request'],
      'core/messages': ['send_message'],
      'runtime/admission': ['hand_off'],
      'runtime/watchers': ['decide_fix_limit'],
      'runtime/sessions': ['get_guide', 'set_current_work'],
      'core/members': ['list_members', 'save_memory'],
      'services/releases': ['get_release_status', 'publish_release'],
      'services/compute-jobs': ['run_compute_job', 'get_compute_job', 'list_compute_jobs'],
      'core/tasks': ['list_tasks', 'get_task', 'update_task', 'create_task'],
      'core/attachments': [
        'list_attachments',
        'read_attachment',
        'read_message_attachment',
        'attach_file',
        'delete_attachment',
      ],
      'core/documents': ['list_documents', 'read_document', 'write_document', 'document_history'],
      'services/project-docs': [
        'read_project_doc',
        'write_project_docs',
        'list_decision_candidates',
        'mark_decision_candidates',
      ],
      'services/history': ['search_history', 'read_history_source'],
      'services/merges': ['merge_task', 'prioritize_merge', 'list_merge_checks'],
      'services/full-tests': ['take_screenshots', 'get_screenshot_run'],
    });
  });
});
