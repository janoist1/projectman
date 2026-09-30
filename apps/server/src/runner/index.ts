import type { RunnerModule, RunnerModuleOptions } from '../contracts';
import { registerHookRoutes } from './hooks';
import { createProviderAdapters } from './providers';
import { SessionManager } from './runner';
import { createTranscriptReader } from './transcript/reader';

/**
 * Runs AI members as real, interactive agent CLI sessions in pseudo-terminals, on the
 * owner's subscription: Claude Code (Claude plan) or OpenAI Codex CLI (ChatGPT plan), each
 * behind a provider adapter (providers/):
 * - `runner`: start/stop sessions, type messages when idle, terminal passthrough and snapshots,
 *   state and chat events (driven by the CLI's hooks and the session transcript), and the
 *   login check of each provider;
 * - `registerHookRoutes`: POST /hooks/:token for the CLIs' hooks (localhost only);
 * - `transcripts`: parse a whole transcript into chat items;
 * - `planUsage` / `planUsageFor`: the account's plan usage per provider.
 *
 * The Codex CLI is `codexBin`, else $CODEX_BIN, else `codex` on PATH; its transcripts are read
 * from `codexHome`, else $CODEX_HOME, else ~/.codex. Environment variables come from `env`,
 * else `process.env`.
 *
 * Several techniques follow agent-office (MIT, https://github.com/AgentSystemLabs/agent-office):
 * hook forwarding, bracketed-paste input, headless xterm snapshots, first-run screen detection
 * and the plan usage probe. Credited where used.
 */
export function createRunnerModule(opts: RunnerModuleOptions): RunnerModule {
  const adapters = createProviderAdapters(opts);
  const runner = new SessionManager(opts, adapters);
  return {
    runner,
    transcripts: createTranscriptReader(),
    planUsage: adapters.claude.planUsage,
    planUsageFor: (provider) => adapters[provider].planUsage,
    registerHookRoutes(app) {
      registerHookRoutes(app, {
        sessionForToken: (token) => runner.sessionForToken(token),
        parse: (session, body) => session.parseHook(body),
        logger: opts.logger,
      });
    },
  };
}
