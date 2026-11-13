import { lstatSync } from 'node:fs';
import { createServer } from 'node:net';
import { relative, resolve } from 'node:path';
import { z } from 'zod';
import { RUN_FACTS_PREFIX } from './reporter';
import type { ErrorFact, RunFacts } from './reporter';

/** What the members' sandbox was seen to refuse in this process (PM-1406). */
export type SandboxRefusals = { listen: boolean };

/** A test file the sandbox kept from running, with the system error that shows it. */
export interface SandboxNotRun {
  /** The repository path. */
  file: string;
  /** For example `listen EPERM 127.0.0.1` or `open EPERM <path>`. */
  reason: string;
  /** The failed tests, suites and module errors of the file. */
  tests: number;
}

interface ClassifyOptions {
  /** The repository root, to turn the absolute module ids into repository paths. */
  root: string;
  /** The directory a relative error path is relative to (the workspace the step ran in). */
  workspaceDir: string;
  /** True when this process is refused reading the path too (not merely a failing test). */
  readDenied: (path: string) => boolean;
}

const errorFactSchema = z.object({
  message: z.string(),
  code: z.string().optional(),
  syscall: z.string().optional(),
  address: z.string().optional(),
  path: z.string().optional(),
});
const runFactsSchema = z.object({
  reason: z.enum(['passed', 'failed', 'interrupted']),
  unhandled: z.array(errorFactSchema),
  failed: z.array(
    z.object({
      file: z.string(),
      failures: z.array(z.object({ name: z.string(), errors: z.array(errorFactSchema) })),
    }),
  ),
}) satisfies z.ZodType<RunFacts>;

const LISTEN_SYSCALLS = new Set(['listen', 'bind']);
/** The read-side calls of the file system; a write (mkdir, unlink, ...) is never confirmed as a sandbox refusal. */
const READ_SYSCALLS = new Set([
  'open',
  'stat',
  'lstat',
  'scandir',
  'opendir',
  'readlink',
  'realpath',
  'access',
]);

/** Reads the last facts line of the output; `null` when there is none or it is not valid. */
function readFacts(output: string): RunFacts | null {
  const line = output
    .split(/\r?\n/)
    .reverse()
    .find((candidate) => candidate.startsWith(RUN_FACTS_PREFIX));
  if (line === undefined) return null;
  try {
    const parsed = runFactsSchema.safeParse(JSON.parse(line.slice(RUN_FACTS_PREFIX.length)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The sandbox signature of one error fact, as the reason text; `null` when it is none. */
function signature(fact: ErrorFact, refusals: SandboxRefusals, options: ClassifyOptions): string | null {
  const { code, syscall, address, path } = fact;
  if (syscall && LISTEN_SYSCALLS.has(syscall) && (code === 'EPERM' || code === 'EACCES') && refusals.listen) {
    return `${syscall} ${code}${address ? ` ${address}` : ''}`;
  }
  // EACCES is an ordinary permission problem: only EPERM is the sandbox's own refusal.
  if (code === 'EPERM' && syscall && READ_SYSCALLS.has(syscall) && path) {
    return options.readDenied(resolve(options.workspaceDir, path)) ? `${syscall} EPERM ${path}` : null;
  }
  return null;
}

/**
 * The test files a failed run did not run because of the members' sandbox, or `null` when the failure
 * has to stay a failure: no facts line, a run that did not end `failed`, an unhandled error, or any
 * failed file with a test, suite or module error that carries no sandbox signature (an assertion
 * failure included). A file counts only when every failure in it has one.
 */
export function sandboxNotRun(
  output: string,
  refusals: SandboxRefusals,
  options: ClassifyOptions,
): SandboxNotRun[] | null {
  const facts = readFacts(output);
  if (!facts || facts.reason !== 'failed' || facts.unhandled.length > 0 || facts.failed.length === 0)
    return null;
  const found: SandboxNotRun[] = [];
  for (const file of facts.failed) {
    const reasons: string[] = [];
    for (const entity of file.failures) {
      const reason = entity.errors.map((fact) => signature(fact, refusals, options)).find((r) => r !== null);
      if (reason === undefined || reason === null) return null;
      if (!reasons.includes(reason)) reasons.push(reason);
    }
    found.push({
      file: relative(options.root, file.file).split('\\').join('/'),
      reason: reasons.join('; '),
      tests: file.failures.length,
    });
  }
  return found;
}

/** True when this process cannot even stat the path: the sandbox's read refusal. */
export function readDenied(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Whether this is the members' sandbox (the signal `PROJECTMAN_SKIP_PTY_TESTS=1`, as the merge-test reads it)
 * and what it refuses here: `null` outside it, so nothing is classified. A try at the loopback tells
 * whether binding is refused; the Claude sandbox allows it, so a listen failure there stays a failure.
 */
export async function probeSandbox(env: NodeJS.ProcessEnv = process.env): Promise<SandboxRefusals | null> {
  if (env.PROJECTMAN_SKIP_PTY_TESTS !== '1') return null;
  return new Promise<SandboxRefusals>((done) => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) =>
      done({ listen: error.code === 'EPERM' || error.code === 'EACCES' }),
    );
    server.listen(0, '127.0.0.1', () => server.close(() => done({ listen: false })));
  });
}
