import { createRequire } from 'node:module';
import type { Terminal } from '@xterm/headless';
import type { SerializeAddon } from '@xterm/addon-serialize';

const require = createRequire(import.meta.url);
let headless: typeof import('@xterm/headless') | undefined;
let serialize: typeof import('@xterm/addon-serialize') | undefined;

function terminalPackages() {
  headless ??= require('@xterm/headless') as typeof import('@xterm/headless');
  serialize ??= require('@xterm/addon-serialize') as typeof import('@xterm/addon-serialize');
  return { Terminal: headless.Terminal, SerializeAddon: serialize.SerializeAddon };
}

/** Lines of scrollback kept per session. */
const SCROLLBACK = 5000;

/** DECSET modes xterm.js reads as a mouse report encoding (SGR and SGR pixels). */
const MOUSE_ENCODINGS = [1006, 1016];

/**
 * A headless copy of a session's terminal: everything the PTY printed, parsed like a real
 * terminal, so a browser that attaches later gets the current screen and scrollback.
 */
export class HeadlessScreen {
  private readonly term: Terminal;
  private readonly serializer: SerializeAddon;
  private mouseEncoding: number | undefined;

  constructor(cols: number, rows: number) {
    const { Terminal, SerializeAddon } = terminalPackages();
    this.term = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
    this.trackMouseEncoding();
  }

  get cols(): number {
    return this.term.cols;
  }

  get rows(): number {
    return this.term.rows;
  }

  /** Whether the program enabled bracketed paste (Claude Code does once its prompt is up). */
  get bracketedPasteMode(): boolean {
    return this.term.modes.bracketedPasteMode;
  }

  write(data: string): void {
    this.term.write(data);
  }

  /** Resolves once everything written so far has been parsed. */
  flush(): Promise<void> {
    return new Promise((resolve) => this.term.write('', resolve));
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  /** Screen and scrollback as escape sequences that rebuild them in a fresh terminal. */
  snapshot(): string {
    const data = this.serializer.serialize({ scrollback: SCROLLBACK });
    return this.mouseEncoding ? `${data}\x1b[?${this.mouseEncoding}h` : data;
  }

  /**
   * Text of the visible rows. With `lastRows`, only the last rows that have content: an inline
   * TUI like Claude Code draws from the top of a fresh screen, so its prompt box (or a dialog
   * in its place) is the end of the content, not necessarily the bottom of the screen.
   */
  screenText(lastRows?: number): string {
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < this.term.rows; y++) {
      lines.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? '');
    }
    if (lastRows === undefined) return lines.join('\n');
    let end = lines.length;
    while (end > 0 && lines[end - 1]!.trim() === '') end -= 1;
    return lines.slice(Math.max(0, end - lastRows), end).join('\n');
  }

  dispose(): void {
    this.term.dispose();
  }

  /**
   * The serialize addon restores mouse tracking but not its encoding, so a browser attaching
   * to a program using SGR mouse reports would send the wrong format. Follow the encoding and
   * append it to snapshots. Taken from agent-office (MIT, src/server/screen.ts).
   */
  private trackMouseEncoding(): void {
    const decset = (on: boolean) => (params: (number | number[])[]) => {
      for (const p of params) {
        if (typeof p === 'number' && MOUSE_ENCODINGS.includes(p)) this.mouseEncoding = on ? p : undefined;
      }
      return false; // xterm.js still applies the mode itself
    };
    this.term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, decset(true));
    this.term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, decset(false));
    this.term.parser.registerEscHandler({ final: 'c' }, () => {
      this.mouseEncoding = undefined; // full reset (RIS)
      return false;
    });
  }
}
