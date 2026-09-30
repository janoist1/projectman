import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  FAST_HOOK_TIMEOUT_S,
  forwarderCommand,
  hookUrlFor,
  permissionHookTimeoutS,
  shellQuote,
} from './hook-forwarder';

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

describe('forwarderCommand without printResponse', () => {
  async function forward(pathEnv: string): Promise<{ body: string; stdout: string }> {
    let body = '';
    const server = createServer((req, res) => {
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('this must not reach stdout');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const command = forwarderCommand(`http://127.0.0.1:${port}/hooks/tok`);
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile('/bin/sh', ['-c', command], { env: { PATH: pathEnv } }, (err, out) =>
        err ? reject(err) : resolve(out),
      );
      child.stdin!.end('{"hook_event_name":"SessionStart","session_id":"s1"}');
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return { body, stdout };
  }

  it('posts the hook payload with curl and prints nothing', async () => {
    const result = await forward(process.env.PATH ?? '/usr/bin:/bin');
    expect(JSON.parse(result.body)).toEqual({ hook_event_name: 'SessionStart', session_id: 's1' });
    expect(result.stdout).toBe('');
  });

  it('falls back to Node when curl is missing', async () => {
    // Only /bin on PATH: sh is there, curl (in /usr/bin) is not.
    const result = await forward('/bin');
    expect(JSON.parse(result.body)).toEqual({ hook_event_name: 'SessionStart', session_id: 's1' });
    expect(result.stdout).toBe('');
  });
});

describe('helpers', () => {
  it('builds hook urls', () => {
    expect(hookUrlFor('http://127.0.0.1:4700/', 'abc')).toBe('http://127.0.0.1:4700/hooks/abc');
  });

  it('quotes for sh', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it('lets a permission hook wait longer than our own timeout', () => {
    expect(permissionHookTimeoutS(15 * 60_000)).toBe(15 * 60 + 30);
    expect(permissionHookTimeoutS(1500)).toBe(32);
    expect(FAST_HOOK_TIMEOUT_S).toBe(10);
  });
});
