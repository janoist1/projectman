import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PermissionBroker, RunnerModuleOptions, StartSessionSpec } from '../../contracts';
import { silentLogger, tempDirs } from '../test-helpers';
import { createProviderAdapters } from './index';

const broker: PermissionBroker = { decide: async () => ({ behavior: 'deny' }) };
const base: RunnerModuleOptions = {
  claudeBin: 'claude',
  publicBaseUrl: 'http://127.0.0.1:4700',
  broker,
  permissionTimeoutMs: 1000,
  logger: silentLogger(),
};

const temp = tempDirs();
afterEach(() => temp.cleanup());

describe('createProviderAdapters', () => {
  it('reads the Codex CLI from the given environment unless an option names it', () => {
    expect(createProviderAdapters({ ...base, env: {} }).codex.bin).toBe('codex');
    expect(createProviderAdapters({ ...base, env: { CODEX_BIN: '/opt/codex' } }).codex.bin).toBe(
      '/opt/codex',
    );
    expect(
      createProviderAdapters({ ...base, env: { CODEX_BIN: '/opt/codex' }, codexBin: '/usr/local/codex' })
        .codex.bin,
    ).toBe('/usr/local/codex');
  });

  it("records workspace trust in the given environment's CLAUDE_CONFIG_DIR", async () => {
    const configDir = await temp.make('pm-claude-config-');
    const cwd = await temp.make('pm-claude-cwd-');
    await writeFile(path.join(configDir, '.claude.json'), '{}');
    const adapters = createProviderAdapters({ ...base, env: { CLAUDE_CONFIG_DIR: configDir } });
    const spec: StartSessionSpec = {
      sessionId: 'ses_1',
      claudeSessionId: '0b8a3c2e-1f5d-4c4e-9a7b-2d6e8f1a3b5c',
      resume: false,
      cwd,
      displayName: 'Anna · fe-1',
      appendSystemPrompt: '',
      mcpUrl: 'http://127.0.0.1:4700/mcp/tok',
      allowedTools: [],
    };
    await adapters.claude.launch({
      spec,
      hookUrl: 'http://127.0.0.1:4700/hooks/t',
      permissionTimeoutMs: 1000,
    });
    const config = JSON.parse(await readFile(path.join(configDir, '.claude.json'), 'utf8'));
    expect(config.projects[cwd].hasTrustDialogAccepted).toBe(true);
  });
});
