import type { ChatItem } from '@projectman/shared';
import type { MockBackend, MockConnection } from './backend';

const ESC = '\x1b[';
const reset = `${ESC}0m`;
const dim = (text: string) => `${ESC}90m${text}${reset}`;
const bold = (text: string) => `${ESC}1m${text}${reset}`;
const tool = (text: string) => `${ESC}38;5;147m${text}${reset}`;
const ok = (text: string) => `${ESC}38;5;79m${text}${reset}`;
const warn = (text: string) => `${ESC}38;5;215m${text}${reset}`;
const bad = (text: string) => `${ESC}38;5;210m${text}${reset}`;
const team = (text: string) => `${ESC}38;5;117m${text}${reset}`;

const COLS = 100;
const ROWS = 30;

function lines(text: string): string[] {
  return text.split('\n').flatMap((line) => {
    const out: string[] = [];
    for (let i = 0; i < Math.max(1, line.length); i += COLS - 4) out.push(line.slice(i, i + COLS - 4));
    return out;
  });
}

/** Renders chat items roughly the way the Claude Code TUI prints them. */
function render(item: ChatItem): string {
  switch (item.kind) {
    case 'user_text':
      return lines(item.text).map((line, i) => (i === 0 ? bold(`> ${line}`) : `  ${line}`)).join('\r\n') + '\r\n';
    case 'assistant_text':
      return lines(item.text).map((line, i) => (i === 0 ? `● ${line}` : `  ${line}`)).join('\r\n') + '\r\n';
    case 'tool_call':
      return tool(`● ${item.name}(${item.summary})`) + '\r\n';
    case 'tool_result':
      return (item.ok ? dim(`  ⎿  ${item.summary}`) : bad(`  ⎿  ${item.summary}`)) + '\r\n';
    case 'team_message':
      return (
        team(`● team ${item.direction === 'in' ? `message from ${item.from}` : `send_message → ${item.to.join(', ')}`}`) +
        '\r\n' +
        dim(`  ⎿  ${lines(item.text)[0] ?? ''}`) +
        '\r\n'
      );
    case 'system_note':
      return dim(`  ${item.text}`) + '\r\n';
  }
}

/** Fake pseudo-terminals for mock mode: a screen built from the chat, echo, live updates. */
export class MockTerminals {
  private readonly viewers = new Map<string, Set<MockConnection>>();
  private readonly screens = new Map<string, string>();
  private readonly inputs = new Map<string, string>();
  private readonly backend: MockBackend;

  constructor(backend: MockBackend) {
    this.backend = backend;
  }

  attach(sessionId: string, connection: MockConnection): void {
    let set = this.viewers.get(sessionId);
    if (!set) {
      set = new Set();
      this.viewers.set(sessionId, set);
    }
    set.add(connection);
    connection.deliver({ type: 'terminal_snapshot', sessionId, data: this.screen(sessionId), cols: COLS, rows: ROWS });
  }

  detach(sessionId: string, connection: MockConnection): void {
    this.viewers.get(sessionId)?.delete(connection);
  }

  input(sessionId: string, data: string): void {
    let buffer = this.inputs.get(sessionId) ?? '';
    let out = '';
    for (const char of data) {
      if (char === '\r') {
        const line = buffer.trim();
        buffer = '';
        out += '\r\n';
        if (line.startsWith('/')) out += dim(`  ⎿  ${line}: bemutató módban a parancs nem fut`) + '\r\n';
        else if (line) out += `● Bemutató mód: a valódi terminálban itt a Claude Code válaszolna.\r\n`;
        out += bold('> ');
      } else if (char === '\x7f') {
        if (buffer.length > 0) {
          buffer = buffer.slice(0, -1);
          out += '\b \b';
        }
      } else if (char >= ' ') {
        buffer += char;
        out += char;
      }
    }
    this.inputs.set(sessionId, buffer);
    if (out) this.write(sessionId, out);
  }

  /** Mirrors new chat items into attached terminals. */
  echoChat(sessionId: string, items: ChatItem[]): void {
    if (!this.screens.has(sessionId)) return;
    this.write(sessionId, '\r\x1b[2K' + items.map(render).join('') + bold('> '));
  }

  private write(sessionId: string, data: string): void {
    this.screens.set(sessionId, (this.screens.get(sessionId) ?? '') + data);
    this.viewers.get(sessionId)?.forEach((connection) =>
      connection.deliver({ type: 'terminal_data', sessionId, data }),
    );
  }

  private screen(sessionId: string): string {
    const existing = this.screens.get(sessionId);
    if (existing !== undefined) return existing;
    const session = this.backend.findSession(sessionId);
    const header =
      dim('╭────────────────────────────────────────────────╮') +
      '\r\n' +
      dim('│ ') +
      bold('✻ Claude Code') +
      dim(`  ${session?.cwd ?? ''}`.slice(0, 34).padEnd(35)) +
      dim('│') +
      '\r\n' +
      dim('╰────────────────────────────────────────────────╯') +
      '\r\n\r\n';
    const body = (this.backend.chats[sessionId] ?? []).map(render).join('');
    const state =
      session?.state === 'waiting_permission'
        ? warn('  ⎿  Engedélyre vár (Rád vár lista)') + '\r\n'
        : session?.state === 'working'
          ? ok('  ⎿  dolgozik…') + '\r\n'
          : '';
    const screen = header + body + state + '\r\n' + bold('> ');
    this.screens.set(sessionId, screen);
    return screen;
  }
}
