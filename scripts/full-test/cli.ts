import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { fullTestSandbox } from '../../apps/server/src/runtime/sessions';
import { createFullTestExecutor, defaultHeavyLockDir, quoteShellWord } from '../../apps/server/src/full-test';
import { parseFullTestArgs } from './args';

async function main(): Promise<number> {
  const args = parseFullTestArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const userHome = os.homedir();
  const gitDir = path.resolve(
    cwd,
    execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim(),
  );
  const executor = createFullTestExecutor({
    logger: Fastify({ logger: true }).log,
    heavyLockDir: defaultHeavyLockDir(),
  });
  const available = await executor.available();
  if (!available.ok) {
    console.error(`full-test: error (${available.reason}); duration: 0ms`);
    return 2;
  }
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    const result = await executor.run(
      {
        runId: randomUUID(),
        cwd,
        command: args.command.map(quoteShellWord).join(' '),
        maxWorkers: args.workers,
        timeoutMs: args.timeoutMinutes * 60_000,
        sandbox: fullTestSandbox({
          checkout: cwd,
          gitDir,
          userHome,
          appHome: process.env.PROJECTMAN_HOME || path.join(userHome, '.projectman'),
        }),
      },
      abort.signal,
    );
    console.log(`full-test: ${result.outcome}${result.reason ? ` (${result.reason})` : ''}`);
    console.log(`duration: ${result.durationMs}ms (${(result.durationMs / 60_000).toFixed(2)} minutes)`);
    console.log(`failed files: ${result.failedFiles.join(', ') || 'none'}`);
    if (result.outputTail) console.log(result.outputTail);
    return result.outcome === 'passed' ? 0 : result.outcome === 'failed' ? 1 : 2;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`full-test: error (${error instanceof Error ? error.message : String(error)})`);
    process.exitCode = 2;
  });
