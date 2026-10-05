import type { AgentProvider } from '@projectman/shared';
import type { RunnerModuleOptions } from '../../contracts';
import { createClaudeAdapter } from './claude';
import { createCodexAdapter, defaultCodexHome } from './codex';
import { createNanogptAdapter } from './nanogpt';
import path from 'node:path';
import type { ProviderAdapter } from './types';

export type ProviderAdapters = Record<AgentProvider, ProviderAdapter>;

/**
 * The adapters of every provider, configured from the runner options; what they leave out
 * comes from the environment (`opts.env`, else `process.env`).
 */
export function createProviderAdapters(opts: RunnerModuleOptions): ProviderAdapters {
  const env = opts.env ?? process.env;
  return {
    nanogpt: createNanogptAdapter({
      bin: opts.codexBin ?? env.CODEX_BIN ?? 'codex',
      codexHome:
        opts.nanogptCodexHome ??
        path.join(path.dirname(opts.codexHome ?? defaultCodexHome(env)), 'projectman-nanogpt-codex-home'),
      nanogptKey: opts.nanogptKey ?? (async () => null),
      ambientConfig: opts.ambientConfig,
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
