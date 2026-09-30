import type { AgentProvider } from '@projectman/shared';
import type { RunnerModuleOptions } from '../../contracts';
import { createClaudeAdapter } from './claude';
import { createCodexAdapter, defaultCodexHome } from './codex';
import type { ProviderAdapter } from './types';

export type ProviderAdapters = Record<AgentProvider, ProviderAdapter>;

/** The adapters of every provider, configured from the runner options. */
export function createProviderAdapters(opts: RunnerModuleOptions): ProviderAdapters {
  return {
    claude: createClaudeAdapter({
      bin: opts.claudeBin,
      logger: opts.logger,
      claudeConfigPath: opts.claudeConfigPath,
      trustWorkspaces: opts.trustWorkspaces,
    }),
    codex: createCodexAdapter({
      bin: opts.codexBin ?? process.env.CODEX_BIN ?? 'codex',
      codexHome: opts.codexHome ?? defaultCodexHome(),
      logger: opts.logger,
    }),
  };
}
