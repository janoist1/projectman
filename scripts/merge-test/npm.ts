import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { OutputTail } from '../../apps/server/src/full-test/output';
import type { StepRun } from './steps';

/**
 * Runs `npm <args>`: its output goes to this process's stdout and stderr as it arrives (the full test
 * executor reads the same stream) and the end of it is kept for the rerun rule. Rejects when npm
 * cannot start.
 */
export function runNpm(args: string[]): Promise<StepRun> {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', args, { stdio: ['inherit', 'pipe', 'pipe'] });
    const kept = new OutputTail();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      process.stdout.write(chunk);
      kept.push(chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      process.stderr.write(chunk);
      kept.push(chunk);
    });
    child.on('error', reject);
    child.on('close', (code, signal) =>
      resolve({
        code: code ?? (signal ? 128 + constants.signals[signal] : 1),
        signaled: code === null,
        output: kept.value(),
      }),
    );
  });
}
