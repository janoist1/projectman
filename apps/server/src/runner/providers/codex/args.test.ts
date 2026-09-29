import { describe, expect, it } from 'vitest';
import type { StartSessionSpec } from '../../../contracts';
import {
  buildCodexArgs,
  CODEX_HOOK_EVENTS,
  codexModel,
  codexPermissions,
  teamToolApprovals,
  tomlString,
  tomlValue,
} from './args';

const spec: StartSessionSpec = {
  sessionId: 'ses_1',
  claudeSessionId: '0b8a3c2e-1f5d-4c4e-9a7b-2d6e8f1a3b5c',
  resume: false,
  cwd: '/work',
  displayName: 'Anna · fe-1',
  model: 'opus',
  permissionMode: 'default',
  appendSystemPrompt: '- You are fe-1.\n- Speak Hungarian.',
  initialMessage: 'Brief',
  mcpUrl: 'http://127.0.0.1:4700/mcp/tok',
  allowedTools: ['mcp__team__*', 'Read', 'Bash(git diff:*)'],
  provider: 'codex',
};

const input = {
  spec,
  hookUrl: 'http://127.0.0.1:4700/hooks/secret',
  permissionTimeoutMs: 40_000,
  realCwd: '/Users/anna/.projectman/worktrees/AR/AR-1',
  nodePath: '/usr/local/bin/node',
};

/** The `-c` overrides of an argument list, as key -> raw value. */
function overrides(args: string[]): Map<string, string> {
  const map = new Map<string, string>();
  args.forEach((arg, i) => {
    if (args[i - 1] !== '-c') return;
    const eq = arg.indexOf('=');
    map.set(arg.slice(0, eq), arg.slice(eq + 1));
  });
  return map;
}

describe('TOML values', () => {
  it('escapes strings for TOML basic strings', () => {
    expect(tomlString('a"b\\c\nd\te\r')).toBe('"a\\"b\\\\c\\nd\\te\\r"');
    expect(tomlString('bell\u0007 del\u007f')).toBe('"bell\\u0007 del\\u007f"');
    expect(tomlString('naïve café ✓ 🙂')).toBe('"naïve café ✓ 🙂"');
    expect(tomlString('lone \ud800 surrogate')).toBe('"lone � surrogate"');
  });

  it('writes inline tables, arrays and scalars; paths become quoted keys', () => {
    expect(tomlValue({ '/Users/anna/.pm/ws': { trust_level: 'trusted' } })).toBe(
      '{"/Users/anna/.pm/ws"={trust_level="trusted"}}',
    );
    expect(tomlValue([{ hooks: [{ type: 'command', command: "echo 'x'", timeout: 10 }] }])).toBe(
      `[{hooks=[{type="command",command="echo 'x'",timeout=10}]}]`,
    );
    expect(tomlValue({ a: true, b: 1.5, c: undefined, d: ['CLAUDE.md'] })).toBe(
      '{a=true,b=1.5,d=["CLAUDE.md"]}',
    );
    expect(() => tomlValue(Number.NaN)).toThrow(/not representable/);
    expect(() => tomlValue(null)).toThrow(/not representable/);
  });
});

describe('Codex settings from the member', () => {
  it('maps Claude Code permission modes to a sandbox and an approval policy', () => {
    expect(codexPermissions('default')).toEqual({ sandbox: 'read-only', approval: 'on-request' });
    expect(codexPermissions(undefined)).toEqual({ sandbox: 'read-only', approval: 'on-request' });
    expect(codexPermissions('acceptEdits')).toEqual({ sandbox: 'workspace-write', approval: 'on-request' });
    expect(codexPermissions('auto')).toEqual({ sandbox: 'workspace-write', approval: 'on-request' });
    expect(codexPermissions('plan')).toEqual({ sandbox: 'read-only', approval: 'never' });
    expect(codexPermissions('bypassPermissions')).toEqual({
      sandbox: 'danger-full-access',
      approval: 'never',
    });
  });

  it('never passes Claude model names to Codex', () => {
    for (const model of [
      'opus',
      'Sonnet',
      'haiku',
      'default',
      'best',
      'opus[1m]',
      'claude-opus-4-1',
      'fable',
      '',
      ' ',
    ]) {
      expect(codexModel(model)).toBe('gpt-6.1-sol');
    }
    expect(codexModel(undefined)).toBe('gpt-6.1-sol');
    expect(codexModel('gpt-6.1-codex')).toBe('gpt-6.1-codex');
    expect(codexModel(' o4-mini ')).toBe('o4-mini');
  });

  it('pre-approves the team tools named by the allow rules', () => {
    expect(teamToolApprovals(['mcp__team__*', 'Read'])).toEqual({ all: true, tools: [] });
    expect(teamToolApprovals(['mcp__team'])).toEqual({ all: true, tools: [] });
    expect(teamToolApprovals(['mcp__team__send_message', 'mcp__team__get_task', 'mcp__other__x'])).toEqual({
      all: false,
      tools: ['send_message', 'get_task'],
    });
  });
});

describe('buildCodexArgs', () => {
  it('runs the TUI inline, without the daemon, with our hooks trusted and the brief as the prompt', () => {
    const args = buildCodexArgs(input);
    expect(args.slice(0, 6)).toEqual([
      '--no-alt-screen',
      '--no-daemon',
      '--dangerously-bypass-hook-trust',
      '--enable',
      'hooks',
      '-c',
    ]);
    expect(args.slice(-10)).toEqual([
      '--sandbox',
      'read-only',
      '--ask-for-approval',
      'on-request',
      '--model',
      'gpt-6.1-sol',
      '-c',
      'model_reasoning_effort="medium"',
      '--',
      'Brief',
    ]);
    expect(args).not.toContain('resume');
  });

  it('sets everything with -c overrides whose keys never contain a path', () => {
    const c = overrides(buildCodexArgs(input));
    for (const key of c.keys()) expect(key).toMatch(/^[A-Za-z_]+(?:\.[A-Za-z_]+)*$/);
    expect(c.get('check_for_update_on_startup')).toBe('false');
    expect(c.get('projects')).toBe('{"/Users/anna/.projectman/worktrees/AR/AR-1"={trust_level="trusted"}}');
    expect(c.get('project_doc_fallback_filenames')).toBe('["CLAUDE.md"]');
    expect(c.get('developer_instructions')).toBe('"- You are fe-1.\\n- Speak Hungarian."');
    expect(c.get('mcp_servers.team')).toBe(
      '{url="http://127.0.0.1:4700/mcp/tok",default_tools_approval_mode="approve"}',
    );
    expect(c.has('notice.hide_full_access_warning')).toBe(false);
    for (const event of CODEX_HOOK_EVENTS) expect(c.has(`hooks.${event}`)).toBe(true);
  });

  it('prints only the PermissionRequest answer, and waits longer than our own permission timeout', () => {
    const c = overrides(buildCodexArgs(input));
    const permission = c.get('hooks.PermissionRequest')!;
    expect(permission).toContain('timeout=70}');
    expect(permission).toContain('curl -sSf -m 70');
    expect(permission).not.toContain('-o /dev/null');
    const stop = c.get('hooks.Stop')!;
    expect(stop).toContain('timeout=10}');
    expect(stop).toContain('-o /dev/null');
    expect(stop).toContain("'http://127.0.0.1:4700/hooks/secret'");
  });

  it('resumes by id, with or without a message, and sanitises the prompt', () => {
    const resumed = buildCodexArgs({ ...input, spec: { ...spec, resume: true, initialMessage: null } });
    expect(resumed[0]).toBe('resume');
    expect(resumed.slice(-2)).toEqual(['--', spec.claudeSessionId]);
    const withMessage = buildCodexArgs({
      ...input,
      spec: { ...spec, resume: true, initialMessage: '!ls\u001b[2J now' },
    });
    expect(withMessage.slice(-3)).toEqual(['--', spec.claudeSessionId, ' !ls[2J now']);
  });

  it('turns off the sandbox and the questions only for bypassPermissions, and passes a Codex model', () => {
    const args = buildCodexArgs({
      ...input,
      spec: { ...spec, permissionMode: 'bypassPermissions', model: 'gpt-6.1-codex', allowedTools: [] },
    });
    const c = overrides(args);
    expect(c.get('notice.hide_full_access_warning')).toBe('true');
    expect(c.get('mcp_servers.team')).toBe('{url="http://127.0.0.1:4700/mcp/tok"}');
    expect(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 6)).toEqual([
      '--sandbox',
      'danger-full-access',
      '--ask-for-approval',
      'never',
      '--model',
      'gpt-6.1-codex',
    ]);
  });
});
