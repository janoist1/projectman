// Builds the self-contained engine package of one commit (PM-1104, PM-1121):
//
//   npm run engine-app -- package --commit <sha> --out <dir> [--repo <https-url>]
//
// The package lands in <dir>/<sha>; see package.ts for its layout. Exit status: 0 done, 1 failed, 2 refused
// (also an existing, non-empty target), 64 wrong usage. Docs: docs/MACHINE-DEPENDENT.md "Engine app package".
import { acquireHeavyLock, defaultHeavyLockDir, runSandboxed } from '../../apps/server/src/full-test';
import { realDeps } from '../cloud/deps';
import { runEngineAppCli } from './commands';
import { buildEnginePackage } from './package';

const deps = realDeps();
const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => abort.abort());

runEngineAppCli(process.argv.slice(2), {
  sourceRepo: deps.repoRoot,
  cwd: process.cwd(),
  originUrl: async () => {
    const result = await deps.run('git', ['-C', deps.repoRoot, 'remote', 'get-url', 'origin']);
    return result.code === 0 ? result.stdout.trim() || null : null;
  },
  build: (request) =>
    buildEnginePackage(
      {
        run: deps.run,
        fetch: deps.fetch,
        now: deps.now,
        homeDir: deps.homeDir,
        platform: process.platform,
        arch: process.arch,
        sandbox: runSandboxed,
        heavyLock: (label, signal) => acquireHeavyLock({ dir: defaultHeavyLockDir(), label, signal }),
        out: (line) => process.stdout.write(`${line}\n`),
      },
      request,
      { signal: abort.signal },
    ),
  out: (text) => console.log(text),
  err: (text) => console.error(text),
}).then((code) => process.exit(code));
