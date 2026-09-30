import type { FastifyBaseLogger } from 'fastify';
import type { ProviderStatus } from '../../../contracts';
import { resolveCommand, runQuietly } from '../../cli';
import { parseClaudeAuthStatus } from '../login';
import type { ProviderAdapter, SessionTiming, TranscriptLineParser } from '../types';
import { buildClaudeArgs, buildSettings } from './args';
import { ClaudeHookPayload, denyOutput, permissionOutput } from './permissions';
import { createPlanUsageProvider } from './plan-usage';
import { TranscriptParser } from './transcript';
import { defaultClaudeConfigPath, ensureWorkspaceTrusted } from './trust';

/**
 * Claude Code: `--session-id`/`--resume`, `--append-system-prompt`, `--mcp-config` and inline
 * `--settings` with HTTP hooks (args.ts), permission answers that can remember an "allow for
 * this session" (permissions.ts), workspace trust pre-accepted in its global config
 * (trust.ts), transcripts under ~/.claude/projects (transcript.ts), plan usage from a
 * `get_usage` probe (plan-usage.ts).
 */

/** Timing of the interaction with Claude Code's TUI. */
export const CLAUDE_TIMING: SessionTiming = {
  readySettleMs: 400,
  pasteModeGraceMs: 3_000,
  stopSettleMs: 150,
  stepDelayMs: 12,
  /** agent-office uses 120 ms. */
  enterDelayMs: 120,
  enterRetryMs: 1_500,
  maxEnterRetries: 2,
  submitTimeoutMs: 8_000,
  argumentSubmitTimeoutMs: 30_000,
  startupCheckMs: 1_000,
  startupTimeoutMs: 20_000,
  stopTimeoutMs: 5_000,
  finalReadMs: 1_000,
};

/** Claude Code's question tool: it waits for an answer typed in the terminal. */
const CLAUDE_INPUT_TOOLS: ReadonlySet<string> = new Set(['AskUserQuestion']);

/**
 * Dialogs that block a session: first-run screens before it can take input, and prompts that
 * can appear around start-up (approving a project's MCP servers). Texts as of Claude Code
 * 2.1.223; the first patterns follow agent-office (MIT, src/server/workers.ts).
 */
const BLOCKING_SCREENS: Array<[RegExp, string]> = [
  [
    /Quick safety check|trust this folder|Do you trust the files/i,
    'Workspace trust confirmation is waiting in the terminal',
  ],
  [
    /Select login method|Not logged in|Please run \/login/i,
    'Claude Code is not logged in; log in from the terminal',
  ],
  [/Choose the text style/i, 'Claude Code first-run setup is waiting in the terminal'],
  [/Bypass Permissions mode/i, 'Bypass permissions confirmation is waiting in the terminal'],
  [/MCP servers? found in this project/i, 'Approval of project MCP servers is waiting in the terminal'],
  [/Do you want to use this API key/i, 'API key confirmation is waiting in the terminal'],
  [/Press Enter to continue/i, 'Claude Code is waiting for Enter in the terminal'],
];

/** A horizontal rule of the prompt box, possibly with a label: "────── Anna · AR-1 ──". */
const RULE_LINE = /^\s*[╭╰]?[─━]{3,}(?:.*[─━]{2,})?[╮╯]?\s*$/;
/** The input line of the prompt box ("❯ ", "> ", or "│ > " in older versions); not a menu option. */
const INPUT_LINE = /^\s*│?\s*[❯>](?:\s|$)(?!\s*\d+\.)/;
/** A multi-line input or a wrapped rule ends the box within this many lines. */
const MAX_BOX_LINES = 30;

/**
 * Whether Claude Code's prompt box (an input line between two horizontal rules) is on
 * screen. Dialogs replace the prompt box, so while it is visible nothing blocks the session;
 * text above it is conversation history (which may quote a dialog's words).
 */
export function claudePromptVisible(text: string): boolean {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 1; i--) {
    if (!INPUT_LINE.test(lines[i]!) || !RULE_LINE.test(lines[i - 1]!)) continue;
    for (let j = i + 1; j < lines.length && j <= i + MAX_BOX_LINES; j++) {
      if (RULE_LINE.test(lines[j]!)) return true;
    }
  }
  return false;
}

/** A dialog blocking Claude Code in `text` (the end of the screen content), or null. */
export function detectBlockingScreen(text: string): string | null {
  if (claudePromptVisible(text)) return null;
  for (const [pattern, description] of BLOCKING_SCREENS) if (pattern.test(text)) return description;
  return null;
}

/**
 * A lost login, as Claude Code reports it in the conversation: "Login expired · Please run
 * /login", "Not logged in · Please run /login", "OAuth token has expired", ...
 */
export const CLAUDE_AUTH_ERROR =
  /Please run \/login|Login expired|Not logged in|OAuth token (?:has )?(?:expired|been revoked)|authentication_failed/i;

/** Claude Code's transcript parser, plus the login failures it records as error messages. */
function claudeTranscriptParser(opts: {
  self: string | null;
  cwd: string | null;
  firstUserOrigin?: 'brief' | 'human';
}): TranscriptLineParser {
  const parser = new TranscriptParser(opts);
  return {
    parseLines(lines) {
      const result = parser.parseLines(lines);
      const failure = result.items.find(
        (item) => item.kind === 'system_note' && CLAUDE_AUTH_ERROR.test(item.text),
      );
      return failure && failure.kind === 'system_note' ? { ...result, authError: failure.text } : result;
    },
  };
}

export interface ClaudeAdapterOptions {
  bin: string;
  logger: FastifyBaseLogger;
  claudeConfigPath?: string;
  trustWorkspaces?: boolean;
}

export function createClaudeAdapter(opts: ClaudeAdapterOptions): ProviderAdapter {
  const log = opts.logger;
  const trust = async (cwd: string): Promise<void> => {
    if (opts.trustWorkspaces === false) return;
    const configPath = opts.claudeConfigPath ?? defaultClaudeConfigPath();
    try {
      const outcome = await ensureWorkspaceTrusted(configPath, cwd);
      if (outcome.result === 'trusted')
        log.info({ key: outcome.key }, 'pre-accepted Claude Code workspace trust');
      else if (outcome.result === 'skipped') {
        log.warn({ key: outcome.key, reason: outcome.reason }, 'could not pre-accept workspace trust');
      }
    } catch (err) {
      log.warn({ err, cwd }, 'could not pre-accept workspace trust');
    }
  };

  return {
    provider: 'claude',
    label: 'Claude Code',
    bin: opts.bin,
    capabilities: {
      presetSessionId: true,
      sessionPermissionRules: true,
      readiness: 'session_start',
    },
    timing: CLAUDE_TIMING,
    inputTools: CLAUDE_INPUT_TOOLS,

    async launch({ spec, hookUrl, permissionTimeoutMs }) {
      await trust(spec.cwd);
      const settings = buildSettings({
        hookUrl,
        allowedTools: spec.allowedTools,
        deniedTools: spec.deniedTools,
        permissionTimeoutMs,
      });
      const command = resolveCommand(opts.bin, buildClaudeArgs(spec, settings));
      return { ...command, initialMessageSent: false };
    },

    parseHook(body) {
      const parsed = ClaudeHookPayload.safeParse(body);
      return parsed.success ? parsed.data : null;
    },
    // Unchanged behaviour: Claude Code's subagent hooks count for the session like any other.
    isSubagentHook: () => false,
    permissionOutput,
    denyOutput,
    hookAuthError(payload) {
      if (payload.hook_event_name !== 'StopFailure') return null;
      const error = typeof payload.error === 'string' ? payload.error : null;
      return error && CLAUDE_AUTH_ERROR.test(error) ? `Claude Code lost its login: ${error}` : null;
    },
    detectBlockingScreen,
    promptVisible: claudePromptVisible,
    createTranscriptParser: claudeTranscriptParser,

    async checkLogin(env): Promise<ProviderStatus> {
      return parseClaudeAuthStatus(await runQuietly(opts.bin, ['auth', 'status'], env));
    },
    planUsage: createPlanUsageProvider({ claudeBin: opts.bin, logger: log }),
  };
}
