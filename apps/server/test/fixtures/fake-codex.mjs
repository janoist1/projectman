#!/usr/bin/env node
/**
 * fake-codex — a deterministic stand-in for the interactive OpenAI Codex CLI (codex-cli
 * 0.159.1), for automated tests. It never calls any API and never reads ~/.codex. It speaks
 * the parts of the protocol projectman relies on:
 *
 * COMMAND LINE: `[resume] [OPTIONS] [--] [SESSION_ID (resume only)] [PROMPT]`, `login status`,
 *   `--version`, `--help`. Options: -c/--config key=value (repeatable; the value is parsed as
 *   TOML, falling back to the raw string, and the key is split on every "." like Codex does),
 *   -m/--model, -s/--sandbox, -a/--ask-for-approval, --enable/--disable <feature>,
 *   --no-alt-screen, --no-daemon, --dangerously-bypass-hook-trust. Others are accepted.
 *   Only -c overrides configure it (there is no config.toml).
 *
 * HOME: $CODEX_HOME (default <os tmp>/fake-codex-home). Transcripts ("rollouts") go to
 *   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<YYYY-MM-DDTHH-MM-SS>-<session id>.jsonl, one
 *   `{timestamp, type, payload}` line each (session_meta, turn_context, response_item,
 *   event_msg), written from the first turn on. The session id is chosen here (it cannot be
 *   preset); `resume <id>` appends to that rollout, or prints "No saved session found with ID
 *   <id>" and exits with code 1. A resumed session shows the conversation so far above the
 *   composer (each user message as "› text", each answer and tool call as "• text").
 *
 * LOGIN: `login status` prints "Logged in using ChatGPT" on stderr (exit 0); with
 *   FAKE_CODEX_LOGGED_OUT set, "Not logged in" (exit 1); FAKE_CODEX_AUTH=api_key prints
 *   "Logged in using an API key - sk-fake***". Logged out, the TUI shows "Sign in with
 *   ChatGPT" and waits.
 *
 * START-UP (a PTY): enables bracketed paste, prints a banner, then, in this order:
 * - a trust screen ("Trust this folder? ...") unless
 *   projects[<realpath cwd>].trust_level is set: Enter or "1" trusts, "2" or Esc exits 1;
 * - a hooks review ("Hooks need review") when hooks are configured without
 *   --dangerously-bypass-hook-trust: any key continues, and those hooks never run;
 * - after FAKE_CODEX_STARTUP_DELAY_MS (default 50) the history of a resumed session, then the
 *   composer: "› Ask Codex to do anything" above a footer "? for shortcuts ... 100% context
 *   left". FAKE_CODEX_MODEL_FOOTER uses the model/effort/directory footer from the owner's
 *   NanoGPT 0.159.1 screen instead, with three warnings and no context metadata.
 *   A PROMPT argument is submitted right away. SessionStart only fires with that first
 *   turn, so a resumed session that is given no prompt reports nothing until someone types.
 *
 * HOOKS (`hooks.<Event> = [{hooks = [{type = "command", command, timeout}]}]`): run with
 *   `/bin/sh -c`, the payload on stdin (session_id, turn_id, transcript_path, cwd,
 *   hook_event_name, model, permission_mode, plus event fields). SessionStart runs with the
 *   first turn of the process (source "startup", "resume" or "clear" after /new), not at
 *   launch. Events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
 *   PermissionRequest, Stop, Interrupt, SessionEnd. A PermissionRequest answer on stdout
 *   `{"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior":
 *   "allow" | "deny", "message"?}}}` decides; one with `updatedInput` or `updatedPermissions`
 *   is invalid (Codex fails closed), and without a decision the terminal asks (y/n).
 *
 * INPUT (raw mode): bracketed pastes are inserted (more than 1000 characters become
 *   "[Pasted Content N chars]", expanded on submit); Ctrl+J inserts a newline; Enter submits,
 *   except within 120 ms of a paste, where it inserts a newline (Codex's paste-burst guard);
 *   a composer starting with "!" runs a shell command (" !x" is sent literally, trimmed); Esc
 *   interrupts a turn (turn_aborted, the
 *   Interrupt hook, no Stop); Ctrl+C clears / interrupts / exits (twice); Ctrl+D on an empty
 *   composer, /exit, SIGTERM and SIGHUP exit with the SessionEnd hook (code 0); /new starts a
 *   new session id and rollout.
 *
 * A TURN: UserPromptSubmit (a "block" decision drops it), the user message, then after
 *   FAKE_CODEX_WORK_DELAY_MS (default 50; 800 if the prompt contains "SLOW"):
 *   - "PERMISSION": exec_command `git push`, which needs network: PreToolUse (tool "Bash"),
 *     then unless the approval policy is "never" a PermissionRequest (tool_input {command,
 *     description}); allowed -> output "Everything up-to-date", PostToolUse; denied ->
 *     "rejected by user: <message>".
 *   - "EDIT": apply_patch adding notes.txt: automatic in a workspace-write sandbox, else asked
 *     like a command (tool "apply_patch", tool_input {command: <patch>}).
 *   - "LONGTOOL": exec_command `sleep 60` (tool "Bash"), which takes FAKE_CODEX_TOOL_MS (default 1000)
 *     before its output and PostToolUse; then the next model request takes FAKE_CODEX_MODEL_MS
 *     (default 500), where an Esc ends the turn like after any tool (PM-218).
 *   - "TEAM": the MCP tool mcp__team__send_message {to: ["qa"], text: "Ready for review"};
 *     asked unless mcp_servers.team approves it (default_tools_approval_mode or
 *     tools.send_message.approval_mode = "approve").
 *   - "ASK": request_user_input with PreToolUse, then waits for a key in the terminal.
 *   - "SUBAGENT": a subagent's PreToolUse and Stop hooks (with agent_id) mid-turn.
 *   - "EXPIRE" (or any prompt while FAKE_CODEX_LOGGED_OUT is set): the turn fails with the
 *     refresh-token error (codex_error_info "unauthorized"); no Stop hook.
 *   - "EMPTY_FAILURE": task_complete with an error and no assistant message or Stop hook.
 *   - always: the answer "Echo: <first line of the prompt>", a token_count event with the plan
 *     rate limits (FAKE_CODEX_RATE_LIMITS = JSON, or canned ones) and the token usage (the
 *     turn's `last_token_usage`: input 10 of which 4 cached, output 5 of which 2 reasoning; and
 *     the running `total_token_usage`), the same event once more, task_complete, then Stop.
 *
 * VERSION: `--version` prints `codex-cli <FAKE_CODEX_VERSION, else 0.159.1>`. FAKE_CODEX_FORCE_APPROVAL
 *   makes a command that needs escalation ask even where the policy says it never does (a
 *   sandbox of danger-full-access, an approval policy of never): a request that arrives where
 *   none is expected.
 *
 * DIAGNOSTICS: FAKE_CODEX_ARGS_FILE, when set, receives {argv, cwd, env, config} at start-up
 *   (`config` = the parsed -c overrides; env values of names containing KEY, TOKEN or SECRET
 *   are "<set>").
 *
 * The terminal input, dialogs, command hooks and exit sequence shared with fake-claude live in
 * fake-tui.mjs.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  awaitTrust,
  createKeyWaiter,
  createPasteStore,
  exitOnSignals,
  line,
  out,
  readTerminalInput,
  runCommandHook,
  sleep,
  writeArgsFile,
} from './fake-tui.mjs';

const VERSION = process.env.FAKE_CODEX_VERSION ?? '0.159.1';

// ------------------------------------------------------------------ TOML values (for -c)

/** Parses one TOML value: strings, numbers, booleans, arrays and inline tables. */
function parseTomlValue(text) {
  const s = text.trim();
  let i = 0;
  const fail = (what) => {
    throw new Error(`${what} at ${i}`);
  };
  const ws = () => {
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  };
  function basicString() {
    i++;
    let out = '';
    while (i < s.length) {
      const ch = s[i++];
      if (ch === '"') return out;
      if (ch === '\\') {
        const e = s[i++];
        if (e === 'n') out += '\n';
        else if (e === 't') out += '\t';
        else if (e === 'r') out += '\r';
        else if (e === 'b') out += '\b';
        else if (e === 'f') out += '\f';
        else if (e === '"') out += '"';
        else if (e === '\\') out += '\\';
        else if (e === 'u' || e === 'U') {
          const len = e === 'u' ? 4 : 8;
          const hex = s.slice(i, i + len);
          if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) fail('bad unicode escape');
          out += String.fromCodePoint(parseInt(hex, 16));
          i += len;
        } else fail(`bad escape \\${e}`);
        continue;
      }
      const code = ch.charCodeAt(0);
      if ((code < 0x20 && ch !== '\t') || code === 0x7f) fail('control character in a string');
      out += ch;
    }
    return fail('unterminated string');
  }
  function literalString() {
    i++;
    const end = s.indexOf("'", i);
    if (end < 0) fail('unterminated literal string');
    const out = s.slice(i, end);
    i = end + 1;
    return out;
  }
  function key() {
    ws();
    if (s[i] === '"') return basicString();
    if (s[i] === "'") return literalString();
    const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
    if (!m) fail('bad key');
    i += m[0].length;
    return m[0];
  }
  function value() {
    ws();
    const ch = s[i];
    if (ch === '"') return basicString();
    if (ch === "'") return literalString();
    if (ch === '[') {
      i++;
      const out = [];
      for (;;) {
        ws();
        if (s[i] === ']') {
          i++;
          return out;
        }
        out.push(value());
        ws();
        if (s[i] === ',') i++;
        else if (s[i] !== ']') fail('expected , or ]');
      }
    }
    if (ch === '{') {
      i++;
      const out = {};
      ws();
      if (s[i] === '}') {
        i++;
        return out;
      }
      for (;;) {
        const k = key();
        ws();
        if (s[i] !== '=') fail('expected =');
        i++;
        out[k] = value();
        ws();
        if (s[i] === ',') {
          i++;
          continue;
        }
        if (s[i] === '}') {
          i++;
          return out;
        }
        fail('expected , or }');
      }
    }
    if (s.startsWith('true', i)) {
      i += 4;
      return true;
    }
    if (s.startsWith('false', i)) {
      i += 5;
      return false;
    }
    const m = /^[+-]?\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(s.slice(i));
    if (m) {
      i += m[0].length;
      return Number(m[0].replace(/_/g, ''));
    }
    return fail('unexpected character');
  }
  const v = value();
  ws();
  if (i !== s.length) fail('trailing characters');
  return v;
}

/** Applies one -c override like Codex: the key is split on every ".". */
function applyOverride(config, raw) {
  const eq = raw.indexOf('=');
  if (eq < 0) throw new Error(`Invalid override (missing '='): ${raw}`);
  const key = raw.slice(0, eq).trim();
  const text = raw.slice(eq + 1).trim();
  let value;
  try {
    value = parseTomlValue(text);
  } catch {
    value = text.replace(/^["']|["']$/g, '');
  }
  const segments = key.split('.');
  let node = config;
  for (const segment of segments.slice(0, -1)) {
    if (!node[segment] || typeof node[segment] !== 'object' || Array.isArray(node[segment]))
      node[segment] = {};
    node = node[segment];
  }
  node[segments.at(-1)] = value;
}

// ------------------------------------------------------------------ arguments

function parseArgs(argv) {
  const o = {
    subcommand: null,
    overrides: [],
    model: null,
    sandbox: null,
    approval: null,
    enable: [],
    disable: [],
    bypassHookTrust: false,
    version: false,
    help: false,
    positional: [],
  };
  let i = 0;
  if (argv[0] === 'resume' || argv[0] === 'login') o.subcommand = argv[i++];
  for (; i < argv.length; i++) {
    let arg = argv[i];
    let inline;
    if (arg.startsWith('--') && arg.includes('=')) {
      inline = arg.slice(arg.indexOf('=') + 1);
      arg = arg.slice(0, arg.indexOf('='));
    }
    const value = () => (inline !== undefined ? inline : argv[++i]);
    switch (arg) {
      case '--':
        o.positional.push(...argv.slice(i + 1));
        i = argv.length;
        break;
      case '-c':
      case '--config':
        o.overrides.push(value());
        break;
      case '-m':
      case '--model':
        o.model = value();
        break;
      case '-s':
      case '--sandbox':
        o.sandbox = value();
        break;
      case '-a':
      case '--ask-for-approval':
        o.approval = value();
        break;
      case '--enable':
        o.enable.push(value());
        break;
      case '--disable':
        o.disable.push(value());
        break;
      case '-C':
      case '--cd':
      case '-p':
      case '--profile':
      case '-i':
      case '--image':
        value();
        break;
      case '--dangerously-bypass-hook-trust':
        o.bypassHookTrust = true;
        break;
      case '-V':
      case '--version':
        o.version = true;
        break;
      case '-h':
      case '--help':
        o.help = true;
        break;
      default:
        if (!arg.startsWith('-')) o.positional.push(arg);
        break; // other flags are accepted and ignored
    }
  }
  return o;
}

const opts = parseArgs(process.argv.slice(2));
const config = {};
for (const raw of opts.overrides) {
  try {
    applyOverride(config, raw);
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(2);
  }
}
for (const feature of opts.enable) applyOverride(config, `features.${feature}=true`);
for (const feature of opts.disable) applyOverride(config, `features.${feature}=false`);

const codexHome = process.env.CODEX_HOME || path.join(os.tmpdir(), 'fake-codex-home');

if (process.env.FAKE_CODEX_ARGS_FILE)
  writeArgsFile(process.env.FAKE_CODEX_ARGS_FILE, { config, envNames: Object.keys(process.env).sort() });

if (opts.version) {
  process.stdout.write(`codex-cli ${process.env.FAKE_CODEX_VERSION ?? VERSION}\n`);
  process.exit(0);
}
if (opts.help) {
  process.stdout.write('Usage: fake-codex [OPTIONS] [PROMPT]\nA test double for the Codex CLI.\n');
  process.exit(0);
}
if (opts.subcommand === 'login') {
  if (opts.positional[0] !== 'status') {
    process.stderr.write('fake-codex: only `login status` is supported\n');
    process.exit(2);
  }
  if (process.env.FAKE_CODEX_LOGGED_OUT) {
    process.stderr.write('Not logged in\n');
    process.exit(1);
  }
  if (process.env.FAKE_CODEX_AUTH === 'api_key')
    process.stderr.write('Logged in using an API key - sk-fake***\n');
  else process.stderr.write('Logged in using ChatGPT\n');
  process.exit(0);
}

await interactive();

// ------------------------------------------------------------------ interactive mode

function findRollout(sessionsDir, id) {
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = walk(full);
        if (found) return found;
      } else if (entry.name.startsWith('rollout-') && entry.name.endsWith(`-${id}.jsonl`)) return full;
    }
    return null;
  };
  return walk(sessionsDir);
}

/**
 * Prints the conversation of a resumed session, as Codex shows it above the composer: each user
 * message as "› text" (a message's later lines indented), each answer as "• text", each tool call
 * as "• name", a blank line between turns. What Codex itself put into the conversation (the
 * developer instructions, the environment context, shell commands) stays out.
 */
function replayHistory(rolloutPath) {
  let lines;
  try {
    lines = readFileSync(rolloutPath, 'utf8').split('\n');
  } catch {
    return;
  }
  for (const raw of lines) {
    let payload;
    try {
      const entry = JSON.parse(raw);
      if (entry.type !== 'response_item') continue;
      payload = entry.payload;
    } catch {
      continue;
    }
    if (payload?.type === 'function_call' || payload?.type === 'custom_tool_call') {
      line(`• ${payload.name}`);
      continue;
    }
    if (payload?.type !== 'message' || (payload.role !== 'user' && payload.role !== 'assistant')) continue;
    const text = (payload.content ?? [])
      .map((part) => part.text ?? '')
      .join('\n')
      .trim();
    if (!text || /^<(environment_context|user_shell_command)>/.test(text)) continue;
    if (payload.role === 'user') line();
    line(`${payload.role === 'user' ? '›' : '•'} ${text.replace(/\n/g, '\r\n  ')}`);
  }
  line();
}

function newRolloutPath(sessionsDir, id) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const day = path.join(
    sessionsDir,
    String(now.getUTCFullYear()),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
  );
  const stamp = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}T${pad(now.getUTCHours())}-${pad(now.getUTCMinutes())}-${pad(now.getUTCSeconds())}`;
  return { dir: day, file: path.join(day, `rollout-${stamp}-${id}.jsonl`) };
}

async function interactive() {
  const cwd = process.cwd();
  let realCwd = cwd;
  try {
    realCwd = realpathSync(cwd);
  } catch {
    // keep cwd
  }
  const sessionsDir = path.join(codexHome, 'sessions');
  const resumeId = opts.subcommand === 'resume' ? (opts.positional[0] ?? null) : null;
  const firstPrompt = (opts.subcommand === 'resume' ? opts.positional[1] : opts.positional[0]) ?? null;
  const model = opts.model ?? config.model ?? 'gpt-fake';
  const profileName = config.default_permissions;
  const profile = typeof profileName === 'string' ? config.permissions?.[profileName] : undefined;
  const hasWrite = (value) =>
    value === 'write' || (value && typeof value === 'object' && Object.values(value).some(hasWrite));
  const legacy =
    opts.sandbox !== null ||
    config.sandbox_mode !== undefined ||
    config.sandbox_workspace_write !== undefined;
  if (profile && legacy)
    process.stderr.write('Warning: legacy sandbox settings override the permission profile\n');
  const sandbox = legacy
    ? (opts.sandbox ?? config.sandbox_mode ?? 'workspace-write')
    : profile && hasWrite(profile.filesystem)
      ? 'workspace-write'
      : 'read-only';
  const approval = opts.approval ?? config.approval_policy ?? 'on-request';
  const permissionMode = approval === 'never' ? 'bypassPermissions' : 'default';
  const workDelay = Number(process.env.FAKE_CODEX_WORK_DELAY_MS ?? 50);

  let sessionId;
  let rolloutPath = null;
  let rolloutStarted = false;
  let sessionStartSource;
  if (resumeId) {
    const found = findRollout(sessionsDir, resumeId);
    if (!found) {
      line(`No saved session found with ID ${resumeId}`);
      process.exit(1);
    }
    sessionId = resumeId;
    rolloutPath = found;
    rolloutStarted = true;
    sessionStartSource = 'resume';
  } else {
    sessionId = randomUUID();
    sessionStartSource = 'startup';
  }
  let sessionStartPending = true;

  // --- rollout
  function writeLine(type, payload) {
    if (!rolloutPath) rolloutPath = newRolloutPath(sessionsDir, sessionId).file;
    mkdirSync(path.dirname(rolloutPath), { recursive: true });
    appendFileSync(
      rolloutPath,
      `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload })}\n`,
    );
  }
  const responseItem = (payload) => writeLine('response_item', payload);
  const eventMsg = (payload) => writeLine('event_msg', payload);
  function ensureRollout() {
    if (rolloutStarted) return;
    rolloutStarted = true;
    writeLine('session_meta', {
      id: sessionId,
      timestamp: new Date().toISOString(),
      cwd,
      originator: 'codex_cli_rs',
      cli_version: VERSION,
      source: 'cli',
      model_provider: 'openai',
    });
    if (typeof config.developer_instructions === 'string') {
      responseItem({
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: config.developer_instructions }],
      });
    }
    responseItem({
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: `<environment_context>\n  <cwd>${cwd}</cwd>\n</environment_context>` },
      ],
    });
  }
  function rolloutFileForHooks() {
    if (!rolloutPath) rolloutPath = newRolloutPath(sessionsDir, sessionId).file;
    return rolloutPath;
  }

  // --- hooks
  const hooksEnabled = config.features?.hooks !== false;
  const hookEvents = hooksEnabled && config.hooks && typeof config.hooks === 'object' ? config.hooks : {};
  const configuredHooks = Object.values(hookEvents).reduce(
    (n, groups) => n + (Array.isArray(groups) ? groups.reduce((m, g) => m + (g?.hooks?.length ?? 0), 0) : 0),
    0,
  );
  let hooksTrusted = opts.bypassHookTrust;

  let turnId = null;
  async function runHooks(event, extra = {}) {
    if (!hooksTrusted) return [];
    const payload = {
      session_id: sessionId,
      turn_id: turnId ?? undefined,
      transcript_path: rolloutFileForHooks(),
      cwd,
      hook_event_name: event,
      model,
      permission_mode: permissionMode,
      ...extra,
    };
    const runs = [];
    for (const group of Array.isArray(hookEvents[event]) ? hookEvents[event] : []) {
      for (const hook of group?.hooks ?? []) {
        if (hook?.type === 'command' && typeof hook.command === 'string')
          runs.push(runCommandHook(hook, payload, { cwd, requireSuccess: true }));
      }
    }
    return (await Promise.all(runs)).filter((r) => r && typeof r === 'object');
  }

  /** The decision of PermissionRequest answers; invalid ones count as no decision (fail closed). */
  function permissionDecision(outputs) {
    let allow = null;
    for (const o of outputs) {
      const d = o?.hookSpecificOutput?.decision;
      if (o?.hookSpecificOutput?.hookEventName !== 'PermissionRequest' || !d) continue;
      if ('updatedInput' in d || 'updatedPermissions' in d || d.interrupt === true) continue;
      if (d.behavior === 'deny') return { behavior: 'deny', message: d.message ?? 'Denied by hook' };
      if (d.behavior === 'allow') allow = { behavior: 'allow' };
    }
    return allow;
  }

  // --- screen & input state
  let input = '';
  const pastes = createPasteStore({ placeholder: (_id, text) => `[Pasted Content ${text.length} chars]` });
  let lastPasteAt = 0;
  let busy = false;
  let turn = 0;
  /** The conversation's running token total, as Codex reports it in token_count events. */
  const totalTokens = {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  };
  let mode = 'dialog'; // dialog | prompt | question
  const keys = createKeyWaiter();
  let lastCtrlC = 0;

  const FOOTER = process.env.FAKE_CODEX_MODEL_FOOTER
    ? `  ${model} ${config.model_reasoning_effort ?? 'medium'} · ${realCwd}   ⚠ 3 warnings · f2 to view`
    : '  ? for shortcuts                                              100% context left';
  function showPrompt() {
    mode = 'prompt';
    out(`\r\n› ${input.length > 0 ? input.replace(/\n/g, '\r\n  ') : 'Ask Codex to do anything'}`);
    out(`\x1b7\r\n\r\n${FOOTER}\x1b8`);
    if (input.length === 0) out('\r› ');
  }
  function clearComposer() {
    out('\r\x1b[J');
  }

  // Codex reports every exit with reason "other".
  const exit = exitOnSignals({
    sessionEnd: () => runHooks('SessionEnd', { reason: 'other' }),
    restore: '\x1b[?2004l',
  });

  function insertPaste(raw) {
    const text = raw.replace(/\r\n?/g, '\n');
    lastPasteAt = Date.now();
    if (text.length > 1000) {
      const placeholder = pastes.add(text);
      input += placeholder;
      out(placeholder);
      return;
    }
    input += text;
    out(text.replace(/\n/g, '\r\n  '));
  }

  async function submit() {
    const raw = input;
    input = '';
    const text = pastes.expand(raw).trim();
    pastes.clear();
    clearComposer();
    if (!text) return showPrompt();
    line(`› ${text.split('\n')[0]}`);
    // Like Codex: only a composer that starts with "!" runs a shell command; " !x" is sent
    // literally (trimmed).
    if (raw.startsWith('!')) {
      ensureRollout();
      responseItem({
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `<user_shell_command>\n${text.slice(1).trim()}\n</user_shell_command>`,
          },
        ],
      });
      line('fake shell output');
      return showPrompt();
    }
    if (text === '/exit' || text === '/quit') return exit();
    if (text === '/new') {
      await runHooks('SessionEnd', { reason: 'other' });
      sessionId = randomUUID();
      rolloutPath = null;
      rolloutStarted = false;
      sessionStartPending = true;
      sessionStartSource = 'clear';
      line('(new session)');
      return showPrompt();
    }
    await runTurn(text);
  }

  const CANNED_LIMITS = () => {
    const now = Math.floor(Date.now() / 1000);
    return {
      limit_id: 'codex',
      primary: { used_percent: 12.5, window_minutes: 300, resets_at: now + 3600 },
      secondary: { used_percent: 41, window_minutes: 10080, resets_at: now + 3 * 86400 },
      credits: null,
      plan_type: 'pro',
    };
  };

  async function approve(toolName, toolInput) {
    if (approval === 'never' && !process.env.FAKE_CODEX_FORCE_APPROVAL)
      return { behavior: 'deny', message: 'approval policy is never' };
    const decision = permissionDecision(
      await runHooks('PermissionRequest', { tool_name: toolName, tool_input: toolInput }),
    );
    if (decision) return decision;
    line(`Would you like to run the following command? ${toolName}`);
    line('› 1. Yes, proceed');
    line('  2. No, and tell Codex what to do differently');
    mode = 'question';
    const key = await keys.wait();
    mode = 'prompt';
    return key === 'y' || key === '1' || key === '\r'
      ? { behavior: 'allow' }
      : { behavior: 'deny', message: 'rejected by user' };
  }

  async function toolCall({ name, namespace, hookName, args, needsApproval, output, custom, durationMs }) {
    const callId = `call_fake_${turn}_${hookName.replace(/\W+/g, '_')}`;
    if (custom)
      responseItem({
        type: 'custom_tool_call',
        status: 'completed',
        call_id: callId,
        name,
        input: args.input,
      });
    else
      responseItem({
        type: 'function_call',
        name,
        ...(namespace ? { namespace } : {}),
        arguments: JSON.stringify(args),
        call_id: callId,
      });
    line(`• ${hookName}`);
    const hookInput = custom
      ? { command: args.input }
      : name === 'exec_command'
        ? { command: args.cmd }
        : args;
    await runHooks('PreToolUse', { tool_name: hookName, tool_input: hookInput, tool_use_id: callId });
    let decision = { behavior: 'allow' };
    // Without a sandbox (danger-full-access) nothing needs an escalation; FAKE_CODEX_FORCE_APPROVAL
    // still asks, to test a request that arrives where none is expected.
    if (needsApproval && (sandbox !== 'danger-full-access' || process.env.FAKE_CODEX_FORCE_APPROVAL)) {
      const approvalInput =
        name === 'exec_command' ? { command: args.cmd, description: args.justification } : hookInput;
      decision = await approve(hookName, approvalInput);
    }
    if (!busy) return false; // interrupted meanwhile
    if (durationMs && decision.behavior === 'allow') {
      await sleep(durationMs);
      if (!busy) return false; // interrupted while the call ran
    }
    if (decision.behavior === 'allow') {
      responseItem({
        type: custom ? 'custom_tool_call_output' : 'function_call_output',
        call_id: callId,
        output,
      });
      line(`  └ ${typeof output === 'string' ? output.split('\n').at(-1) : 'done'}`);
      await runHooks('PostToolUse', {
        tool_name: hookName,
        tool_input: hookInput,
        tool_use_id: callId,
        tool_response: output,
      });
    } else {
      const text = `rejected by user: ${decision.message}`;
      responseItem({
        type: custom ? 'custom_tool_call_output' : 'function_call_output',
        call_id: callId,
        output: text,
      });
      line(`  └ ${text}`);
    }
    return true;
  }

  async function runTurn(text) {
    turn += 1;
    const myTurn = turn;
    turnId = `turn-${turn}`;
    ensureRollout();
    if (sessionStartPending) {
      sessionStartPending = false;
      await runHooks('SessionStart', { source: sessionStartSource });
    }
    const outputs = await runHooks('UserPromptSubmit', { prompt: text });
    if (outputs.some((o) => o.decision === 'block')) {
      line('Prompt blocked by hook');
      return showPrompt();
    }
    busy = true;
    writeLine('turn_context', {
      turn_id: turnId,
      cwd,
      approval_policy: approval,
      sandbox_policy: { type: sandbox, ...(profile ? { profile: profileName } : {}) },
      model,
    });
    eventMsg({ type: 'task_started', turn_id: turnId });
    responseItem({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
    line('  Working (esc to interrupt)');
    await sleep(text.includes('SLOW') ? 800 : workDelay);
    if (!busy || turn !== myTurn) return;

    if (text.includes('EMPTY_FAILURE')) {
      eventMsg({
        type: 'task_complete',
        turn_id: turnId,
        last_agent_message: null,
        error: { message: 'stream disconnected before completion' },
      });
      busy = false;
      return showPrompt();
    }

    if (process.env.FAKE_CODEX_LOGGED_OUT || text.includes('EXPIRE')) {
      const message =
        'Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.';
      eventMsg({
        type: 'task_complete',
        turn_id: turnId,
        last_agent_message: null,
        error: { message, codex_error_info: 'unauthorized' },
      });
      line(`■ ${message}`);
      busy = false;
      return showPrompt();
    }
    if (text.includes('SUBAGENT')) {
      const sub = { agent_id: 'agent-fake-1', agent_type: 'worker' };
      await runHooks('PreToolUse', {
        ...sub,
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_use_id: 'sub_1',
      });
      await runHooks('Stop', { ...sub, stop_hook_active: false, last_assistant_message: 'subagent done' });
      await sleep(100);
      if (!busy || turn !== myTurn) return;
    }
    if (text.includes('PERMISSION')) {
      const ok = await toolCall({
        name: 'exec_command',
        hookName: 'Bash',
        args: { cmd: 'git push', justification: 'Push the branch', sandbox_permissions: 'require_escalated' },
        needsApproval: true,
        output:
          'Chunk ID: fake01\nWall time: 0.1000 seconds\nProcess exited with code 0\nOriginal token count: 5\nOutput:\nEverything up-to-date',
      });
      if (!ok || !busy || turn !== myTurn) return;
    }
    if (text.includes('EDIT')) {
      const patch = '*** Begin Patch\n*** Add File: notes.txt\n+hello\n*** End Patch';
      const ok = await toolCall({
        name: 'apply_patch',
        hookName: 'apply_patch',
        custom: true,
        args: { input: patch },
        needsApproval: sandbox !== 'workspace-write' && sandbox !== 'danger-full-access',
        output: 'Success. Updated the following files:\nA notes.txt',
      });
      if (!ok || !busy || turn !== myTurn) return;
    }
    if (text.includes('LONGTOOL')) {
      const ok = await toolCall({
        name: 'exec_command',
        hookName: 'Bash',
        args: { cmd: 'sleep 60' },
        needsApproval: false,
        durationMs: Number(process.env.FAKE_CODEX_TOOL_MS ?? 1000),
        output: 'Chunk ID: fake02\nWall time: 1.0000 seconds\nProcess exited with code 0\nOutput:\nslept',
      });
      if (!ok || !busy || turn !== myTurn) return;
      // The next model request: an Esc after the tool lands here (turn_aborted and the Interrupt hook).
      await sleep(Number(process.env.FAKE_CODEX_MODEL_MS ?? 500));
      if (!busy || turn !== myTurn) return;
    }
    if (text.includes('TEAM')) {
      const team = config.mcp_servers?.team ?? {};
      const approved =
        team.default_tools_approval_mode === 'approve' ||
        team.tools?.send_message?.approval_mode === 'approve';
      const ok = await toolCall({
        name: 'send_message',
        namespace: 'mcp__team__',
        hookName: 'mcp__team__send_message',
        args: { to: ['qa'], text: 'Ready for review' },
        needsApproval: !approved,
        output: [{ type: 'input_text', text: 'Delivered to qa' }],
      });
      if (!ok || !busy || turn !== myTurn) return;
    }
    if (text.includes('ASK')) {
      const callId = `call_fake_${turn}_ask`;
      const args = {
        questions: [{ question: 'Which option?', options: [{ label: 'One' }, { label: 'Two' }] }],
      };
      responseItem({
        type: 'function_call',
        name: 'request_user_input',
        arguments: JSON.stringify(args),
        call_id: callId,
      });
      await runHooks('PreToolUse', {
        tool_name: 'request_user_input',
        tool_input: args,
        tool_use_id: callId,
      });
      line('Which option? 1. One  2. Two');
      mode = 'question';
      const key = await keys.wait();
      mode = 'prompt';
      if (!busy || turn !== myTurn) return;
      const answer = key === '2' ? 'Two' : 'One';
      responseItem({ type: 'function_call_output', call_id: callId, output: `User answered: ${answer}` });
      await runHooks('PostToolUse', {
        tool_name: 'request_user_input',
        tool_input: args,
        tool_use_id: callId,
        tool_response: { answer },
      });
    }

    const reply = `Echo: ${text.split('\n')[0]}`;
    responseItem({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply }] });
    line(`• ${reply}`);
    const limits = process.env.FAKE_CODEX_RATE_LIMITS
      ? JSON.parse(process.env.FAKE_CODEX_RATE_LIMITS)
      : CANNED_LIMITS();
    // Each turn's response: input 10 (4 of it from the cache), output 5 (2 of it reasoning).
    const last = {
      input_tokens: 10,
      cached_input_tokens: 4,
      output_tokens: 5,
      reasoning_output_tokens: 2,
      total_tokens: 15,
    };
    for (const [key, value] of Object.entries(last)) totalTokens[key] += value;
    const info = {
      total_token_usage: { ...totalTokens },
      last_token_usage: last,
      model_context_window: 272000,
    };
    eventMsg({ type: 'token_count', info, rate_limits: limits });
    // The same totals again (a plan-limits update): they must not be counted twice.
    eventMsg({ type: 'token_count', info, rate_limits: limits });
    eventMsg({ type: 'task_complete', turn_id: turnId, last_agent_message: reply });
    await runHooks('Stop', { stop_hook_active: false, last_assistant_message: reply });
    if (turn !== myTurn) return;
    busy = false;
    showPrompt();
  }

  async function interrupt() {
    if (!busy) return;
    busy = false;
    turn += 1; // abandons the running turn
    if (keys.waiting) {
      mode = 'prompt';
      keys.deliver('\x1b');
    }
    eventMsg({ type: 'turn_aborted', turn_id: turnId, reason: 'interrupted' });
    line();
    line('■ Conversation interrupted');
    await runHooks('Interrupt', {});
    showPrompt();
  }

  // --- raw input
  function handleKey(key) {
    if (mode === 'dialog' || mode === 'question') {
      keys.deliver(key);
      return;
    }
    switch (key) {
      case '\r':
        if (busy) return; // real Codex would steer the turn; the runner never types while busy
        if (Date.now() - lastPasteAt < 120) {
          // Codex's paste-burst guard: an Enter right after pasted text is a newline.
          input += '\n';
          out('\r\n  ');
          return;
        }
        void submit();
        return;
      case '\n':
        input += '\n';
        out('\r\n  ');
        return;
      case '\x03': {
        if (input) {
          input = '';
          clearComposer();
          return showPrompt();
        }
        if (busy) return void interrupt();
        const now = Date.now();
        if (now - lastCtrlC < 1500) return void exit();
        lastCtrlC = now;
        return;
      }
      case '\x04':
        if (!input) void exit();
        return;
      case '\x1b':
        if (busy) void interrupt();
        return;
      case '\x7f':
        input = input.slice(0, -1);
        out('\b \b');
        return;
      default:
        if (key >= ' ') {
          if (input.length === 0) out('\r› \x1b[K');
          input += key;
          out(key);
        }
    }
  }

  function handlePaste(content) {
    if (mode !== 'prompt') return;
    if (input.length === 0) out('\r› \x1b[K');
    if (input.length === 0 && content.startsWith('!')) {
      // "!" on an empty composer: a shell command
      input = '!';
      insertPaste(content.slice(1));
    } else insertPaste(content);
  }

  readTerminalInput({ onKey: handleKey, onPaste: handlePaste });

  // --- start-up
  out('\x1b[?2004h');
  line(`>_ Fake Codex (v${VERSION})`);
  line(`model: ${model} · directory: ${cwd}`);
  line();

  if (config.model_provider === 'nanogpt' && !process.env.NANOGPT_API_KEY) {
    line('Not logged in: NanoGPT key missing');
    await keys.wait();
    process.exit(1);
  }
  if (
    process.env.FAKE_CODEX_LOGGED_OUT ||
    (!config.model_provider && existsSync(path.join(codexHome, 'auth.json')))
  ) {
    line('Sign in with ChatGPT to use Codex as part of your paid plan');
    line('› 1. Sign in with ChatGPT');
    line('  2. Provide your own API key');
    await keys.wait();
    line('Exiting');
    process.exit(1);
  }

  if (!config.projects?.[realCwd]?.trust_level) {
    line('Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.');
    line('› 1. Trust and continue');
    line('  2. Quit');
    await awaitTrust(keys);
    out('\x1b[3A\x1b[J');
  }

  if (configuredHooks > 0 && !hooksTrusted) {
    line('Hooks need review');
    line(`${configuredHooks} hooks need review before they can run.`);
    line('› 1. Continue without them');
    await keys.wait();
    out('\x1b[3A\x1b[J');
  }

  await sleep(Number(process.env.FAKE_CODEX_STARTUP_DELAY_MS ?? 50));
  if (resumeId) replayHistory(rolloutPath);
  showPrompt();
  if (firstPrompt && firstPrompt.trim()) {
    input = firstPrompt;
    await submit();
  }
}
