import { describe, expect, it } from 'vitest';
import type { StartSessionSpec } from '../../../contracts';
import { HTTP_HOOK_EVENTS, buildClaudeArgs, buildMcpConfig, buildSettings } from './args';

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

  it('passes non-empty deny rules and omits empty ones', () => {
    const input = { hookUrl: 'http://h/hooks/t', allowedTools: [], permissionTimeoutMs: 1000 };
    expect(buildSettings(input).permissions).not.toHaveProperty('deny');
    expect(buildSettings({ ...input, deniedTools: [] }).permissions).not.toHaveProperty('deny');
    expect(
      buildSettings({ ...input, deniedTools: ['Bash(git push:*)', 'Bash(git push:*)'] }).permissions.deny,
    ).toEqual(['Bash(git push:*)']);
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

  it.each([false, true])('passes effort on sessions with resume=%s', (resume) => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const args = buildClaudeArgs({ ...spec, resume, effort }, settings);
      expect(args[args.indexOf('--effort') + 1]).toBe(effort);
    }
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
    expect(args).not.toContain('--effort');
    expect(flag('--permission-mode')).toBe('acceptEdits');
    expect(flag('-n')).toBe('Anna · fe-1');
    // The variadic --mcp-config value must be followed by another option, never by a value.
    expect(args[args.indexOf('--mcp-config') + 2]).toMatch(/^-/);
  });

  it('passes every additional directory on both new and resumed sessions', () => {
    for (const resume of [false, true]) {
      const dirs = ['/worktrees/AR/AR-1-web', '/worktrees/AR/AR-2 with spaces'];
      const args = buildClaudeArgs({ ...spec, resume, additionalDirectories: dirs }, settings);
      expect(args.filter((arg, index) => args[index - 1] === '--add-dir')).toEqual(dirs);
    }
    expect(buildClaudeArgs(spec, settings)).not.toContain('--add-dir');
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
    expect(args).not.toContain('--effort');
  });
});

describe('buildMcpConfig', () => {
  it('points the team server at the session endpoint over HTTP', () => {
    expect(buildMcpConfig('http://x/mcp/1').mcpServers.team.type).toBe('http');
  });
});
