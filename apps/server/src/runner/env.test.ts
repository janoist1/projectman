import { describe, expect, it } from 'vitest';
import { buildChildEnv, buildSessionEnv, withLocalNoProxy } from './env';

describe('child environment', () => {
  const base = {
    PATH: '/usr/bin',
    HOME: '/home/me',
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    ANTHROPIC_AUTH_TOKEN: 'x',
    ANTHROPIC_BASE_URL: 'http://proxy',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_VERTEX: '1',
    CLAUDE_CODE_USE_FOUNDRY: '1',
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_SESSION_ID: 'abc',
    CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/x',
    CLAUDE_CODE_OAUTH_TOKEN: 'subscription-token',
    CLAUDE_CONFIG_DIR: '/home/me/.claude-work',
    PROJECTMAN_SESSION_ID: 'parent',
    NO_COLOR: '1',
    UNDEFINED: undefined,
  };

  it('removes API billing variables and parent-session markers, keeps the rest', () => {
    const env = buildChildEnv(base);
    for (const name of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
      'CLAUDECODE',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_CHILD_SESSION',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_CODE_MESSAGING_SOCKET',
      'PROJECTMAN_SESSION_ID',
      'NO_COLOR',
      'UNDEFINED',
    ]) {
      expect(env).not.toHaveProperty(name);
    }
    // Subscription login and the user's config dir stay.
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      HOME: '/home/me',
      CLAUDE_CODE_OAUTH_TOKEN: 'subscription-token',
      CLAUDE_CONFIG_DIR: '/home/me/.claude-work',
    });
  });

  it('sets the terminal and session variables for a member session', () => {
    const env = buildSessionEnv(base, 'ses_42');
    expect(env).toMatchObject({
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      PROJECTMAN_SESSION_ID: 'ses_42',
    });
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('keeps loopback hosts out of the proxy, preserving existing entries', () => {
    expect(withLocalNoProxy({})).toMatchObject({
      NO_PROXY: '127.0.0.1,localhost,::1',
      no_proxy: '127.0.0.1,localhost,::1',
    });
    const env = withLocalNoProxy({ NO_PROXY: 'corp.example, localhost', no_proxy: '' });
    expect(env.NO_PROXY).toBe('corp.example,localhost,127.0.0.1,::1');
    expect(env.no_proxy).toBe('127.0.0.1,localhost,::1');
    expect(buildSessionEnv({ HTTPS_PROXY: 'http://proxy:8080' }, 's').NO_PROXY).toBe(
      '127.0.0.1,localhost,::1',
    );
  });
});
