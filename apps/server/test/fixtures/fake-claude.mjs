#!/usr/bin/env node
/**
 * fake-claude — a deterministic stand-in for the interactive Claude Code CLI, for automated
 * tests. It never calls any API. It speaks the parts of the protocol projectman relies on:
 *
 * FLAGS (same as `claude`): --session-id <uuid> | --resume <uuid>, --append-system-prompt,
 *   --mcp-config <json>, --settings <json|file>, --model, --permission-mode, -n/--name,
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
 * - Input (raw mode): bracketed pastes are inserted like Claude Code does: a paste of more
 *   than 800 chars or more than min(rows-10, 2) line breaks collapses to
 *   "[Pasted text #N +X lines]" and is submitted wrapped in <pasted_content id="N"> lines;
 *   a paste starting with "!" into an empty prompt switches to shell mode. Ctrl+J (LF)
 *   inserts a newline, Enter (CR) submits, Ctrl+C clears the input / interrupts / exits
 *   (twice), Ctrl+D on an empty prompt exits, Esc interrupts a running turn (writes
 *   "[Request interrupted by user]" and sends no Stop hook, like Claude Code).
 * - A submitted prompt: UserPromptSubmit hook (a "block" decision drops it), user entry, then
 *   after FAKE_CLAUDE_WORK_DELAY_MS (default 50; 800 if the prompt contains "SLOW"):
 *   - contains "PERMISSION": tool_use Bash {command:"git push"}, PreToolUse, then (unless an
 *     allow rule matches) a PermissionRequest hook with permission_suggestions; "allow" runs
 *     it (tool_result "Everything up-to-date", PostToolUse), "deny" writes an error
 *     tool_result with the message; no decision asks in the terminal (y/n).
 *     `updatedPermissions` addRules with destination "session" are remembered.
 *   - contains "TEAM": tool_use mcp__team__send_message {to:["qa"], text:"Ready for review"}
 *     (same permission flow; `permissions.allow` "mcp__team" or "mcp__team__*" pre-allows it).
 *   - contains "ASK": tool_use AskUserQuestion, PreToolUse, waits for a key in the terminal.
 *   - always: assistant text "Echo: <first line of the prompt>", then the Stop hook.
 * - "/exit", double Ctrl+C, Ctrl+D, SIGTERM or SIGHUP: SessionEnd hook, exit code 0.
 * - OSC 9;4 progress (busy/idle) and an OSC 0 title are emitted like Claude Code.
 *
 * PRINT MODE (-p --input-format stream-json): answers a `control_request` with subtype
 * "get_usage" with a `control_response` (FAKE_CLAUDE_USAGE = JSON of the answer, or a canned
 * one); it never answers prompts. Exits when stdin closes.
 *
 * DIAGNOSTICS: FAKE_CLAUDE_ARGS_FILE, when set, receives {argv, cwd, env} at start-up (env
 * without values of variables whose name contains KEY, TOKEN or SECRET, which are "<set>").
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VERSION = '0.0.0';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    permissionMode: null,
    name: null,
    inputFormat: null,
    outputFormat: null,
    version: false,
    help: false,
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
        break; // accepted and ignored
    }
  }
  return o;
}

const opts = parseArgs(process.argv.slice(2));

if (process.env.FAKE_CLAUDE_ARGS_FILE) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) env[k] = /KEY|TOKEN|SECRET/.test(k) ? '<set>' : v;
  writeFileSync(
    process.env.FAKE_CLAUDE_ARGS_FILE,
    JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env }, null, 2),
  );
}

if (opts.version) {
  process.stdout.write(`${VERSION} (Fake Claude Code)\n`);
  process.exit(0);
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
  const out = (text) => process.stdout.write(text);
  const line = (text = '') => out(`${text}\r\n`);
  const cwd = process.cwd();
  const sessionId = opts.resume ?? opts.sessionId ?? randomUUID();
  const transcriptDir = process.env.FAKE_CLAUDE_TRANSCRIPT_DIR || path.join(os.tmpdir(), 'fake-claude');
  mkdirSync(transcriptDir, { recursive: true });
  const transcriptPath = path.join(transcriptDir, `${sessionId}.jsonl`);
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
  const assistantEntry = (content) =>
    writeEntry({
      type: 'assistant',
      requestId: `req_fake_${++messageCounter}`,
      message: {
        id: `msg_fake_${messageCounter}`,
        type: 'message',
        role: 'assistant',
        model: opts.model ?? 'claude-fake',
        content,
        stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });

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

  function runCommandHook(hook, payload) {
    return new Promise((resolve) => {
      const child = Array.isArray(hook.args)
        ? spawn(hook.command, hook.args, { cwd, env: process.env })
        : spawn('/bin/sh', ['-c', hook.command], { cwd, env: process.env });
      let stdout = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), (hook.timeout ?? 600) * 1000);
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', () => undefined);
      child.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.on('close', () => {
        clearTimeout(timer);
        const text = stdout.trim();
        try {
          resolve(text.startsWith('{') ? JSON.parse(text) : null);
        } catch {
          resolve(null);
        }
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(JSON.stringify(payload));
    });
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
        else if (hook.type === 'command') runs.push(runCommandHook(hook, payload));
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
  const pastes = new Map();
  let pasteCounter = 0;
  let busy = false;
  let turn = 0;
  let mode = 'prompt'; // prompt | trust | question
  let pendingKey = null;
  let lastCtrlC = 0;
  let exiting = false;

  const progress = (on) => out(on ? '\x1b]9;4;3;\x07' : '\x1b]9;4;0;\x07');
  const showPrompt = () => out(`${shellMode ? '! ' : '> '}${input.replace(/\n/g, '\r\n  ')}`);

  function waitKey() {
    return new Promise((resolve) => {
      pendingKey = resolve;
    });
  }

  async function exit(reason) {
    if (exiting) return;
    exiting = true;
    await Promise.race([runHooks('SessionEnd', { reason }), sleep(1500)]);
    out('\x1b]9;4;0;\x07\x1b[?2004l');
    line();
    process.exit(0);
  }
  process.on('SIGTERM', () => void exit('other'));
  process.on('SIGHUP', () => void exit('other'));

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
      const id = ++pasteCounter;
      pastes.set(id, text);
      const placeholder = breaks === 0 ? `[Pasted text #${id}]` : `[Pasted text #${id} +${breaks} lines]`;
      input += placeholder;
      out(placeholder);
    } else {
      input += text;
      out(text.replace(/\n/g, '\r\n  '));
    }
  }

  function expandPastes(text) {
    return text.replace(/\[Pasted text #(\d+)(?: \+\d+ lines)?\]/g, (match, id) => {
      const content = pastes.get(Number(id));
      return content === undefined
        ? match
        : `<pasted_content id="${id}">\n${content}\n</pasted_content id="${id}">`;
    });
  }

  async function submit() {
    const raw = input;
    const wasShell = shellMode;
    input = '';
    shellMode = false;
    line();
    const text = expandPastes(raw).trim();
    pastes.clear();
    if (!text) return showPrompt();
    if (wasShell) {
      userEntry(`<bash-input>${text}</bash-input>`);
      userEntry(`<bash-stdout>fake shell output</bash-stdout><bash-stderr></bash-stderr>`);
      line(`! ${text}`);
      return showPrompt();
    }
    if (text === '/exit') return exit('prompt_input_exit');
    await runTurn(text);
  }

  async function toolCall(name, toolInput, okResult, toolResponse) {
    const toolUseId = `toolu_fake_${turn}_${name}`;
    assistantEntry([{ type: 'tool_use', id: toolUseId, name, input: toolInput }]);
    line(`● ${name}(${JSON.stringify(toolInput).slice(0, 60)})`);
    await runHooks('PreToolUse', { tool_name: name, tool_input: toolInput, tool_use_id: toolUseId }, name);
    let allowed = isAllowed(name, toolInput);
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
        const key = await waitKey();
        mode = 'prompt';
        allowed = key === 'y' || key === '1' || key === '\r';
      }
    }
    if (!busy) return false; // interrupted meanwhile
    if (allowed) {
      userEntry([{ type: 'tool_result', tool_use_id: toolUseId, content: okResult, is_error: false }], {
        toolUseResult: toolResponse,
      });
      line(`  ⎿ ${okResult}`);
      await runHooks(
        'PostToolUse',
        { tool_name: name, tool_input: toolInput, tool_use_id: toolUseId, tool_response: toolResponse },
        name,
      );
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

    if (text.includes('PERMISSION')) {
      const ok = await toolCall(
        'Bash',
        { command: 'git push', description: 'Push the branch' },
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
    if (text.includes('TEAM')) {
      const ok = await toolCall(
        'mcp__team__send_message',
        { to: ['qa'], text: 'Ready for review' },
        'Delivered to qa',
        [{ type: 'text', text: 'Delivered to qa' }],
      );
      if (!ok || !busy || turn !== myTurn) return;
    }
    if (text.includes('ASK')) {
      const toolUseId = `toolu_fake_${turn}_ask`;
      const toolInput = {
        questions: [{ question: 'Which option?', options: [{ label: 'One' }, { label: 'Two' }] }],
      };
      assistantEntry([{ type: 'tool_use', id: toolUseId, name: 'AskUserQuestion', input: toolInput }]);
      await runHooks(
        'PreToolUse',
        { tool_name: 'AskUserQuestion', tool_input: toolInput, tool_use_id: toolUseId },
        'AskUserQuestion',
      );
      line('Which option? 1. One  2. Two');
      mode = 'question';
      const key = await waitKey();
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

    const reply = `Echo: ${text.split('\n')[0]}`;
    assistantEntry([{ type: 'text', text: reply }]);
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
    if (pendingKey) {
      const resolve = pendingKey;
      pendingKey = null;
      mode = 'prompt';
      resolve('\x1b');
    }
    userEntry([{ type: 'text', text: '[Request interrupted by user]' }]);
    progress(false);
    line();
    line('Interrupted');
    showPrompt();
  }

  // --- raw input parsing
  let pending = '';
  let inPaste = false;
  let pasteBuffer = '';
  let escTimer = null;

  function handleKey(key) {
    if (mode === 'trust' || mode === 'question') {
      if (pendingKey) {
        const resolve = pendingKey;
        pendingKey = null;
        resolve(key);
      }
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

  function feed(data) {
    pending += data;
    while (pending.length > 0) {
      if (inPaste) {
        const end = pending.indexOf('\x1b[201~');
        if (end < 0) {
          pasteBuffer += pending;
          pending = '';
          return;
        }
        pasteBuffer += pending.slice(0, end);
        pending = pending.slice(end + 6);
        inPaste = false;
        const content = pasteBuffer;
        pasteBuffer = '';
        if (mode === 'prompt') insertPaste(content);
        continue;
      }
      if (pending.startsWith('\x1b[200~')) {
        inPaste = true;
        pending = pending.slice(6);
        continue;
      }
      if (pending.startsWith('\x1b')) {
        if (pending.length < 6 && '\x1b[200~'.startsWith(pending)) {
          // Possibly the start of a paste split across reads: wait briefly for the rest.
          if (!escTimer) {
            escTimer = setTimeout(() => {
              escTimer = null;
              if (pending.startsWith('\x1b') && !pending.startsWith('\x1b[200~')) {
                pending = pending.slice(1);
                handleKey('\x1b');
                feed('');
              }
            }, 30);
          }
          return;
        }
        const seq = /^\x1b\[[0-9;]*[A-Za-z~]/.exec(pending);
        if (seq) {
          pending = pending.slice(seq[0].length); // cursor keys etc.: ignored
          continue;
        }
        pending = pending.slice(1);
        handleKey('\x1b');
        continue;
      }
      const ch = String.fromCodePoint(pending.codePointAt(0));
      pending = pending.slice(ch.length);
      handleKey(ch);
    }
  }

  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data) => {
    if (escTimer) {
      clearTimeout(escTimer);
      escTimer = null;
    }
    feed(data);
  });
  process.stdin.resume();

  // --- start-up
  out('\x1b[?2004h');
  out(`\x1b]0;${opts.name ?? 'fake-claude'}\x07`);
  line(`Fake Claude Code ${VERSION} · session ${sessionId} · model ${opts.model ?? 'default'}`);

  if (process.env.FAKE_CLAUDE_CONFIG_FILE && !isTrusted(process.env.FAKE_CLAUDE_CONFIG_FILE, cwd)) {
    line('Quick safety check: Is this a project you created or one you trust?');
    line('❯ 1. Yes, I trust this folder');
    line('  2. No, exit');
    mode = 'trust';
    for (;;) {
      const key = await waitKey();
      if (key === '\r' || key === '1') break;
      if (key === '2' || key === '\x1b') {
        line('Exiting');
        process.exit(1);
      }
    }
    mode = 'prompt';
    line();
  }

  await sleep(Number(process.env.FAKE_CLAUDE_STARTUP_DELAY_MS ?? 50));
  await runHooks(
    'SessionStart',
    { source: opts.resume ? 'resume' : 'startup', model: opts.model ?? 'claude-fake' },
    opts.resume ? 'resume' : 'startup',
  );
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
