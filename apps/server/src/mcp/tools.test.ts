import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createTeamMcpServer, DEFAULT_TOOL_TIMEOUT_MS, visibleTeamTools } from './server';
import { createFakeTeamToolsHandler, devContext, operatorAudience } from './testing';
import type { MemberAudience } from '../contracts';
import { toolVisible, type ToolAudience } from './kit';
import { TEAM_TOOL_GROUPS, TEAM_TOOL_NAMES, TEAM_TOOLS } from './tools';

const developerAudience: MemberAudience = { ...operatorAudience, operator: false };

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
  it.each([operatorAudience, developerAudience, { ...developerAudience, projectManager: true }])(
    'registers exactly the tools listed by the context preview for %o',
    async (audience) => {
      const result = await listToolsFor(audience);
      expect(result.tools.map(({ name, title, description }) => ({ name, title, description }))).toEqual(
        visibleTeamTools(audience),
      );
    },
  );
  it.each<{ audience: ToolAudience | undefined; member: MemberAudience; visible: boolean }>([
    { audience: undefined, member: developerAudience, visible: true },
    { audience: {}, member: operatorAudience, visible: true },
    { audience: {}, member: developerAudience, visible: false },
    { audience: { roles: ['operator'] }, member: developerAudience, visible: false },
    {
      audience: { roles: ['project_manager'] },
      member: { ...developerAudience, projectManager: true },
      visible: true,
    },
    { audience: { roles: ['merger'] }, member: { ...developerAudience, merger: true }, visible: true },
    { audience: { duties: ['deployment'] }, member: developerAudience, visible: false },
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

  it('lists all tools for the Operator and hides restricted tools from a developer', async () => {
    const before = await listToolsFor(operatorAudience);
    const after = await listToolsFor(developerAudience);
    expect(before.tools.map((tool) => tool.name).sort()).toEqual([...TEAM_TOOL_NAMES].sort());
    expect(after.tools.map((tool) => tool.name)).not.toContain('check_release');
    expect(after.tools.map((tool) => tool.name)).toContain('get_guide');
    console.info('tools/list JSON bytes', {
      before: Buffer.byteLength(JSON.stringify(before)),
      after: Buffer.byteLength(JSON.stringify(after)),
      beforeCount: before.tools.length,
      afterCount: after.tools.length,
    });
  });

  it.each([false, true])('lists deployment tools only for their duty holder (%s)', async (holdsDuty) => {
    const result = await listToolsFor({
      ...developerAudience,
      duties: new Set(holdsDuty ? ['deployment'] : []),
    });
    for (const name of ['propose_release', 'publish_release']) {
      expect(result.tools.some((tool) => tool.name === name)).toBe(holdsDuty);
    }
  });

  it.each([
    { audience: { ...developerAudience, projectManager: true }, present: 'start_task', absent: 'operate' },
    {
      audience: { ...developerAudience, projectManager: true },
      present: 'get_operator_preference',
      absent: 'propose_operator_knowledge',
    },
    {
      audience: { ...developerAudience, projectManager: true },
      present: 'set_operator_preference',
      absent: 'execute_operation',
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
    const { tools } = await listToolsFor(operatorAudience);
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
      'services/operator': [
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
        'get_machine_status',
        'get_machine_logs',
        'combine_questions',
        'screen_question',
        'dismiss_signal',
        'open_integrator_todo',
        'start_task',
        'start_member',
      ],
      'services/boundary': ['submit_boundary_request', 'get_boundary_request', 'decide_boundary_request'],
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
      'core/member-queue': ['finish_queue_item'],
      'runtime/sessions': ['get_guide', 'set_current_work'],
      'core/members': ['list_members', 'save_memory'],
      'services/releases': ['propose_release', 'publish_release', 'check_release'],
      'core/tasks': ['list_tasks', 'get_task', 'update_task', 'create_task'],
      'core/attachments': [
        'list_attachments',
        'read_attachment',
        'read_message_attachment',
        'attach_file',
        'delete_attachment',
      ],
      'services/project-docs': [
        'read_project_doc',
        'write_project_docs',
        'list_decision_candidates',
        'mark_decision_candidates',
      ],
      'services/history': ['search_history', 'read_history_source', 'get_history_search_stats'],
      'services/merges': ['merge_task', 'prioritize_merge', 'list_merge_checks'],
      'services/full-tests': ['take_screenshots', 'get_screenshot_run'],
    });
  });
});
