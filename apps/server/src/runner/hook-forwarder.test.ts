import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FAST_HOOK_TIMEOUT_S,
  forwarderCommand,
  hookUrlFor,
  permissionHookTimeoutS,
  shellQuote,
} from './hook-forwarder';
import { writeHookConfig } from './session-config';

const folders: string[] = [];

afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

/** A private folder like a session's, with the forwarder's target file for `url`. */
async function targetFor(url: string): Promise<string> {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'fwd-'));
  folders.push(folder);
  await chmod(folder, 0o700);
  return writeHookConfig(folder, url);
}

/** The forwarder variant of command hooks that decide (Codex's PermissionRequest). */
async function forward(
  status: number,
  body: string,
  pathEnv: string,
  fallbackOutput?: string,
): Promise<{ received: string; stdout: string; code: number; command: string }> {
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
  const command = forwarderCommand(await targetFor(`http://127.0.0.1:${port}/hooks/tok`), process.execPath, {
    printResponse: true,
    maxTimeS: 5,
    fallbackOutput,
  });
  const result = await new Promise<{ stdout: string; code: number }>((resolve) => {
    const child = execFile('/bin/sh', ['-c', command], { env: { PATH: pathEnv } }, (err, stdout) =>
      resolve({ stdout, code: err ? Number((err as { code?: number }).code ?? 1) : 0 }),
    );
    child.stdin!.end('{"hook_event_name":"PermissionRequest","tool_name":"Bash"}');
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return { received, ...result, command };
}

const DECISION =
  '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}';

describe('forwarderCommand with printResponse', () => {
  it.each([process.env.PATH ?? '/usr/bin:/bin', '/nonexistent'])(
    'fails closed for missing, empty or error responses (%s)',
    async (pathEnv) => {
      const fallback = '{"decision":"deny","reason":"server unavailable"}';
      for (const [status, body] of [
        [200, ''],
        [302, '{"decision":"allow"}'],
        [500, 'error'],
      ] as const)
        expect(await forward(status, body, pathEnv, fallback)).toMatchObject({ stdout: fallback, code: 0 });
      expect(await forward(201, '{"decision":"allow"}', pathEnv, fallback)).toMatchObject({
        stdout: '{"decision":"allow"}',
        code: 0,
      });
      const command = forwarderCommand(await targetFor('http://127.0.0.1:9/hooks/token'), process.execPath, {
        printResponse: true,
        maxTimeS: 1,
        fallbackOutput: fallback,
      });
      const result = await new Promise<{ stdout: string; code: number }>((resolve) => {
        const child = execFile('/bin/sh', ['-c', command], { env: { PATH: pathEnv } }, (err, stdout) =>
          resolve({ stdout, code: err ? 1 : 0 }),
        );
        child.stdin!.end('{}');
      });
      expect(result).toEqual({ stdout: fallback, code: 0 });
    },
  );
  it('prints the answer with curl', async () => {
    const result = await forward(200, DECISION, process.env.PATH ?? '/usr/bin:/bin');
    expect(result).toMatchObject({
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
    const command = forwarderCommand(await targetFor('http://127.0.0.1:9/hooks/tok'), process.execPath, {
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
    expect(forwarderCommand('/run/s/hook.curl', '/node')).toContain('-m 10 -o /dev/null');
    expect(forwarderCommand('/run/s/hook.curl', '/node', { maxTimeS: 30 })).toContain('-m 30 -o /dev/null');
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
    const command = forwarderCommand(await targetFor(`http://127.0.0.1:${port}/hooks/tok`));
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

describe('the target file (PM-156)', () => {
  const CANARY = 'CANARY-hook-token-0123456789';

  it.each(['curl', 'node'])(
    'keeps the token out of the command and the process list (%s)',
    async (branch) => {
      // The command text, which is also the argument list of the shell and of the forwarder.
      const command = forwarderCommand('/run/ses.1/hook.curl', process.execPath, {
        printResponse: true,
        fallbackOutput: '{}',
      });
      expect(command).not.toContain(CANARY);
      expect(command).not.toContain('http://');
      expect(command).toContain(shellQuote('/run/ses.1/hook.curl'));
      const result = await forward(
        200,
        DECISION,
        branch === 'curl' ? (process.env.PATH ?? '/usr/bin:/bin') : '/nonexistent',
      );
      expect(result.command).not.toContain('/hooks/tok');
      expect(result.command).not.toContain('127.0.0.1');
      expect(result.stdout).toBe(DECISION);
    },
  );

  it.each([
    ['curl', process.env.PATH ?? '/usr/bin:/bin'],
    ['node', '/nonexistent'],
  ])('sends nothing and exits 0 for a missing file (%s)', async (_branch, pathEnv) => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'fwd-'));
    folders.push(folder);
    const missing = path.join(folder, 'hook.curl');
    for (const opts of [
      {},
      { printResponse: true },
      { printResponse: true, fallbackOutput: '{"d":"deny"}' },
    ]) {
      const command = forwarderCommand(missing, process.execPath, { maxTimeS: 2, ...opts });
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = execFile('/bin/sh', ['-c', command], { env: { PATH: pathEnv } }, (err, out) =>
          err ? reject(err) : resolve(out),
        );
        child.stdin!.end('{}');
      });
      expect(stdout).toBe('fallbackOutput' in opts ? '{"d":"deny"}' : '');
    }
  });

  it('never posts to a malformed file in the Node fallback', async () => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests += 1;
      res.end('x');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const folder = await mkdtemp(path.join(os.tmpdir(), 'fwd-'));
    folders.push(folder);
    const file = path.join(folder, 'hook.curl');
    await writeFile(file, `# comment\nurl = http://127.0.0.1:${port}/hooks/tok\n`);
    const command = forwarderCommand(file, process.execPath, { maxTimeS: 2 });
    await new Promise<void>((resolve, reject) => {
      const child = execFile('/bin/sh', ['-c', command], { env: { PATH: '/nonexistent' } }, (err) =>
        err ? reject(err) : resolve(),
      );
      child.stdin!.end('{}');
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(requests).toBe(0);
  });

  it('refuses a relative target path', () => {
    expect(() => forwarderCommand('hook.curl')).toThrow(/absolute/);
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
