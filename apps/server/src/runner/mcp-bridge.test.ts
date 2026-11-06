import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { mcpBridgeCommand, writeMcpBridgeConfig } from './mcp-bridge';

const TOKEN = 'bridge-canary-0f3a9c';
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** A local server answering every POST with `handle`; returns the team URL with the token. */
async function serve(
  handle: (body: string, req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => handle(body, req, res));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp/${TOKEN}`;
}

/** A closed port: connecting fails. */
async function closedUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/mcp/${TOKEN}`;
}

/** Runs the bridge over a session-like private folder, sends `messages` and closes stdin. */
async function bridge(
  url: string | null,
  messages: unknown[],
): Promise<{ lines: unknown[]; stdout: string; stderr: string; code: number | null }> {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'mcp-bridge-'));
  cleanup.push(() => rm(folder, { recursive: true, force: true }));
  await chmod(folder, 0o700);
  const configPath =
    url === null ? path.join(folder, 'codex-mcp.json') : await writeMcpBridgeConfig(folder, url);
  const { command, args } = mcpBridgeCommand(configPath);
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
  child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
  child.stdin.end(messages.map((m) => `${JSON.stringify(m)}\n`).join(''));
  // Exits on its own once stdin is closed and the requests are answered.
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  const lines = stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
  return { lines, stdout, stderr, code };
}

const call = (id: number, method = 'tools/call') => ({ jsonrpc: '2.0', id, method, params: {} });
const note = { jsonrpc: '2.0', method: 'notifications/initialized' };
const unreachable = (id: number, status: string | number) => ({
  jsonrpc: '2.0',
  id,
  error: { code: -32000, message: `team server unreachable (${status})` },
});

describe('the team MCP stdio bridge (PM-1170)', () => {
  it('passes the path of the private file as its only argument, never the URL', () => {
    expect(mcpBridgeCommand('/run/ses_1/codex-mcp.json', '/opt/node')).toEqual({
      command: '/opt/node',
      args: ['-e', expect.any(String), '/run/ses_1/codex-mcp.json'],
    });
    expect(() => mcpBridgeCommand('codex-mcp.json')).toThrow(/absolute/);
  });

  it('carries a stateless JSON MCP session: object answers, and nothing for an accepted notification', async () => {
    const url = await serve((body, req, res) => {
      const server = new McpServer({ name: 'team', version: '1' });
      server.registerTool('echo', { inputSchema: { text: z.string() } }, ({ text }) => ({
        content: [{ type: 'text', text }],
      }));
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      void server.connect(transport).then(async () => {
        const answer = await transport.handleRequest(
          new Request(`http://127.0.0.1${req.url}`, {
            method: 'POST',
            headers: req.headers as Record<string, string>,
            body,
          }),
        );
        res.writeHead(answer.status, Object.fromEntries(answer.headers));
        res.end(await answer.text());
      });
    });
    const { lines, code } = await bridge(url, [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'codex', version: '0' },
        },
      },
      note,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } },
    ]);
    expect(code).toBe(0);
    expect(lines).toHaveLength(2);
    expect(lines).toContainEqual(
      expect.objectContaining({ id: 1, result: expect.objectContaining({ serverInfo: expect.anything() }) }),
    );
    expect(lines).toContainEqual({
      jsonrpc: '2.0',
      id: 2,
      result: { content: [{ type: 'text', text: 'hi' }] },
    });
  });

  it('writes every message of an array answer on its own line', async () => {
    const url = await serve((_body, _req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify([
          { jsonrpc: '2.0', id: 1, result: {} },
          { jsonrpc: '2.0', id: 2, result: {} },
        ]),
      );
    });
    const { lines } = await bridge(url, [[call(1), call(2)]]);
    expect(lines).toEqual([
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', id: 2, result: {} },
    ]);
  });

  it('answers a request refused by the server with an error, a notification with nothing', async () => {
    const url = await serve((_body, _req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `no session ${TOKEN}` }));
    });
    const { lines, stdout, stderr } = await bridge(url, [call(7), note]);
    expect(lines).toEqual([unreachable(7, 404)]);
    expect(stdout + stderr).not.toContain(TOKEN);
  });

  it('answers a request with an error when the server cannot be reached, without the URL', async () => {
    const url = await closedUrl();
    const { lines, stdout, stderr } = await bridge(url, [call(3), note]);
    expect(lines).toEqual([unreachable(3, 'network error')]);
    expect(stdout + stderr).not.toContain(TOKEN);
    expect(stdout + stderr).not.toContain('127.0.0.1');
  });

  it('answers a request with an error for an answer that is not JSON', async () => {
    const url = await serve((_body, _req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>proxy</html>');
    });
    expect((await bridge(url, [call(4)])).lines).toEqual([unreachable(4, 'invalid response')]);
  });

  it('answers a request with an error when its private file is missing', async () => {
    expect((await bridge(null, [call(5), note])).lines).toEqual([unreachable(5, 'no target')]);
  });
});
