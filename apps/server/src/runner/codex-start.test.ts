import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { StartSessionSpec } from '../contracts';
import { createRunnerModule } from './index';
import { createCodexAdapter } from './providers/codex';
import { FAKE_CLAUDE, FAKE_CODEX, silentLogger, tempDirs } from './test-helpers';

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

async function fixture(version = '0.159.1') {
  const cwd = await dirs.make();
  const home = await dirs.make();
  const user = path.join(home, 'config.toml');
  const options = {
    claudeBin: FAKE_CLAUDE,
    codexBin: FAKE_CODEX,
    codexHome: home,
    env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, FAKE_CODEX_VERSION: version },
    ambientConfig: { codexUser: user, codexManaged: [] },
    publicBaseUrl: 'http://127.0.0.1:1',
    permissionTimeoutMs: 1_000,
    broker: { decide: async () => ({ behavior: 'deny' as const }) },
    logger: silentLogger(),
    terminal: 'pipe' as const,
  };
  const spec: StartSessionSpec = {
    sessionId: `ses_${randomUUID()}`,
    claudeSessionId: randomUUID(),
    provider: 'codex',
    resume: false,
    cwd,
    member: 'codex',
    displayName: 'Fictional developer',
    appendSystemPrompt: '',
    allowedTools: [],
    mcpUrl: 'http://127.0.0.1:1/mcp/fictional',
  };
  return { cwd, home, user, options, spec };
}

describe('fail-closed Codex start', () => {
  it.each(['0.159.0', '0.0.0', 'invalid'])(
    'refuses CLI version %s before spawning a session',
    async (version) => {
      const { options, spec } = await fixture(version);
      const runner = createRunnerModule(options).runner;
      await expect(runner.start(spec)).rejects.toMatchObject({
        code: 'codex_setup_incomplete',
        details: {
          provider: 'codex',
          problem: version === 'invalid' ? 'cli_missing' : 'cli_too_old',
          minCliVersion: '0.159.1',
        },
      });
      expect(runner.list()).toEqual([]);
      await runner.shutdown();
    },
  );

  it('refuses a missing CLI with the structured setup error', async () => {
    const { options, spec, home } = await fixture();
    const runner = createRunnerModule({ ...options, codexBin: path.join(home, 'missing-cli') }).runner;
    await expect(runner.start(spec)).rejects.toMatchObject({
      code: 'codex_setup_incomplete',
      details: { problem: 'cli_missing' },
    });
    await runner.shutdown();
  });

  it('refuses workspace sandbox configuration without disclosing its value', async () => {
    const { options, spec, cwd } = await fixture();
    await mkdir(path.join(cwd, '.codex'));
    const file = path.join(cwd, '.codex', 'config.toml');
    await writeFile(file, 'sandbox_mode = "fictional-private-value"');
    const runner = createRunnerModule(options).runner;
    await expect(runner.start(spec)).rejects.toMatchObject({
      code: 'codex_setup_incomplete',
      details: {
        provider: 'codex',
        problem: 'sandbox_config',
        ambientConfig: [{ file, keys: ['sandbox_mode'] }],
      },
    });
    expect(runner.list()).toEqual([]);
    await runner.shutdown();
  });

  it('refuses an ambiguous user MCP server before spawning', async () => {
    const { options, spec, user } = await fixture();
    await writeFile(user, '[mcp_servers."quoted.name"]\ncommand = "fictional-private-value"');
    const runner = createRunnerModule(options).runner;
    await expect(runner.start(spec)).rejects.toMatchObject({
      code: 'codex_setup_incomplete',
      details: {
        provider: 'codex',
        problem: 'mcp_config',
        ambientConfig: [{ file: user, keys: ['mcp_servers'] }],
      },
    });
    expect(runner.list()).toEqual([]);
    await runner.shutdown();
  });

  it('renders disables from the same Codex home the adapter uses', async () => {
    const { options, spec, user } = await fixture();
    await writeFile(user, '[mcp_servers.node_repl]\ncommand = "fictional"');
    const adapter = createCodexAdapter({ ...options, bin: FAKE_CODEX });
    const command = await adapter.launch({
      spec,
      hookUrl: 'http://127.0.0.1:1/hooks/fictional',
      permissionTimeoutMs: 1_000,
    });
    expect(command.cliArgs).toContain('mcp_servers.node_repl.enabled=false');
  });
});
