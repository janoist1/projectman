import type { RunnerModule, RunnerModuleOptions } from '../contracts';
import { registerHookRoutes } from './hooks';
import { createPlanUsageProvider } from './plan-usage';
import { SessionManager } from './runner';
import { createTranscriptReader } from './transcript/reader';

/**
 * Runs AI members as real, interactive Claude Code sessions in pseudo-terminals, on the
 * owner's Claude subscription:
 * - `runner`: start/stop sessions, type messages when idle, terminal passthrough and snapshots,
 *   state and chat events (driven by Claude Code hooks and the session transcript);
 * - `registerHookRoutes`: POST /hooks/:token for Claude Code's hooks (localhost only);
 * - `transcripts`: parse a whole transcript into chat items;
 * - `planUsage`: the account's 5-hour and weekly plan usage.
 *
 * Several techniques follow agent-office (MIT, https://github.com/AgentSystemLabs/agent-office):
 * hook forwarding, bracketed-paste input, headless xterm snapshots, first-run screen detection
 * and the plan usage probe. Credited where used.
 */
export function createRunnerModule(opts: RunnerModuleOptions): RunnerModule {
  const runner = new SessionManager(opts);
  return {
    runner,
    transcripts: createTranscriptReader(),
    planUsage: createPlanUsageProvider({ claudeBin: opts.claudeBin, logger: opts.logger }),
    registerHookRoutes(app) {
      registerHookRoutes(app, {
        sessionForToken: (token) => runner.sessionForToken(token),
        logger: opts.logger,
      });
    },
  };
}

export { SessionManager } from './runner';
export { parseTranscript, TranscriptParser } from './transcript/parser';
export { defaultClaudeConfigPath } from './trust';
