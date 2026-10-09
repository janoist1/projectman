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

  it('removes the Gemini and NanoGPT variables and the Antigravity markers, whatever the server has (PM-324)', () => {
    const names = [
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'GOOGLE_GEMINI_BASE_URL',
      'GOOGLE_GENAI_USE_VERTEXAI',
      'GOOGLE_GENAI_USE_ENTERPRISE',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'GOOGLE_CLOUD_PROJECT',
      'GOOGLE_CLOUD_LOCATION',
      'AGY_ADC_AUTH',
      'AGY_BUSINESS_PAYGO_TIER',
      'NANOGPT_API_KEY',
      'CODEX_ACCESS_TOKEN',
      'CODEX_APP_SERVER_LOGIN_CLIENT_ID',
      'CODEX_REFRESH_TOKEN_URL_OVERRIDE',
      'CODEX_REVOKE_TOKEN_URL_OVERRIDE',
      'CODEX_API_KEY',
      'OPENAI_API_KEY',
      'GEMINI_CLI',
      'ANTIGRAVITY_SESSION',
      'ANTIGRAVITY_CLI_ALPHA',
    ];
    const leaking = { ...base, ...Object.fromEntries(names.map((name) => [name, 'fictional'])) };
    for (const env of [buildChildEnv(leaking), buildSessionEnv(leaking, 'ses_1')])
      for (const name of names) expect(env).not.toHaveProperty(name);
    // Only a trusted `extra` brings one back (the NanoGPT adapter's, for its own members).
    expect(buildChildEnv(leaking, { NANOGPT_API_KEY: 'from-adapter' })).toMatchObject({
      NANOGPT_API_KEY: 'from-adapter',
    });
    expect(buildChildEnv(leaking)).toMatchObject({ PATH: '/usr/bin' });
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

  it('gives every member session a non-interactive editor, whatever the service environment holds (PM-428)', () => {
    const env = buildSessionEnv({ ...base, GIT_EDITOR: 'vim', EDITOR: 'vim', VISUAL: 'code -w' }, 'ses_1');
    for (const name of ['GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'EDITOR', 'VISUAL']) {
      expect(env[name], name).toBe('true');
    }
    expect(buildSessionEnv(base, 'ses_1', { managedVm: true }).GIT_EDITOR).toBe('true');
  });

  it("marks a session with the instance's tag, and drops the tag a parent instance passed on (PM-320)", () => {
    const env = buildSessionEnv({ ...base, PROJECTMAN_INSTANCE: 'parent-tag' }, 'ses_42', {
      instanceTag: '0123456789abcdef',
    });
    expect(env.PROJECTMAN_INSTANCE).toBe('0123456789abcdef');
    expect(buildSessionEnv({ ...base, PROJECTMAN_INSTANCE: 'parent-tag' }, 'ses_42')).not.toHaveProperty(
      'PROJECTMAN_INSTANCE',
    );
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

  it('keeps the service identity out of a managed VM worker, and the billing filter as it is (PM-141)', () => {
    const service = {
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      SSH_AGENT_PID: '1',
      GH_TOKEN: 'gh-secret',
      GITHUB_TOKEN: 'gh-secret',
      GIT_ASKPASS: '/bin/askpass',
    };
    const legacy = buildSessionEnv(service, 'ses_1');
    expect(legacy.SSH_AUTH_SOCK).toBe('/tmp/agent.sock');
    const managed = buildSessionEnv(service, 'ses_1', { managedVm: true });
    for (const name of ['SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'GH_TOKEN', 'GITHUB_TOKEN', 'GIT_ASKPASS']) {
      expect(managed[name], name).toBeUndefined();
    }
    expect(managed.ANTHROPIC_API_KEY).toBeUndefined();
    expect(managed).toMatchObject({ PATH: '/usr/bin', PROJECTMAN_SESSION_ID: 'ses_1' });
  });

  it('removes Codex billing variables and parent Codex session markers for every provider', () => {
    const env = buildChildEnv({
      PATH: '/usr/bin',
      CODEX_HOME: '/home/me/.codex-work',
      CODEX_API_KEY: 'sk-codex',
      OPENAI_API_KEY: 'sk-openai',
      OPENAI_BASE_URL: 'https://billing.example',
      OPENAI_API_BASE: 'https://billing.example',
      AZURE_OPENAI_API_KEY: 'fictional-key',
      AZURE_OPENAI_ENDPOINT: 'https://billing.example',
      AZURE_OPENAI_AD_TOKEN: 'fictional-token',
      CODEX_THREAD_ID: '019a0b1c-2d3e-7f40-8a5b-6c7d8e9f0a1b',
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'codex_vscode',
    });
    expect(env).toEqual({ PATH: '/usr/bin', CODEX_HOME: '/home/me/.codex-work' });
  });
});
