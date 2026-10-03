#!/usr/bin/env node
/**
 * fake-claude — a deterministic stand-in for the interactive Claude Code CLI, for automated
 * tests. It never calls any API. It speaks the parts of the protocol projectman relies on:
 *
 * FLAGS (same as `claude`): --session-id <uuid> | --resume <uuid>, --append-system-prompt,
 *   --mcp-config <json>, --settings <json|file>, --model, --effort, --permission-mode, -n/--name,
 *   --agents <json> (checked: a malformed one exits with code 1 before the session starts),
 *   -p/--print with --input-format/--output-format stream-json, --version, --help.
 *   Other flags are accepted and ignored.
 *
 * INTERACTIVE MODE (a PTY):
 * - Transcript: appends Claude-shaped JSONL entries to
 *   `$FAKE_CLAUDE_TRANSCRIPT_DIR/<session-id>.jsonl` (default: <os tmp>/fake-claude).
 *   `--resume <id>` appends to that file; if it does not exist, prints
 *   "No conversation found with session ID: <id>" and exits with code 1.
 * - Hooks from --settings: `http` hooks are POSTed (JSON) to their url; `command` hooks run
 *   with `sh -c` (or exec form with `args`) and get the payload on stdin, like Claude Code.
 *   Payloads carry session_id, transcript_path, cwd, permission_mode, hook_event_name.
 * - Start-up: enables bracketed paste (ESC[?2004h), prints a banner, runs SessionStart
 *   (source "startup" or "resume") after FAKE_CLAUDE_STARTUP_DELAY_MS (default 50), then
 *   prints the prompt "> ".
 * - Workspace trust: when FAKE_CLAUDE_CONFIG_FILE is set and its
 *   projects[<realpath cwd>].hasTrustDialogAccepted (or a parent's) is not true, it first
 *   shows "Quick safety check: Is this a project you created or one you trust?" and waits:
 *   Enter or "1" accepts, "2" or Esc exits with code 1.
 * - MCP approval: when FAKE_CLAUDE_MCP_DIALOG is set, right after SessionStart it shows
 *   "New MCP server found in this project: fake-db" over the prompt, ignores pastes, and
 *   removes the dialog on any key.
 * - Input (raw mode): bracketed pastes are inserted like Claude Code does: a paste of more
 *   than 800 chars or more than min(rows-10, 2) line breaks collapses to
 *   "[Pasted text #N +X lines]" and is submitted wrapped in <pasted_content id="N"> lines;
 *   a paste starting with "!" into an empty prompt switches to shell mode. Ctrl+J (LF)
 *   inserts a newline, Enter (CR) submits, Ctrl+C clears the input / interrupts / exits
 *   (twice), Ctrl+D on an empty prompt exits, Esc interrupts a running turn (writes
 *   "[Request interrupted by user]" and sends no Stop hook, like Claude Code).
 * - A submitted prompt: UserPromptSubmit hook (a "block" decision drops it), user entry, then
 *   after FAKE_CLAUDE_WORK_DELAY_MS (default 50; 800 if the prompt contains "SLOW"):
 *   - contains "PERMISSION": tool_use Bash {command:"git push", or FAKE_CLAUDE_PERMISSION_COMMAND},
 *     PreToolUse, then (unless an
 *     allow rule matches) a PermissionRequest hook with permission_suggestions; "allow" runs
 *     it (tool_result "Everything up-to-date", PostToolUse), "deny" writes an error
 *     tool_result with the message; no decision asks in the terminal (y/n).
 *     `updatedPermissions` addRules with destination "session" are remembered. Allow rules:
 *     "Tool", "Tool(exact)", "Tool(glob*)", "Tool(prefix:*)", "mcp__server", "mcp__server__*".
 *   - contains "TEAM": tool_use mcp__team__send_message {to:["qa"], text:"Ready for review"}
 *     (same permission flow; `permissions.allow` "mcp__team" or "mcp__team__*" pre-allows it).
 *   - contains "CALLS": the calls in FAKE_CLAUDE_MCP_CALLS (JSON: [{tool, arguments, delayMs?}]),
 *     in order and in this one turn, each after its delay: tool_use mcp__team__<tool>, the same
 *     permission flow, then a real tools/call to the "team" server of --mcp-config; its answer
 *     (or the HTTP error) is the tool_result.
 *   - contains "LONGTOOL": tool_use Bash {command:"sleep 60"}, the same permission flow, then a call
 *     that takes FAKE_CLAUDE_TOOL_MS (default 1000) before its result and PostToolUse.
 *   - A PreToolUse answer with `continue: false` (a pause, PM-218) turns the call away: it does not
 *     run, its tool_result is an error with the `stopReason`, and the turn ends with a Stop hook. A
 *     PostToolUse answer with `continue: false` ends the turn after the result, also with a Stop.
 *   - contains "ASK": tool_use AskUserQuestion, PreToolUse, waits for a key in the terminal (a
 *     PreToolUse hook that answers permissionDecision "deny" turns the call away: no dialog).
 *   - contains "SUBAGENT": a subagent's own transcript
 *     `<transcript dir>/<session id>/subagents/agent-<id>.jsonl` (model "claude-fake-haiku",
 *     usage input 3, output 2, cache read 30), then the SubagentStop hook with agent_id,
 *     agent_type "Explore" and agent_transcript_path.
 *   - always: assistant text "Echo: <first line of the prompt>" (a thinking entry first, with the
 *     same message id and a placeholder output count of 1), then the Stop hook.
 *   Every response's usage: input 10 (or FAKE_CLAUDE_INPUT_TOKENS), output 5, cache read 100,
 *   cache write 20, model --model (default "claude-fake").
 * - "/clear": SessionEnd (reason "clear"), a new session id and transcript file, then
 *   SessionStart with source "clear" (no UserPromptSubmit, like Claude Code's own commands).
 * - "/compact [instructions]": PreCompact (trigger "manual", custom_instructions), a pause
 *   (FAKE_CLAUDE_COMPACT_DELAY_MS, default the work delay), a compact_boundary and a summary in the
 *   transcript, PostCompact, SessionStart (source "compact"); no UserPromptSubmit and no Stop.
 *   FAKE_CLAUDE_COMPACT_IGNORED: the command does nothing (no hook, like a dialog over the
 *   prompt); FAKE_CLAUDE_COMPACT_HANG: PostCompact never comes.
 * - "/exit", double Ctrl+C, Ctrl+D, SIGTERM or SIGHUP: SessionEnd hook, exit code 0.
 * - OSC 9;4 progress (busy/idle) and an OSC 0 title are emitted like Claude Code.
 *
 * - contains "EXPIRE" (or any prompt while FAKE_CLAUDE_LOGGED_OUT is set): the login is gone:
 *   an API error entry "Login expired · Please run /login" (isApiErrorMessage), then Stop.
 *
 * PRINT MODE (-p --input-format stream-json): answers a `control_request` with subtype
 * "get_usage" with a `control_response` (FAKE_CLAUDE_USAGE = JSON of the answer, or a canned
 * one); it never answers prompts. Exits when stdin closes.
 *
 * AUTH STATUS (`auth status`): prints `{"loggedIn": true, "authMethod": "claude.ai",
 * "apiProvider": "firstParty"}`; with FAKE_CLAUDE_LOGGED_OUT set, `loggedIn` is false and
 * `authMethod` is "none" (exit code 1). FAKE_CLAUDE_AUTH_METHOD overrides the method.
 *
 * VERSION: `--version` prints `<FAKE_CLAUDE_VERSION, else 0.0.0> (Fake Claude Code)`. With
 * `--permission-mode bypassPermissions` no tool asks for permission (FAKE_CLAUDE_FORCE_PERMISSION_REQUEST
 * makes it ask anyway: a request that arrives where none is expected).
 *
 * DIAGNOSTICS: FAKE_CLAUDE_ARGS_FILE, when set, receives {argv, cwd, env} at start-up (env
 * without values of variables whose name contains KEY, TOKEN or SECRET, which are "<set>").
 *
 * The terminal input, dialogs, command hooks and exit sequence shared with fake-codex live in
 * fake-tui.mjs.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  VERSION,
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

// ------------------------------------------------------------------ arguments

function parseArgs(argv) {
  const o = {
    print: false,
    sessionId: null,
    resume: null,
    appendSystemPrompt: null,
    mcpConfig: [],
    settings: null,
    model: null,
    effort: null,
    agents: null,
    permissionMode: null,
    name: null,
    inputFormat: null,
    outputFormat: null,
    version: false,
    help: false,
    positional: [],
  };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let inline;
    if (arg.startsWith('--') && arg.includes('=')) {
      inline = arg.slice(arg.indexOf('=') + 1);
      arg = arg.slice(0, arg.indexOf('='));
    }
    const value = () => (inline !== undefined ? inline : argv[++i]);
    switch (arg) {
      case '-p':
      case '--print':
        o.print = true;
        break;
      case '--session-id':
        o.sessionId = value();
        break;
      case '-r':
      case '--resume':
        o.resume = value();
        break;
      case '--append-system-prompt':
        o.appendSystemPrompt = value();
        break;
      case '--mcp-config':
        o.mcpConfig.push(value());
        break;
      case '--settings':
        o.settings = value();
        break;
      case '--model':
        o.model = value();
        break;
      case '--effort':
        o.effort = value();
        break;
      case '--permission-mode':
        o.permissionMode = value();
        break;
      case '-n':
      case '--name':
        o.name = value();
        break;
      case '--input-format':
        o.inputFormat = value();
        break;
      case '--output-format':
        o.outputFormat = value();
        break;
      case '--agents':
        o.agents = value();
        break;
      case '--tools':
      case '--setting-sources':
        value();
        break;
      case '-v':
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

if (process.env.FAKE_CLAUDE_ARGS_FILE) writeArgsFile(process.env.FAKE_CLAUDE_ARGS_FILE);

/** One tools/call on the "team" server of --mcp-config (stateless streamable HTTP, JSON answers). */
async function callTeamTool(tool, args) {
  let url = null;
  for (const raw of opts.mcpConfig) {
    try {
      url = JSON.parse(raw)?.mcpServers?.team?.url ?? url;
    } catch {
      // not JSON: Claude Code would read a file; the runner always passes JSON
    }
  }
  if (typeof url !== 'string') return { text: 'No team MCP server is configured', isError: true };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'tools/call',
        params: { name: tool, arguments: args },
      }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.result)
      return { text: body?.error?.message ?? `HTTP ${res.status}`, isError: true };
    const text = (body.result.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    return { text, isError: body.result.isError === true };
  } catch (err) {
    return { text: `MCP call failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

/**
 * Like Claude Code, refuses to start with `--agents` that is not a JSON object of subagents, each
 * with a description and a prompt (strings), and optionally tools (strings) and a model (string).
 */
function agentsError(text) {
  let agents;
  try {
    agents = JSON.parse(text);
  } catch {
    return '--agents is not valid JSON';
  }
  if (agents === null || typeof agents !== 'object' || Array.isArray(agents))
    return '--agents is not an object';
  for (const [name, agent] of Object.entries(agents)) {
    if (agent === null || typeof agent !== 'object' || Array.isArray(agent))
      return `agent ${name} is not an object`;
    for (const key of ['description', 'prompt']) {
      if (typeof agent[key] !== 'string' || !agent[key]) return `agent ${name} has no ${key}`;
    }
    if (
      agent.tools !== undefined &&
      !(Array.isArray(agent.tools) && agent.tools.every((t) => typeof t === 'string'))
    )
      return `agent ${name} has invalid tools`;
    if (agent.model !== undefined && typeof agent.model !== 'string')
      return `agent ${name} has an invalid model`;
  }
  return null;
}

if (opts.agents !== null) {
  const error = agentsError(opts.agents);
  if (error) {
    process.stderr.write(`fake-claude: ${error}\n`);
    process.exit(1);
  }
}

if (opts.version) {
  process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION ?? VERSION} (Fake Claude Code)\n`);
  process.exit(0);
}
if (opts.positional[0] === 'auth' && opts.positional[1] === 'status') {
  const loggedOut = Boolean(process.env.FAKE_CLAUDE_LOGGED_OUT);
  const status = {
    loggedIn: !loggedOut,
    authMethod: loggedOut ? 'none' : (process.env.FAKE_CLAUDE_AUTH_METHOD ?? 'claude.ai'),
    apiProvider: 'firstParty',
  };
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  process.exit(loggedOut ? 1 : 0);
}
if (opts.help) {
  process.stdout.write(
    'Usage: fake-claude [options]\nA test double for the Claude Code CLI. See the header of this file.\n',
  );
  process.exit(0);
}

// ------------------------------------------------------------------ print mode

if (opts.print) {
  if (opts.inputFormat !== 'stream-json') {
    process.stderr.write('fake-claude: print mode supports only --input-format stream-json\n');
    process.exit(1);
  }
  const usage = process.env.FAKE_CLAUDE_USAGE
    ? JSON.parse(process.env.FAKE_CLAUDE_USAGE)
    : {
        subscription_type: 'max',
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 42, resets_at: '2026-01-01T05:00:00.000Z' },
          seven_day: { utilization: 17.5, resets_at: '2026-01-07T00:00:00.000Z' },
        },
      };
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.type === 'control_request' && msg.request?.subtype === 'get_usage') {
        const response = {
          type: 'control_response',
          response: { subtype: 'success', request_id: msg.request_id, response: usage },
        };
        process.stdout.write(`${JSON.stringify(response)}\n`);
      } else if (msg.type === 'control_request') {
        const response = {
          type: 'control_response',
          response: { subtype: 'error', request_id: msg.request_id, error: 'unsupported' },
        };
        process.stdout.write(`${JSON.stringify(response)}\n`);
      } else {
        process.stdout.write(
          `${JSON.stringify({ type: 'result', subtype: 'error', result: 'fake-claude answers no prompts' })}\n`,
        );
        process.exit(1);
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
} else {
  await interactive();
}

// ------------------------------------------------------------------ interactive mode

async function interactive() {
  const cwd = process.cwd();
  // Both change on /clear, which starts a new conversation.
  let sessionId = opts.resume ?? opts.sessionId ?? randomUUID();
  const transcriptDir = process.env.FAKE_CLAUDE_TRANSCRIPT_DIR || path.join(os.tmpdir(), 'fake-claude');
  mkdirSync(transcriptDir, { recursive: true });
  let transcriptPath = path.join(transcriptDir, `${sessionId}.jsonl`);
  const permissionMode = opts.permissionMode ?? 'default';
  const settings = loadSettings(opts.settings);
  const allowRules = [...(settings?.permissions?.allow ?? [])];
  const workDelay = Number(process.env.FAKE_CLAUDE_WORK_DELAY_MS ?? 50);

  if (opts.resume && !existsSync(transcriptPath)) {
    line(`No conversation found with session ID: ${opts.resume}`);
    process.exit(1);
  }

  // --- transcript
  let parentUuid = null;
  function writeEntry(entry) {
    const uuid = randomUUID();
    const full = {
      parentUuid,
      isSidechain: false,
      userType: 'external',
      cwd,
      sessionId,
      version: VERSION,
      gitBranch: '',
      ...entry,
      uuid,
      timestamp: new Date().toISOString(),
    };
    parentUuid = uuid;
    appendFileSync(transcriptPath, `${JSON.stringify(full)}\n`);
    return uuid;
  }
  const userEntry = (content, extra = {}) =>
    writeEntry({ type: 'user', message: { role: 'user', content }, ...extra });
  let messageCounter = 0;
  /** Every response's usage; `outputTokens` overrides its output (a placeholder of an early block). */
  const usage = (outputTokens = 5) => ({
    input_tokens: Number(process.env.FAKE_CLAUDE_INPUT_TOKENS ?? 10),
    output_tokens: outputTokens,
    cache_read_input_tokens: 100,
    cache_creation_input_tokens: 20,
  });
  const assistantEntry = (content, { id, outputTokens } = {}) => {
    if (!id) messageCounter += 1;
    return writeEntry({
      type: 'assistant',
      requestId: `req_fake_${messageCounter}`,
      message: {
        id: id ?? `msg_fake_${messageCounter}`,
        type: 'message',
        role: 'assistant',
        model: opts.model ?? 'claude-fake',
        content,
        stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
        usage: usage(outputTokens),
      },
    });
  };

  /**
   * A subagent's run: its own transcript (sidechain entries of another model, one response in two
   * entries with a placeholder output count first), then SubagentStop naming that file.
   */
  async function runSubagent() {
    const agentId = `a${turn}fake`;
    const file = path.join(transcriptDir, sessionId, 'subagents', `agent-${agentId}.jsonl`);
    mkdirSync(path.dirname(file), { recursive: true });
    const id = `msg_fake_sub_${turn}`;
    for (const [content, output] of [
      [[{ type: 'thinking', thinking: '' }], 1],
      [[{ type: 'text', text: 'Found it' }], 2],
    ]) {
      const entry = {
        parentUuid: null,
        isSidechain: true,
        agentId,
        sessionId,
        type: 'assistant',
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model: 'claude-fake-haiku',
          content,
          usage: {
            input_tokens: 3,
            output_tokens: output,
            cache_read_input_tokens: 30,
            cache_creation_input_tokens: 0,
          },
        },
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
      };
      appendFileSync(file, `${JSON.stringify(entry)}\n`);
    }
    await runHooks(
      'SubagentStop',
      {
        agent_id: agentId,
        agent_type: 'Explore',
        agent_transcript_path: file,
        stop_hook_active: false,
        last_assistant_message: 'Found it',
      },
      'Explore',
    );
  }

  // --- hooks
  function matcherMatches(matcher, value) {
    if (matcher === undefined || matcher === '' || matcher === '*') return true;
    if (value === undefined) return true;
    if (/^[A-Za-z0-9_|, -]+$/.test(matcher))
      return matcher
        .split(/[|,]/)
        .map((m) => m.trim())
        .includes(value);
    return new RegExp(matcher).test(value);
  }

  async function runHttpHook(hook, payload) {
    try {
      const res = await fetch(hook.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout((hook.timeout ?? 600) * 1000),
      });
      const text = await res.text();
      if (!res.ok || !text.trim().startsWith('{')) return null;
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  async function runHooks(event, extra = {}, matchValue) {
    const payload = {
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd,
      permission_mode: permissionMode,
      hook_event_name: event,
      ...extra,
    };
    const runs = [];
    for (const group of settings?.hooks?.[event] ?? []) {
      if (!matcherMatches(group.matcher, matchValue)) continue;
      for (const hook of group.hooks ?? []) {
        if (hook.type === 'http') runs.push(runHttpHook(hook, payload));
        else if (hook.type === 'command') runs.push(runCommandHook(hook, payload, { cwd, execForm: true }));
      }
    }
    return (await Promise.all(runs)).filter((r) => r && typeof r === 'object');
  }

  // --- permissions
  function ruleMatches(rule, tool, input) {
    const m = /^([^(]+)(?:\((.*)\))?$/.exec(rule);
    if (!m) return false;
    const [, ruleTool, content] = m;
    if (ruleTool.startsWith('mcp__')) {
      if (ruleTool.endsWith('*')) return tool.startsWith(ruleTool.slice(0, -1));
      return tool === ruleTool || tool.startsWith(`${ruleTool}__`);
    }
    if (ruleTool !== tool) return false;
    if (content === undefined) return true;
    const subject =
      typeof input?.command === 'string'
        ? input.command
        : typeof input?.file_path === 'string'
          ? input.file_path
          : '';
    // "Bash(git diff:*)": the legacy prefix form, the command or the command plus arguments.
    if (content.endsWith(':*')) {
      const prefix = content.slice(0, -2);
      return subject === prefix || subject.startsWith(`${prefix} `);
    }
    const pattern = new RegExp(`^${content.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    return pattern.test(subject);
  }
  const isAllowed = (tool, input) => allowRules.some((rule) => ruleMatches(rule, tool, input));
  function remember(updates) {
    for (const u of updates ?? []) {
      if (u?.type !== 'addRules' || u.behavior !== 'allow' || u.destination !== 'session') continue;
      for (const r of u.rules ?? [])
        allowRules.push(r.ruleContent !== undefined ? `${r.toolName}(${r.ruleContent})` : r.toolName);
    }
  }

  // --- screen & input state
  let input = '';
  let shellMode = false;
  // Claude Code submits a collapsed paste wrapped in <pasted_content> lines.
  const pastes = createPasteStore({
    placeholder: (id, text) => {
      const breaks = (text.match(/\n/g) ?? []).length;
      return breaks === 0 ? `[Pasted text #${id}]` : `[Pasted text #${id} +${breaks} lines]`;
    },
    expand: (id, text) => `<pasted_content id="${id}">\n${text}\n</pasted_content id="${id}">`,
  });
  let busy = false;
  let turn = 0;
  let mode = 'prompt'; // prompt | trust | question
  const keys = createKeyWaiter();
  let lastCtrlC = 0;

  const progress = (on) => out(on ? '\x1b]9;4;3;\x07' : '\x1b]9;4;0;\x07');
  const showPrompt = () => out(`${shellMode ? '! ' : '> '}${input.replace(/\n/g, '\r\n  ')}`);

  const exit = exitOnSignals({
    sessionEnd: (reason) => runHooks('SessionEnd', { reason }),
    restore: '\x1b]9;4;0;\x07\x1b[?2004l',
  });

  function insertPaste(raw) {
    const text = raw.replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
    if (input.length === 0 && !shellMode && text.startsWith('!')) {
      shellMode = true;
      insertPaste(text.slice(1));
      return;
    }
    const breaks = (text.match(/\n/g) ?? []).length;
    const rows = process.stdout.rows || 24;
    if (text.length > 800 || breaks > Math.max(0, Math.min(rows - 10, 2))) {
      const placeholder = pastes.add(text);
      input += placeholder;
      out(placeholder);
    } else {
      input += text;
      out(text.replace(/\n/g, '\r\n  '));
    }
  }

  async function submit() {
    const raw = input;
    const wasShell = shellMode;
    input = '';
    shellMode = false;
    line();
    const text = pastes.expand(raw).trim();
    pastes.clear();
    if (!text) return showPrompt();
    if (wasShell) {
      userEntry(`<bash-input>${text}</bash-input>`);
      userEntry(`<bash-stdout>fake shell output</bash-stdout><bash-stderr></bash-stderr>`);
      line(`! ${text}`);
      return showPrompt();
    }
    if (text === '/exit') return exit('prompt_input_exit');
    if (text === '/clear') {
      await runHooks('SessionEnd', { reason: 'clear' }, 'clear');
      sessionId = randomUUID();
      transcriptPath = path.join(transcriptDir, `${sessionId}.jsonl`);
      parentUuid = null;
      await runHooks('SessionStart', { source: 'clear' }, 'clear');
      line('(conversation cleared)');
      return showPrompt();
    }
    if (text === '/compact' || text.startsWith('/compact '))
      return runCompact(text.slice('/compact'.length).trim());
    await runTurn(text);
  }

  /**
   * "/compact [instructions]" (a manual compaction): like Claude Code's own commands it sends no
   * UserPromptSubmit and no Stop. PreCompact, a pause, a boundary and a summary in the same
   * transcript (the conversation goes on in the same file), PostCompact, then SessionStart with
   * source "compact". FAKE_CLAUDE_COMPACT_IGNORED: the command is swallowed (no hook at all, like
   * a dialog over the prompt); FAKE_CLAUDE_COMPACT_HANG: PostCompact never comes.
   */
  async function runCompact(instructions) {
    userEntry(
      `<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>${instructions}</command-args>`,
    );
    if (process.env.FAKE_CLAUDE_COMPACT_IGNORED) return showPrompt();
    const trigger = 'manual';
    busy = true;
    progress(true);
    await runHooks('PreCompact', { trigger, custom_instructions: instructions }, trigger);
    line('Compacting conversation…');
    await sleep(Number(process.env.FAKE_CLAUDE_COMPACT_DELAY_MS ?? workDelay));
    if (process.env.FAKE_CLAUDE_COMPACT_HANG) return;
    writeEntry({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' });
    const summary = `This session is being continued from a previous conversation. Summary: ${instructions}`;
    userEntry(summary, { isCompactSummary: true });
    await runHooks('PostCompact', { trigger, compact_summary: summary }, trigger);
    await runHooks('SessionStart', { source: 'compact' }, 'compact');
    busy = false;
    progress(false);
    line('Conversation compacted');
    showPrompt();
  }

  /** A hook told the turn to end (`continue: false`): the Stop hook follows, like in Claude Code 2.1.284. */
  async function haltTurn(reason) {
    const myTurn = turn;
    line(`● ${reason}`);
    await runHooks('Stop', { stop_hook_active: false, last_assistant_message: reason });
    if (turn !== myTurn) return;
    busy = false;
    progress(false);
    line();
    showPrompt();
  }

  /** After a PostToolUse hook: true when its answer ended the turn (the result is already in). */
  async function haltedAfterTool(outputs) {
    const halt = outputs.find((o) => o.continue === false);
    if (!halt) return false;
    await haltTurn(halt.stopReason ?? 'Stopped by a hook');
    return true;
  }

  /**
   * One tool call: tool_use, PreToolUse, the permission flow, then the result (PostToolUse) or the
   * denial. `run`, when given, does the call once it is allowed and answers `{ text, isError }`.
   */
  async function toolCall(name, toolInput, okResult, toolResponse, run) {
    const toolUseId = `toolu_fake_${turn}_${name}`;
    assistantEntry([{ type: 'tool_use', id: toolUseId, name, input: toolInput }]);
    line(`● ${name}(${JSON.stringify(toolInput).slice(0, 60)})`);
    const preOutputs = await runHooks(
      'PreToolUse',
      { tool_name: name, tool_input: toolInput, tool_use_id: toolUseId },
      name,
    );
    // A halting answer (`continue: false`, a pause): the call does not run, its result is an error
    // with the reason, and the turn ends.
    const preHalt = preOutputs.find((o) => o.continue === false);
    if (preHalt) {
      const message = preHalt.stopReason ?? 'Stopped by a hook';
      userEntry([{ type: 'tool_result', tool_use_id: toolUseId, content: message, is_error: true }], {
        toolUseResult: `Error: ${message}`,
      });
      line(`  ⎿ ${message}`);
      await haltTurn(message);
      return false;
    }
    // bypassPermissions asks nothing (FAKE_CLAUDE_FORCE_PERMISSION_REQUEST asks anyway, to test a
    // request that arrives where none is expected).
    let allowed =
      (permissionMode === 'bypassPermissions' && !process.env.FAKE_CLAUDE_FORCE_PERMISSION_REQUEST) ||
      isAllowed(name, toolInput);
    let denyMessage = 'Permission denied';
    if (!allowed) {
      const suggestions = [
        {
          type: 'addRules',
          rules: [
            typeof toolInput.command === 'string'
              ? { toolName: name, ruleContent: toolInput.command }
              : { toolName: name },
          ],
          behavior: 'allow',
          destination: 'localSettings',
        },
      ];
      const outputs = await runHooks(
        'PermissionRequest',
        { tool_name: name, tool_input: toolInput, permission_suggestions: suggestions },
        name,
      );
      const decision = outputs.map((o) => o.hookSpecificOutput?.decision).find((d) => d?.behavior);
      if (decision?.behavior === 'allow') {
        allowed = true;
        remember(decision.updatedPermissions);
      } else if (decision?.behavior === 'deny') {
        denyMessage = decision.message ?? denyMessage;
      } else {
        line(`Allow ${name}? (y/n)`);
        mode = 'question';
        const key = await keys.wait();
        mode = 'prompt';
        allowed = key === 'y' || key === '1' || key === '\r';
      }
    }
    if (!busy) return false; // interrupted meanwhile
    if (allowed && run) {
      const result = await run();
      if (!busy) return false; // interrupted while the call ran
      userEntry(
        [{ type: 'tool_result', tool_use_id: toolUseId, content: result.text, is_error: result.isError }],
        {
          toolUseResult: result.isError ? `Error: ${result.text}` : [{ type: 'text', text: result.text }],
        },
      );
      line(`  ⎿ ${result.text}`);
      if (!result.isError) {
        const outputs = await runHooks(
          'PostToolUse',
          { tool_name: name, tool_input: toolInput, tool_use_id: toolUseId, tool_response: result.text },
          name,
        );
        if (await haltedAfterTool(outputs)) return false;
      }
    } else if (allowed) {
      userEntry([{ type: 'tool_result', tool_use_id: toolUseId, content: okResult, is_error: false }], {
        toolUseResult: toolResponse,
      });
      line(`  ⎿ ${okResult}`);
      const outputs = await runHooks(
        'PostToolUse',
        { tool_name: name, tool_input: toolInput, tool_use_id: toolUseId, tool_response: toolResponse },
        name,
      );
      if (await haltedAfterTool(outputs)) return false;
    } else {
      userEntry([{ type: 'tool_result', tool_use_id: toolUseId, content: denyMessage, is_error: true }], {
        toolUseResult: `Error: ${denyMessage}`,
      });
      line(`  ⎿ ${denyMessage}`);
    }
    return true;
  }

  async function runTurn(text) {
    turn += 1;
    const myTurn = turn;
    const outputs = await runHooks('UserPromptSubmit', { prompt: text });
    if (outputs.some((o) => o.decision === 'block')) {
      line('Prompt blocked by hook');
      return showPrompt();
    }
    busy = true;
    progress(true);
    userEntry(text, { promptId: randomUUID() });
    await sleep(text.includes('SLOW') ? 800 : workDelay);
    if (!busy || turn !== myTurn) return;

    if (process.env.FAKE_CLAUDE_LOGGED_OUT || text.includes('EXPIRE')) {
      // Like Claude Code after its OAuth login expired: an API error message ends the turn.
      const error = 'Login expired · Please run /login';
      writeEntry({
        type: 'assistant',
        isApiErrorMessage: true,
        message: {
          id: `msg_fake_error_${++messageCounter}`,
          type: 'message',
          role: 'assistant',
          model: '<synthetic>',
          content: [{ type: 'text', text: error }],
        },
      });
      line(`⏺ ${error}`);
      await runHooks('Stop', { stop_hook_active: false, last_assistant_message: error });
      if (turn !== myTurn) return;
      busy = false;
      progress(false);
      line();
      showPrompt();
      return;
    }

    if (text.includes('PERMISSION')) {
      const ok = await toolCall(
        'Bash',
        { command: process.env.FAKE_CLAUDE_PERMISSION_COMMAND ?? 'git push', description: 'Push the branch' },
        'Everything up-to-date',
        {
          stdout: 'Everything up-to-date',
          stderr: '',
          interrupted: false,
          isImage: false,
        },
      );
      if (!ok || !busy || turn !== myTurn) return;
    }
    if (text.includes('LONGTOOL')) {
      // A Bash call that takes FAKE_CLAUDE_TOOL_MS (default 1000): a pause waits for its end.
      const ok = await toolCall('Bash', { command: 'sleep 60' }, '', null, async () => {
        await sleep(Number(process.env.FAKE_CLAUDE_TOOL_MS ?? 1000));
        return { text: 'slept', isError: false };
      });
      if (!ok || !busy || turn !== myTurn) return;
    }
    if (text.includes('TEAM')) {
      const ok = await toolCall(
        'mcp__team__send_message',
        { to: ['qa'], text: 'Ready for review' },
        'Delivered to qa',
        [{ type: 'text', text: 'Delivered to qa' }],
      );
      if (!ok || !busy || turn !== myTurn) return;
    }
    if (text.includes('CALLS')) {
      for (const call of JSON.parse(process.env.FAKE_CLAUDE_MCP_CALLS ?? '[]')) {
        await sleep(call.delayMs ?? 0);
        if (!busy || turn !== myTurn) return;
        const ok = await toolCall(`mcp__team__${call.tool}`, call.arguments, '', null, () =>
          callTeamTool(call.tool, call.arguments),
        );
        if (!ok || !busy || turn !== myTurn) return;
      }
    }
    if (text.includes('ASK')) {
      const toolUseId = `toolu_fake_${turn}_ask`;
      const toolInput = {
        questions: [{ question: 'Which option?', options: [{ label: 'One' }, { label: 'Two' }] }],
      };
      assistantEntry([{ type: 'tool_use', id: toolUseId, name: 'AskUserQuestion', input: toolInput }]);
      const outputs = await runHooks(
        'PreToolUse',
        { tool_name: 'AskUserQuestion', tool_input: toolInput, tool_use_id: toolUseId },
        'AskUserQuestion',
      );
      // A PreToolUse hook that refuses the call (the question went to the inbox): no dialog.
      const refusal = outputs
        .map((o) => o.hookSpecificOutput)
        .find((o) => o?.hookEventName === 'PreToolUse' && o.permissionDecision === 'deny');
      if (refusal) {
        const message = refusal.permissionDecisionReason ?? 'Refused';
        userEntry([{ type: 'tool_result', tool_use_id: toolUseId, content: message, is_error: true }], {
          toolUseResult: `Error: ${message}`,
        });
        line(`  ⎿ ${message}`);
      } else {
        line('Which option? 1. One  2. Two');
        mode = 'question';
        const key = await keys.wait();
        mode = 'prompt';
        if (!busy || turn !== myTurn) return;
        const answer = key === '2' ? 'Two' : 'One';
        userEntry([{ type: 'tool_result', tool_use_id: toolUseId, content: `User answered: ${answer}` }], {
          toolUseResult: { answers: { 'Which option?': answer } },
        });
        await runHooks(
          'PostToolUse',
          {
            tool_name: 'AskUserQuestion',
            tool_input: toolInput,
            tool_use_id: toolUseId,
            tool_response: { answer },
          },
          'AskUserQuestion',
        );
      }
    }

    if (text.includes('SUBAGENT')) {
      await runSubagent();
      if (!busy || turn !== myTurn) return;
    }

    const reply = `Echo: ${text.split('\n')[0]}`;
    // Like Claude Code: one response in two entries, the first with a placeholder output count.
    const replyId = `msg_fake_${++messageCounter}`;
    assistantEntry([{ type: 'thinking', thinking: '', signature: 'fake' }], { id: replyId, outputTokens: 1 });
    assistantEntry([{ type: 'text', text: reply }], { id: replyId });
    line(`● ${reply}`);
    await runHooks('Stop', { stop_hook_active: false, last_assistant_message: reply });
    if (turn !== myTurn) return;
    busy = false;
    progress(false);
    line();
    showPrompt();
  }

  function interrupt() {
    if (!busy) return;
    busy = false;
    turn += 1; // abandons the running turn
    if (keys.waiting) {
      mode = 'prompt';
      keys.deliver('\x1b');
    }
    userEntry([{ type: 'text', text: '[Request interrupted by user]' }]);
    progress(false);
    line();
    line('Interrupted');
    showPrompt();
  }

  // --- raw input
  function handleKey(key) {
    if (mode === 'trust' || mode === 'question') {
      keys.deliver(key);
      return;
    }
    switch (key) {
      case '\r':
        if (busy) return; // real Claude would queue it; the runner never types while busy
        void submit();
        return;
      case '\n':
        input += '\n';
        out('\r\n  ');
        return;
      case '\x03': {
        if (input) {
          input = '';
          shellMode = false;
          line();
          return showPrompt();
        }
        if (busy) return interrupt();
        const now = Date.now();
        if (now - lastCtrlC < 1500) return void exit('prompt_input_exit');
        lastCtrlC = now;
        line();
        line('Press Ctrl-C again to exit');
        return showPrompt();
      }
      case '\x04':
        if (!input) void exit('prompt_input_exit');
        return;
      case '\x1b':
        if (busy) interrupt();
        return;
      case '\x7f':
        input = input.slice(0, -1);
        out('\b \b');
        return;
      default:
        if (key >= ' ') {
          input += key;
          out(key);
        }
    }
  }

  readTerminalInput({
    onKey: handleKey,
    onPaste: (content) => {
      if (mode === 'prompt') insertPaste(content);
    },
  });

  // --- start-up
  out('\x1b[?2004h');
  out(`\x1b]0;${opts.name ?? 'fake-claude'}\x07`);
  line(`Fake Claude Code ${VERSION} · session ${sessionId} · model ${opts.model ?? 'default'}`);

  if (process.env.FAKE_CLAUDE_CONFIG_FILE && !isTrusted(process.env.FAKE_CLAUDE_CONFIG_FILE, cwd)) {
    line('Quick safety check: Is this a project you created or one you trust?');
    line('❯ 1. Yes, I trust this folder');
    line('  2. No, exit');
    mode = 'trust';
    await awaitTrust(keys);
    mode = 'prompt';
    out('\x1b[3A\x1b[J'); // an answered dialog disappears, as in Claude Code's UI
  }

  await sleep(Number(process.env.FAKE_CLAUDE_STARTUP_DELAY_MS ?? 50));
  await runHooks(
    'SessionStart',
    { source: opts.resume ? 'resume' : 'startup', model: opts.model ?? 'claude-fake' },
    opts.resume ? 'resume' : 'startup',
  );

  if (process.env.FAKE_CLAUDE_MCP_DIALOG) {
    // Like Claude Code's approval of a project's .mcp.json servers: it covers the prompt box,
    // swallows pastes, and disappears once answered.
    line('New MCP server found in this project: fake-db');
    line('❯ 1. Use this and all future MCP servers in this project');
    line('  2. Continue without using this MCP server');
    mode = 'question';
    await keys.wait();
    mode = 'prompt';
    out('\x1b[3A\x1b[J');
  }
  showPrompt();
}

function loadSettings(value) {
  if (!value) return null;
  try {
    return JSON.parse(value.trim().startsWith('{') ? value : readFileSync(value, 'utf8'));
  } catch {
    return null;
  }
}

function isTrusted(configFile, cwd) {
  let config;
  try {
    config = JSON.parse(readFileSync(configFile, 'utf8'));
  } catch {
    return false;
  }
  let dir;
  try {
    dir = realpathSync(cwd);
  } catch {
    dir = cwd;
  }
  for (;;) {
    if (config?.projects?.[dir]?.hasTrustDialogAccepted === true) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}
