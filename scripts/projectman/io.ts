import { randomUUID } from 'node:crypto';
import os from 'node:os';

/** What the client touches outside itself; the tests lend their own. */
export interface CliIo {
  stdout: { write(chunk: string, done: (error?: Error | null) => void): unknown };
  stderr: { write(chunk: string): unknown };
  stdin: AsyncIterable<string | Uint8Array>;
  home: string;
  fetch: typeof fetch;
  /** Aborted by Ctrl-C (SIGINT) or SIGTERM. */
  signal: AbortSignal;
  newRequestId(): string;
  /** Waits; ends early (resolves) when the signal aborts. */
  delay(ms: number, signal: AbortSignal): Promise<void>;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** The real streams and the real network; Ctrl-C and SIGTERM abort `signal`. */
export function processIo(): CliIo {
  const controller = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM'] as const) process.once(name, () => controller.abort());
  // A closed pipe on standard output is a failed write (the write callback gets it), not a crash.
  process.stdout.on('error', () => undefined);
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    home: os.homedir(),
    fetch: globalThis.fetch,
    signal: controller.signal,
    newRequestId: () => randomUUID(),
    delay,
  };
}
