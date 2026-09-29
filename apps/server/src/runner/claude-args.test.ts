import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { StartSessionSpec } from '../contracts';
import {
  HTTP_HOOK_EVENTS,
  buildClaudeArgs,
  buildMcpConfig,
  buildSettings,
  cliExists,
  forwarderCommand,
  hookUrlFor,
  resolveCommand,
  shellQuote,
} from './claude-args';

const spec: StartSessionSpec = {
  sessionId: 'ses_1',
  claudeSessionId: '0b8a3c2e-1f5d-4c4e-9a7b-2d6e8f1a3b5c',
  resume: false,
  cwd: '/work',
  displayName: 'Anna · fe-1',
  model: 'opus',
  permissionMode: 'acceptEdits',
  appendSystemPrompt: '- You are fe-1.\n- Speak Hungarian.',
  initialMessage: 'Brief',
  mcpUrl: 'http://127.0.0.1:4700/mcp/tok',
  allowedTools: ['mcp__team', 'mcp__team__*', 'mcp__team'],
};

describe('buildSettings', () => {
  const settings = buildSettings({
    hookUrl: 'http://127.0.0.1:4700/hooks/abc',
    allowedTools: spec.allowedTools,
    permissionTimeoutMs: 15 * 60_000,
  });

  it('pre-allows the given tools, without duplicates and in both accepted forms', () => {
    expect(settings.permissions.allow).toEqual(['mcp__team', 'mcp__team__*']);
  });

  it('registers an HTTP hook for every event except SessionStart, which uses a command', () => {
    for (const event of HTTP_HOOK_EVENTS) {
      expect(settings.hooks[event]).toEqual([
        { hooks: [{ type: 'http', url: 'http://127.0.0.1:4700/hooks/abc', timeout: expect.any(Number) }] },
      ]);
    }
    const start = settings.hooks.SessionStart![0]!.hooks[0]!;
    expect(start.type).toBe('command');
    expect(start.command).toContain("'http://127.0.0.1:4700/hooks/abc'");
  });

  it('lets a permission request wait longer than our own timeout', () => {
    const timeout = settings.hooks.PermissionRequest![0]!.hooks[0]!.timeout;
    expect(timeout * 1000).toBeGreaterThan(15 * 60_000);
    expect(settings.hooks.UserPromptSubmit![0]!.hooks[0]!.timeout).toBeLessThanOrEqual(30);
  });
});

describe('buildClaudeArgs', () => {
  const settings = buildSettings({
    hookUrl: 'http://h/hooks/t',
    allowedTools: [],
    permissionTimeoutMs: 1000,
  });

  it('starts a new conversation with a fixed session id and every flag', () => {
    const args = buildClaudeArgs(spec, settings);
    const flag = (name: string) => args[args.indexOf(name) + 1];
    expect(flag('--session-id')).toBe(spec.claudeSessionId);
    expect(args).not.toContain('--resume');
    expect(flag('--append-system-prompt')).toBe(spec.appendSystemPrompt);
    expect(JSON.parse(flag('--mcp-config')!)).toEqual({
      mcpServers: { team: { type: 'http', url: 'http://127.0.0.1:4700/mcp/tok' } },
    });
    expect(JSON.parse(flag('--settings')!)).toEqual(settings);
    expect(flag('--model')).toBe('opus');
    expect(flag('--permission-mode')).toBe('acceptEdits');
    expect(flag('-n')).toBe('Anna · fe-1');
    // The variadic --mcp-config value must be followed by another option, never by a value.
    expect(args[args.indexOf('--mcp-config') + 2]).toMatch(/^-/);
  });

  it('resumes an existing conversation and leaves out unset options', () => {
    const args = buildClaudeArgs(
      { ...spec, resume: true, model: undefined, permissionMode: undefined, appendSystemPrompt: '' },
      settings,
    );
    expect(args.slice(0, 2)).toEqual(['--resume', spec.claudeSessionId]);
    expect(args).not.toContain('--session-id');
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--permission-mode');
    expect(args).not.toContain('--append-system-prompt');
  });
});

describe('helpers', () => {
  it('builds hook urls and MCP config', () => {
    expect(hookUrlFor('http://127.0.0.1:4700/', 'abc')).toBe('http://127.0.0.1:4700/hooks/abc');
    expect(buildMcpConfig('http://x/mcp/1').mcpServers.team.type).toBe('http');
  });

  it('runs JavaScript CLIs with the current Node binary', () => {
    expect(resolveCommand('/x/fake-claude.mjs', ['-a'])).toEqual({
      file: process.execPath,
      args: ['/x/fake-claude.mjs', '-a'],
    });
    expect(resolveCommand('claude', ['-a'])).toEqual({ file: 'claude', args: ['-a'] });
  });

  it('checks that the CLI can be started', async () => {
    const fake = new URL('../../test/fixtures/fake-claude.mjs', import.meta.url).pathname;
    expect(await cliExists(fake, '')).toBe(true);
    expect(await cliExists('/nonexistent/fake-claude.mjs', '')).toBe(false);
    expect(await cliExists('sh', '/usr/bin:/bin')).toBe(true);
    expect(await cliExists('sh', '/nonexistent')).toBe(false);
    expect(await cliExists('/bin/sh', '')).toBe(true);
    expect(await cliExists('/etc', '')).toBe(false);
  });

  it('quotes for sh', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe('forwarderCommand', () => {
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
