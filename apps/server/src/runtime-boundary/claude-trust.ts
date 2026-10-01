import path from 'node:path';
import { ensureWorkspaceTrusted } from '../runner';

/**
 * The launcher's `claude-trust` helper (`dist/claude-trust.js`): run as a worker, it records
 * Claude Code's workspace trust for one directory of that worker's home in the worker's own
 * ~/.claude.json, so the session does not stop at the trust screen. It runs with the worker's
 * rights only; the service never writes a worker's files.
 */
async function main(): Promise<void> {
  const home = process.env.HOME;
  const dir = process.argv[2];
  if (!home || !path.isAbsolute(home)) throw new Error('HOME is not set');
  if (!dir || !path.isAbsolute(dir) || path.normalize(dir) !== dir) throw new Error('an absolute directory is required');
  if (dir !== home && !dir.startsWith(`${home}/`)) throw new Error('the directory must be inside HOME');
  const outcome = await ensureWorkspaceTrusted(path.join(home, '.claude.json'), dir);
  process.stdout.write(`${JSON.stringify({ result: outcome.result })}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
});
