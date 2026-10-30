import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { ExternalCredentialMode, ExternalMcpBackend, IntegratorPrincipal } from '../../contracts';
import { DEFAULT_TOOL_TIMEOUT_MS, SERVER_INFO } from '../server';
import { externalToolsFor } from './registry';
import { createExternalMcpServer } from './server';

async function listed(server: Server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'listing-test', version: '1.0.0' });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    // Only what the external listing builds: the SDK adds protocol defaults (`execution`, `_meta`) of its own.
    return (await client.listTools()).tools.map(({ name, title, description, inputSchema, annotations }) => ({
      name,
      title,
      description,
      inputSchema,
      annotations,
    }));
  } finally {
    await client.close();
    await server.close();
  }
}

describe('external tools/list', () => {
  // The listing is memoized per tool; the SDK's own registration is the reference it must equal.
  it.each<{ mode: ExternalCredentialMode; host: boolean }>([
    { mode: 'super', host: true },
    { mode: 'super', host: false },
    { mode: 'read', host: false },
  ])('equals the SDK listing of the same tools for %o', async ({ mode, host }) => {
    const app = Fastify();
    try {
      const principal = { mode } as IntegratorPrincipal;
      const backend = { isHost: () => host } as unknown as ExternalMcpBackend;
      const external = createExternalMcpServer(
        { principal, requestId: 'req_listing' },
        { unauthorized: false },
        {
          backend,
          logger: app.log,
          toolTimeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
        },
      );
      const reference = new McpServer(SERVER_INFO);
      for (const tool of externalToolsFor(mode, host))
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
      const tools = await listed(external);
      expect(tools.length).toBeGreaterThan(0);
      expect(tools).toEqual(await listed(reference.server));
      // A second request is answered from the memo and is still the same listing.
      const again = createExternalMcpServer(
        { principal, requestId: 'req_again' },
        { unauthorized: false },
        {
          backend,
          logger: app.log,
          toolTimeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
        },
      );
      expect(await listed(again)).toEqual(tools);
    } finally {
      await app.close();
    }
  });
});
