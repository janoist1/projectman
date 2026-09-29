import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { forwarderCommand } from './claude-args';

/** The forwarder variant of command hooks that decide (Codex's PermissionRequest). */
async function forward(
  status: number,
  body: string,
  pathEnv: string,
): Promise<{ received: string; stdout: string; code: number }> {
  let received = '';
  const server = createServer((req, res) => {
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (received += chunk));
    req.on('end', () => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const command = forwarderCommand(`http://127.0.0.1:${port}/hooks/tok`, process.execPath, {
    printResponse: true,
    maxTimeS: 5,
  });
  const result = await new Promise<{ stdout: string; code: number }>((resolve) => {
    const child = execFile('/bin/sh', ['-c', command], { env: { PATH: pathEnv } }, (err, stdout) =>
      resolve({ stdout, code: err ? Number((err as { code?: number }).code ?? 1) : 0 }),
    );
    child.stdin!.end('{"hook_event_name":"PermissionRequest","tool_name":"Bash"}');
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return { received, ...result };
}

const DECISION =
  '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}';

describe('forwarderCommand with printResponse', () => {
  it('prints the answer with curl', async () => {
    const result = await forward(200, DECISION, process.env.PATH ?? '/usr/bin:/bin');
    expect(result).toEqual({
      received: '{"hook_event_name":"PermissionRequest","tool_name":"Bash"}',
      stdout: DECISION,
      code: 0,
    });
  });

  it('prints the answer with the Node fallback when curl is missing', async () => {
    const result = await forward(200, DECISION, '/nonexistent');
    expect(result.stdout).toBe(DECISION);
    expect(result.code).toBe(0);
  });

  it('prints nothing for an error answer or an unreachable server, and exits 0', async () => {
    expect(await forward(404, '{"not":"a decision"}', process.env.PATH ?? '/usr/bin:/bin')).toMatchObject({
      stdout: '',
      code: 0,
    });
    expect(await forward(404, '{"not":"a decision"}', '/nonexistent')).toMatchObject({ stdout: '', code: 0 });
    const command = forwarderCommand('http://127.0.0.1:9/hooks/tok', process.execPath, {
      printResponse: true,
      maxTimeS: 2,
    });
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile('/bin/sh', ['-c', command], (err, out) => (err ? reject(err) : resolve(out)));
      child.stdin!.end('{}');
    });
    expect(stdout).toBe('');
  });

  it('keeps the default forwarder unchanged', () => {
    expect(forwarderCommand('http://127.0.0.1:1/hooks/t', '/node')).toContain('-m 10 -o /dev/null');
    expect(forwarderCommand('http://127.0.0.1:1/hooks/t', '/node', { maxTimeS: 30 })).toContain(
      '-m 30 -o /dev/null',
    );
  });
});
