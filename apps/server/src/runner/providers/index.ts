import type { AgentProvider } from '@projectman/shared';
import type { RunnerModuleOptions } from '../../contracts';
import { createClaudeAdapter } from './claude';
import { createCodexAdapter, defaultCodexHome } from './codex';
import { createGeminiAdapter } from './gemini';
import type { ProviderAdapter } from './types';

export type ProviderAdapters = Record<AgentProvider, ProviderAdapter>;

/**
 * The adapters of every provider, configured from the runner options; what they leave out
 * comes from the environment (`opts.env`, else `process.env`).
 */
export function createProviderAdapters(opts: RunnerModuleOptions): ProviderAdapters {
  const env = opts.env ?? process.env;
  return {
    gemini: createGeminiAdapter({
      bin: opts.geminiBin ?? env.AGY_BIN ?? 'agy',
      configDir: opts.geminiConfigDir,
      logger: opts.logger,
    }),
    claude: createClaudeAdapter({
      bin: opts.claudeBin,
      logger: opts.logger,
      claudeConfigPath: opts.claudeConfigPath,
      // Through the launcher, trust goes into the worker's own config (the runner asks for it).
      trustWorkspaces: opts.launcher ? false : opts.trustWorkspaces,
      env,
    }),
    codex: createCodexAdapter({
      bin: opts.codexBin ?? env.CODEX_BIN ?? 'codex',
      codexHome: opts.codexHome ?? defaultCodexHome(env),
      logger: opts.logger,
    }),
  };
}
