import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { out, line, readTerminalInput, runCommandHook, writeArgsFile, exitOnSignals } from './fake-tui.mjs';

const argv = process.argv.slice(2);
const value = (name) => argv[argv.indexOf(name) + 1];
const dir = value('--gemini_dir');
if (!dir) throw new Error('Missing --gemini_dir');
mkdirSync(dir, { recursive: true });
const log = value('--log-file');
if (log) writeFileSync(log, `authMethod=${process.env.FAKE_GEMINI_AUTH_METHOD ?? 'consumer'}\n`);
if (argv.includes('models')) {
  if (process.env.FAKE_GEMINI_LOGGED_OUT === '1') {
    process.stderr.write('Please sign in\n');
    process.exit(1);
  }
  line('gemini-3.8-flash-low\tGemini 3.8 Flash (Low)');
  process.exit(0);
}
const conversationId = argv.includes('--conversation') ? value('--conversation') : randomUUID();
const brain = path.join(dir, 'antigravity-cli', 'brain', conversationId);
const transcriptPath = path.join(brain, '.system_generated', 'logs', 'transcript_full.jsonl');
mkdirSync(path.dirname(transcriptPath), { recursive: true });
const hooks = JSON.parse(readFileSync(path.join(dir, 'config', 'hooks.json'), 'utf8')).projectman;
const mcp = JSON.parse(readFileSync(path.join(dir, 'config', 'mcp_config.json'), 'utf8')).mcpServers.team;
if (process.env.FAKE_GEMINI_ARGS_FILE)
  writeArgsFile(process.env.FAKE_GEMINI_ARGS_FILE, { conversationId, transcriptPath });
let step = 0,
  input = '',
  busy = false;
const entry = (type, data = {}) =>
  appendFileSync(
    transcriptPath,
    JSON.stringify({
      step_index: step++,
      type,
      status: 'DONE',
      created_at: new Date().toISOString(),
      ...data,
    }) + '\n',
  );
const base = () => ({
  conversationId,
  transcriptPath,
  artifactDirectoryPath: brain,
  workspacePaths: [process.cwd()],
  modelName: value('--model'),
});
async function hook(event, extra = {}) {
  let answer = {};
  for (const item of hooks[event] ?? [])
    for (const h of item.hooks ?? [item])
      answer = await runCommandHook(h, { ...base(), ...extra }, { cwd: process.cwd(), requireSuccess: true });
  return answer;
}
function ready() {
  out('\x1b[2J\x1b[H');
  line('Antigravity CLI 1.2.17');
  line('────────────────────────────────────────────────────────────');
  line('>');
  line('────────────────────────────────────────────────────────────');
  line('? for shortcuts');
}
async function turn(prompt) {
  busy = true;
  out('\x1b[2J\x1b[H');
  line('Generating...');
  line('esc to cancel');
  entry('USER_INPUT', { content: `<USER_REQUEST>\n${prompt}\n</USER_REQUEST>` });
  const injected = await hook('PreInvocation', { invocationNum: 0, initialNumSteps: step });
  for (const item of injected?.injectSteps ?? [])
    if (item.ephemeralMessage) entry('EPHEMERAL_MESSAGE', { content: item.ephemeralMessage });
  if (prompt === 'credits') {
    line('Your AI credits balance is too low to continue.');
    busy = false;
    return;
  }
  let tool;
  if (prompt.startsWith('command:'))
    tool = { name: 'run_command', args: { CommandLine: prompt.slice(8).trim(), Cwd: process.cwd() } };
  if (prompt.startsWith('read:'))
    tool = { name: 'view_file', args: { AbsolutePath: prompt.slice(5).trim() } };
  if (prompt.startsWith('write:'))
    tool = {
      name: 'write_to_file',
      args: { TargetFile: prompt.slice(6).trim(), CodeContent: 'fake content' },
    };
  if (prompt === 'team')
    tool = {
      name: 'call_mcp_tool',
      args: { ServerName: 'team', ToolName: 'get_task', Arguments: { task_key: 'AR-1' } },
    };
  if (tool) {
    entry('PLANNER_RESPONSE', {
      tool_calls: [tool],
      input_tokens: 100,
      cache_read_tokens: 5,
      output_tokens: 10,
    });
    const stepIdx = step;
    const decision = await hook('PreToolUse', { toolCall: tool, stepIdx });
    let content = 'Tool call denied',
      error = '';
    if (decision?.decision === 'allow') {
      content = 'Tool completed';
      try {
        if (tool.name === 'view_file') content = readFileSync(tool.args.AbsolutePath, 'utf8');
        if (tool.name === 'write_to_file') writeFileSync(tool.args.TargetFile, tool.args.CodeContent);
        if (tool.name === 'call_mcp_tool') {
          const client = new Client({ name: 'fake-gemini', version: '0.0.0' });
          try {
            await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url)));
            content = JSON.stringify(
              await client.callTool({ name: tool.args.ToolName, arguments: tool.args.Arguments }),
            );
          } finally {
            await client.close();
          }
        }
        // Commands are simulated: no test prompt can execute arbitrary code.
      } catch (err) {
        error = String(err);
        content = error;
      }
      entry('GENERIC', { content, ...(error ? { status: 'ERROR', error } : {}) });
      await hook('PostToolUse', { toolCall: tool, stepIdx, error });
    } else entry('GENERIC', { content, status: 'ERROR', error: decision?.reason ?? content });
    await hook('PreInvocation', { invocationNum: 1, initialNumSteps: step });
  }
  entry('PLANNER_RESPONSE', {
    content: `DONE: ${prompt}`,
    input_tokens: 110,
    cache_read_tokens: 6,
    output_tokens: 12,
  });
  await hook('Stop', { fullyIdle: true, error: '', terminationReason: 'NO_TOOL_CALL' });
  busy = false;
  ready();
}
const exit = exitOnSignals({ sessionEnd: async () => {}, restore: '\x1b[?2004l' });
readTerminalInput({
  onPaste(text) {
    input += text;
  },
  onKey(key) {
    if (key === '\x03' || key === '\x04') {
      void exit();
      return;
    }
    if (key === '\x1b') {
      void hook('Stop', { fullyIdle: true, error: '' });
      busy = false;
      ready();
      return;
    }
    if (busy) return;
    if (key === '\r') {
      const prompt = input;
      input = '';
      if (prompt) void turn(prompt);
    } else input += key;
  },
});
out('\x1b[?2004h');
if (process.env.FAKE_GEMINI_SCREEN === 'trust') line('Do you trust the contents of this project?');
else if (process.env.FAKE_GEMINI_SCREEN === 'onboarding') line('Choose your color scheme:');
else ready();
