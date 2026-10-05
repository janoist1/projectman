import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { PermissionDecision, ProviderStatus } from '../../../contracts';
import { resolveCommand, runQuietly } from '../../cli';
import { DENY_DEFAULT, type HookPayload } from '../../hook-payload';
import { parseCodexLoginStatus } from '../login';
import type { ProviderAdapter, SessionTiming, TranscriptLineParser } from '../types';
import { buildCodexArgs } from './args';
import { CodexPlanUsage } from './plan-usage';
import { CodexTranscriptParser } from './transcript';

/**
 * OpenAI Codex CLI (codex-cli 0.159.1) in its interactive TUI, on the owner's ChatGPT login.
 * Command line and hooks: args.ts. Transcripts: $CODEX_HOME/sessions (transcript.ts), which
 * also carry the plan's rate limits (plan-usage.ts). Codex picks its own conversation id; the
 * runner learns it from the first hook and resumes with `codex resume <id>`.
 */

export const CODEX_TIMING: SessionTiming = {
  readySettleMs: 300,
  pasteModeGraceMs: 3_000,
  stopSettleMs: 150,
  stepDelayMs: 12,
  /** Codex treats an Enter within 120 ms of pasted input as a newline. */
  enterDelayMs: 250,
  enterRetryMs: 1_500,
  maxEnterRetries: 2,
  submitTimeoutMs: 8_000,
  /** The first prompt waits for the MCP servers and the session to start. */
  argumentSubmitTimeoutMs: 60_000,
  /** Readiness comes from the screen: look often. */
  startupCheckMs: 250,
  startupTimeoutMs: 30_000,
  stopTimeoutMs: 5_000,
  finalReadMs: 1_000,
  // Codex is not compacted (PM-213: its command was not checked); the values are not used.
  compactStartTimeoutMs: 10_000,
  compactTimeoutMs: 300_000,
  interruptConfirmMs: 5_000,
  haltStopMs: 5_000,
  turnEndGraceMs: 5_000,
};

/** Codex's question tool: it waits for an answer typed in the terminal. */
const CODEX_INPUT_TOOLS: ReadonlySet<string> = new Set(['request_user_input']);

/**
 * Codex hook payloads (command hook stdin). `transcript_path` may be null; subagent hooks
 * carry `agent_id` and the root session's id.
 */
const CodexHookPayload = z.looseObject({
  hook_event_name: z.string(),
  session_id: z.string().optional(),
  turn_id: z.string().optional(),
  transcript_path: z.string().nullish(),
  cwd: z.string().optional(),
  permission_mode: z.string().optional(),
  source: z.string().optional(),
  prompt: z.string().optional(),
  tool_name: z.string().optional(),
  tool_input: z.unknown().optional(),
  tool_use_id: z.string().optional(),
  last_assistant_message: z.string().nullish(),
  reason: z.string().optional(),
  agent_id: z.string().optional(),
  agent_type: z.string().optional(),
});

/**
 * Dialogs that block a Codex session. The composer ("› ..." above a footer such as "? for
 * shortcuts") is replaced while one is up; texts as of codex-cli 0.159.1.
 */
const CODEX_BLOCKING_SCREENS: Array<[RegExp, string]> = [
  [
    /Trust this folder\?|Do you trust the (?:files|contents)/i,
    'Workspace trust confirmation is waiting in the terminal',
  ],
  [/Sign in with ChatGPT|Not logged in|Please log in/i, 'Codex is not logged in; log in from the terminal'],
  [/Hooks need review|hooks? needs? review before/i, 'Review of Codex hooks is waiting in the terminal'],
  [
    /Codex just got an upgrade|Try new model|Introducing /i,
    'A Codex model upgrade prompt is waiting in the terminal',
  ],
  [/Update available/i, 'A Codex update prompt is waiting in the terminal'],
  [
    /Would you like to run the following command\?|Would you like to make the following edits\?|Do you want to approve network access/i,
    'A Codex approval prompt is waiting in the terminal',
  ],
  [/Press enter to continue/i, 'Codex is waiting for Enter in the terminal'],
];

/** The composer's input line ("› Ask Codex to do anything"); "› 1. ..." is a menu option. */
const COMPOSER_LINE = /^›(?:\s|$)(?!\s*\d+\.)/;
/** The footer under the composer. */
const FOOTER_LINE = /\? for shortcuts|context left|esc to interrupt|tab to queue/i;
// Custom models without context-window metadata show model, effort and directory instead.
const MODEL_FOOTER_LINE = /^\s*\S+\s+(?:low|medium|high|xhigh)\s+·\s+(?:~\/|\/)/;
const MAX_COMPOSER_LINES = 20;

/** Whether Codex's composer (input line and footer) is on screen, i.e. no dialog covers it. */
export function codexPromptVisible(text: string): boolean {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!COMPOSER_LINE.test(lines[i]!)) continue;
    for (let j = i + 1; j < lines.length && j <= i + MAX_COMPOSER_LINES; j++) {
      if (FOOTER_LINE.test(lines[j]!) || MODEL_FOOTER_LINE.test(lines[j]!)) return true;
    }
  }
  return false;
}

/** Whether Codex's screen shows a turn in progress ("Working (3s • esc to interrupt)"). */
export function codexWorkingVisible(text: string): boolean {
  return /esc to interrupt/i.test(text);
}

/** A dialog blocking Codex in `text`, or null. History above a visible composer is not a dialog. */
export function detectCodexBlockingScreen(text: string): string | null {
  if (codexPromptVisible(text)) return null;
  for (const [pattern, description] of CODEX_BLOCKING_SCREENS) if (pattern.test(text)) return description;
  return null;
}

function decisionOutput(decision: { behavior: 'allow' } | { behavior: 'deny'; message: string }) {
  // Codex rejects (fails closed on) `updatedInput` and `updatedPermissions`: never sent.
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

export function codexPermissionOutput(decision: PermissionDecision): unknown {
  if (decision.behavior === 'deny') {
    return decisionOutput({ behavior: 'deny', message: decision.message?.trim() || DENY_DEFAULT });
  }
  return decisionOutput({ behavior: 'allow' });
}

/** Codex's home: $CODEX_HOME, else ~/.codex. */
export function defaultCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

export interface CodexAdapterOptions {
  bin: string;
  codexHome: string;
  logger: FastifyBaseLogger;
}

export function createCodexAdapter(opts: CodexAdapterOptions): ProviderAdapter {
  const planUsage = new CodexPlanUsage({ codexHome: opts.codexHome, logger: opts.logger });
  return {
    provider: 'codex',
    label: 'Codex',
    bin: opts.bin,
    capabilities: {
      presetSessionId: false,
      sessionPermissionRules: false,
      readiness: 'screen',
    },
    timing: CODEX_TIMING,
    inputTools: CODEX_INPUT_TOOLS,

    async launch({ spec, hookUrl, permissionTimeoutMs }) {
      const realCwd = await realpath(spec.cwd).catch(() => spec.cwd);
      const { args, initialMessageSent } = buildCodexArgs({ spec, hookUrl, permissionTimeoutMs, realCwd });
      return { ...resolveCommand(opts.bin, args), cliArgs: args, initialMessageSent };
    },

    parseHook(body): HookPayload | null {
      const parsed = CodexHookPayload.safeParse(body);
      if (!parsed.success) return null;
      const { transcript_path, last_assistant_message, ...rest } = parsed.data;
      const payload: HookPayload = { ...rest };
      if (transcript_path) payload.transcript_path = transcript_path;
      if (last_assistant_message) payload.last_assistant_message = last_assistant_message;
      return payload;
    },
    isSubagentHook: (payload) => Boolean(payload.agent_id),
    permissionOutput: (decision) => codexPermissionOutput(decision),
    denyOutput: (message) => decisionOutput({ behavior: 'deny', message }),
    hookAuthError: () => null,
    detectBlockingScreen: detectCodexBlockingScreen,
    promptVisible: codexPromptVisible,
    workingVisible: codexWorkingVisible,
    createTranscriptParser(parserOpts): TranscriptLineParser {
      return new CodexTranscriptParser(parserOpts);
    },

    async checkLogin(env): Promise<ProviderStatus> {
      return parseCodexLoginStatus(await runQuietly(opts.bin, ['login', 'status'], env));
    },
    loginCommand: ['login', 'status'],
    parseLogin: (out) => parseCodexLoginStatus(out),
    planUsage,
    noteTranscript: (file) => planUsage.noteTranscript(file),
  };
}
