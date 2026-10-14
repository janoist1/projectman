import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createTeamMcpServer, DEFAULT_TOOL_TIMEOUT_MS } from './server';
import { createFakeTeamToolsHandler, devContext } from './testing';
import { TEAM_TOOL_GROUPS, TEAM_TOOL_NAMES, TEAM_TOOLS } from './tools';

describe('team tool definitions', () => {
  it('preserves the public tool definitions across module moves', async () => {
    const app = Fastify();
    const server = createTeamMcpServer(devContext, {
      handler: createFakeTeamToolsHandler(),
      logger: app.log,
      toolTimeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'tool-snapshot-test', version: '1.0.0' });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const { tools } = await client.listTools();
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
    } finally {
      await client.close();
      await server.close();
      await app.close();
    }
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
      'core/members': ['list_members'],
      'services/releases': ['propose_release', 'check_release'],
      'core/tasks': ['list_tasks', 'get_task', 'update_task', 'create_task'],
      'core/attachments': [
        'list_attachments',
        'read_attachment',
        'read_message_attachment',
        'attach_file',
        'delete_attachment',
      ],
    });
  });
});
