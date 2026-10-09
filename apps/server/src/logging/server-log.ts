import path from 'node:path';
import { createRotatingFile } from './rotating-file';

export const SERVER_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const SERVER_LOG_KEEP_FILES = 5;

/** `<home>/logs/<name>.log`: the server's (`server`) and the engine's (`engine`) log file (PM-444). */
export function serverLogFile(home: string, name: 'server' | 'engine'): string {
  return path.join(home, 'logs', `${name}.log`);
}

/**
 * A stream for pino (Fastify's `logger.stream`): every line goes to the terminal as before and to
 * `file`, rotated at `maxBytes` with `keep` files (so at most about `keep * maxBytes` on disk). The
 * lines are pino's own JSON, with the same serializers (request URLs carry no tokens), so the file
 * holds nothing the terminal did not. A failing file write never stops logging to the terminal:
 * the first failure is reported there, once.
 */
export function createServerLogStream(
  file: string,
  options: {
    maxBytes?: number;
    keep?: number;
    terminal?: { write(text: string): unknown };
  } = {},
): { write(text: string): void } {
  const terminal = options.terminal ?? process.stdout;
  const target = createRotatingFile(file, {
    maxBytes: options.maxBytes ?? SERVER_LOG_MAX_BYTES,
    keep: options.keep ?? SERVER_LOG_KEEP_FILES,
  });
  let reported = false;
  return {
    write(text) {
      terminal.write(text);
      try {
        target.append(text);
      } catch (error) {
        if (reported) return;
        reported = true;
        terminal.write(
          `${JSON.stringify({ level: 40, time: Date.now(), msg: `the log file ${file} cannot be written: ${String(error)}` })}\n`,
        );
      }
    },
  };
}
