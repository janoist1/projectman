import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildServerPlist,
  exitTimeoutSeconds,
  installedExitTimeout,
  installedProgramArguments,
  PASSED_VARIABLES,
  xmlEscape,
} from '../../../scripts/live/plist';
import type { ServerPlistInput } from '../../../scripts/live/plist';

const server = (env: NodeJS.ProcessEnv = {}): ServerPlistInput => ({
  nodePath: '/opt/homebrew/bin/node',
  root: '/Users/me/projectman-live',
  home: '/Users/me/.projectman',
  userHome: '/Users/me',
  port: 4800,
  env: { PATH: '/opt/homebrew/bin:/usr/bin', ...env },
  logFile: '/Users/me/.projectman/logs/live.log',
});

describe('the server plist', () => {
  it('runs node on the built server, restarts it, and gives it time to stop', () => {
    const { text } = buildServerPlist(server());
    expect(text).toContain('<string>/opt/homebrew/bin/node</string>');
    expect(text).toContain('<string>/Users/me/projectman-live/apps/server/dist/index.js</string>');
    expect(text).toContain(
      '<key>WorkingDirectory</key>\n  <string>/Users/me/projectman-live/apps/server</string>',
    );
    expect(text).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(text).toMatch(/<key>ExitTimeOut<\/key>\s*<integer>90<\/integer>/);
    expect(text).not.toContain('PROJECTMAN_RELEASE_TARGET');
    expect(text).not.toContain('npm');
  });

  it('is named after its launcher, which runs node on the server (the name macOS shows)', () => {
    const program = installedProgramArguments(buildServerPlist(server()).text);
    expect(program).toEqual([
      '/Users/me/projectman-live/scripts/live/bin/projectman-live',
      '/opt/homebrew/bin/node',
      '/Users/me/projectman-live/apps/server/dist/index.js',
    ]);
    expect(installedProgramArguments('<plist/>')).toBeNull();
  });

  it('carries the allowlist from the installing shell and nothing else', () => {
    const env: NodeJS.ProcessEnv = {
      CLAUDE_BIN: '/bin/claude',
      LOG_LEVEL: 'debug',
      ANTHROPIC_API_KEY: 'x',
      OPENAI_API_KEY: 'x',
      CODEX_API_KEY: 'x',
      GEMINI_API_KEY: 'x',
      NANOGPT_API_KEY: 'x',
      PROJECTMAN_VERSION: 'v-fake',
      PROJECTMAN_INTEGRATOR_KEY: 'x',
      CF_ACCESS_CLIENT_ID: 'x',
      CF_ACCESS_CLIENT_SECRET: 'x',
      SSH_AUTH_SOCK: '/tmp/agent',
      HOST: '',
    };
    const { text, variables } = buildServerPlist(server(env));
    expect(variables.sort()).toEqual(
      ['CLAUDE_BIN', 'HOME', 'LOG_LEVEL', 'PATH', 'PORT', 'PROJECTMAN_HOME'].sort(),
    );
    for (const name of [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'CODEX_API_KEY',
      'GEMINI_API_KEY',
      'NANOGPT_API_KEY',
      'PROJECTMAN_VERSION',
      'PROJECTMAN_INTEGRATOR_KEY',
      'CF_ACCESS_CLIENT_ID',
      'CF_ACCESS_CLIENT_SECRET',
      'SSH_AUTH_SOCK',
    ])
      expect(text, name).not.toContain(name);
    for (const name of PASSED_VARIABLES) {
      expect(name).not.toMatch(/API_KEY|TOKEN|SECRET|PASSWORD|VERSION$/);
    }
  });

  it('escapes values', () => {
    const { text } = buildServerPlist(server({ CLAUDE_BIN: '/bin/a&b<c>"d"' }));
    expect(text).toContain('/bin/a&amp;b&lt;c&gt;&quot;d&quot;');
    expect(xmlEscape('&<>"')).toBe('&amp;&lt;&gt;&quot;');
  });

  it('sets the time to stop from the shutdown pause', () => {
    expect(exitTimeoutSeconds({})).toBe(90);
    expect(exitTimeoutSeconds({ PROJECTMAN_SHUTDOWN_PAUSE_MS: '120000' })).toBe(150);
    expect(exitTimeoutSeconds({ PROJECTMAN_SHUTDOWN_PAUSE_MS: '0' })).toBe(30);
    expect(() => exitTimeoutSeconds({ PROJECTMAN_SHUTDOWN_PAUSE_MS: 'soon' })).toThrow(/milliseconds/);
    expect(() => exitTimeoutSeconds({ PROJECTMAN_SHUTDOWN_PAUSE_MS: '-5' })).toThrow();
    const { text } = buildServerPlist(server({ PROJECTMAN_SHUTDOWN_PAUSE_MS: '120000' }));
    expect(installedExitTimeout(text)).toBe(150);
    expect(installedExitTimeout('<plist/>')).toBeNull();
  });

  it('refuses a hybrid installation and an empty PATH', () => {
    for (const mode of ['cloud', 'engine', 'hybrid'])
      expect(() => buildServerPlist(server({ PROJECTMAN_MODE: mode }))).toThrow(/single-mode/);
    expect(() => buildServerPlist(server({ PROJECTMAN_MODE: 'single' }))).not.toThrow();
    expect(() => buildServerPlist({ ...server(), env: {} })).toThrow(/PATH/);
  });
});
