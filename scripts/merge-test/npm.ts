import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { OutputTail } from '../../apps/server/src/full-test/output';
import { FILE_EVENT_PREFIX } from './reporter';
import type { StepRun } from './steps';

const fileEventSchema = z.object({ phase: z.enum(['start', 'end']), id: z.string(), file: z.string() });

/**
 * Runs `npm <args>`: its output goes to this process's stdout and stderr as it arrives (the full test
 * executor reads the same stream) and the end of it is kept for the rerun rule. Rejects when the
 * child guard cannot start. Fixture tests disable forwarding to keep their deliberate failures
 * and reporter events out of the enclosing merge report; captured output is still returned.
 */
export function runNpm(
  args: string[],
  { fileTimeoutMs = 180_000, forwardOutput = true } = {},
): Promise<StepRun> {
  return new Promise((resolve, reject) => {
    const testing = args[0] === 'test';
    const command = testing
      ? [
          ...args,
          ...(args.includes('--') ? [] : ['--']),
          '--reporter=default',
          '--reporter=hanging-process',
          `--reporter=${fileURLToPath(new URL('./reporter.ts', import.meta.url))}`,
          '--testTimeout=20000',
          '--hookTimeout=20000',
        ]
      : args;
    // Reuse the guard's process-group cleanup, including when this controller is killed.
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('../lib/child-guard.mjs', import.meta.url)), 'npm', ...command],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const kept = new OutputTail();
    const active = new Map<string, { file: string; timer: ReturnType<typeof setTimeout> }>();
    let pending = '';
    let timedOut = false;
    const cleanup = () => {
      for (const entry of active.values()) clearTimeout(entry.timer);
      active.clear();
    };
    const observe = (line: string) => {
      if (!line.startsWith(FILE_EVENT_PREFIX) || timedOut) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line.slice(FILE_EVENT_PREFIX.length));
      } catch {
        return;
      }
      const result = fileEventSchema.safeParse(parsed);
      if (!result.success) return;
      const event = result.data;
      clearTimeout(active.get(event.id)?.timer);
      active.delete(event.id);
      if (event.phase !== 'start') return;
      const file = event.file;
      active.set(event.id, {
        file,
        timer: setTimeout(() => {
          timedOut = true;
          const output =
            // A file timeout must not become green through the flaky-file rerun rule.
            `\n⎯⎯⎯ Unhandled Errors ⎯⎯⎯\nFile deadline exceeded (${fileTimeoutMs} ms): ${file}\n` +
            [...active.values()].map((entry) => ` FAIL  ${entry.file}\n`).join('');
          if (forwardOutput) process.stderr.write(output);
          kept.push(output);
          cleanup();
          child.kill('SIGTERM');
        }, fileTimeoutMs),
      });
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (forwardOutput) process.stdout.write(chunk);
      kept.push(chunk);
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf('\n')) !== -1) {
        observe(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
      // Test console output can include very long lines; only reporter events need buffering.
      pending = pending.slice(-8192);
    });
    child.stderr.on('data', (chunk: string) => {
      if (forwardOutput) process.stderr.write(chunk);
      kept.push(chunk);
    });
    child.on('error', (error) => {
      cleanup();
      reject(error);
    });
    child.on('close', (code, signal) => {
      cleanup();
      resolve({
        code: timedOut ? 1 : (code ?? (signal ? 128 + constants.signals[signal] : 1)),
        signaled: !timedOut && code === null,
        output: kept.value(),
      });
    });
  });
}
