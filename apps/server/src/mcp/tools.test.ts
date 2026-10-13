import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createTeamMcpServer, DEFAULT_TOOL_TIMEOUT_MS } from './server';
import { createFakeTeamToolsHandler, devContext } from './testing';

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
