import { watch, type FSWatcher } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { openConfined } from './confined';

/**
 * Follows a JSONL file as it grows: reads from a byte offset, hands over complete lines only
 * (a half-written last line waits for the next read), reacts to fs.watch events and polls as
 * a fallback (the file may not exist yet, and watchers can miss events).
 * The incremental read follows agent-office (MIT, src/server/usage.ts).
 */

export interface TailerOptions {
  path: string;
  /** Begin at the start of the file, or at its current end (a resumed conversation). */
  from: 'start' | 'end';
  onLines(lines: string[]): void;
  onError?(err: unknown): void;
  pollIntervalMs?: number;
  /**
   * A worker home (PM-140): every read opens the file with `openConfined`, so a symlink, a FIFO
   * or a file outside the home is never read, also when it is swapped in later.
   */
  confineTo?: string;
}

const CHUNK = 1024 * 1024;
const DEFAULT_POLL_MS = 500;

export class TranscriptTailer {
  readonly path: string;
  private readonly opts: TailerOptions;
  private offset = 0;
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<void> | null = null;
  private again = false;
  private stopped = false;

  constructor(opts: TailerOptions) {
    this.opts = opts;
    this.path = opts.path;
  }

  /** Positions the tailer and delivers what is already there (for `from: 'start'`). */
  async start(): Promise<void> {
    if (this.opts.from === 'end') {
      try {
        this.offset = (await stat(this.path)).size;
      } catch {
        this.offset = 0;
      }
    }
    const interval = this.opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.timer = setInterval(() => void this.poll(), interval);
    this.timer.unref();
    this.ensureWatcher();
    await this.poll();
  }

  /** Reads whatever was appended since the last read. Concurrent calls share one read loop. */
  poll(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.current) {
      this.again = true;
      return this.current;
    }
    this.current = (async () => {
      try {
        do {
          this.again = false;
          await this.readNew();
        } while (this.again && !this.stopped);
      } catch (err) {
        this.opts.onError?.(err);
      } finally {
        this.current = null;
      }
    })();
    return this.current;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
  }

  private ensureWatcher(): void {
    if (this.watcher || this.stopped) return;
    try {
      const watcher = watch(this.path, { persistent: false }, () => void this.poll());
      watcher.on('error', () => {
        watcher.close();
        if (this.watcher === watcher) this.watcher = null;
      });
      this.watcher = watcher;
    } catch {
      // The file does not exist yet; polling picks it up and retries the watcher.
    }
  }

  private async readNew(): Promise<void> {
    let handle;
    try {
      handle = this.opts.confineTo
        ? await openConfined(this.path, this.opts.confineTo)
        : await open(this.path, 'r');
    } catch {
      return; // not written yet (or refused, when confined)
    }
    this.ensureWatcher();
    try {
      const { size } = await handle.stat();
      if (size < this.offset) this.offset = 0; // truncated or replaced: start over
      let want = CHUNK;
      while (this.offset < size && !this.stopped) {
        const len = Math.min(want, size - this.offset);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await handle.read(buf, 0, len, this.offset);
        if (bytesRead <= 0) break;
        const end = buf.lastIndexOf(0x0a, bytesRead - 1);
        if (end < 0) {
          if (bytesRead < size - this.offset) {
            want *= 2; // a single line longer than the chunk
            continue;
          }
          break; // the last line is still being written
        }
        const text = buf.toString('utf8', 0, end);
        this.offset += end + 1;
        want = CHUNK;
        const lines = text.split('\n').filter((line) => line.trim().length > 0);
        if (lines.length > 0) this.opts.onLines(lines);
      }
    } finally {
      await handle.close();
    }
  }
}
