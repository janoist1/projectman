// Builds a self-contained engine package and its distributable macOS app (PM-1104, PM-1121, PM-1122):
//
//   npm run engine-app -- package --commit <sha> --out <dir> [--repo <https-url>]
//   npm run engine-app -- build --package <dir> --out <dir> [--ad-hoc]
//
// The package lands in <dir>/<sha>; see package.ts for its layout. Exit status: 0 done, 1 failed, 2 refused
// (also an existing, non-empty target), 64 wrong usage. Signing options: docs/DEPLOY.md "Engine app build".
import { acquireHeavyLock, defaultHeavyLockDir, runSandboxed } from '../../apps/server/src/full-test';
import { realDeps } from '../cloud/deps';
import { runEngineAppCli } from './commands';
import { buildEnginePackage } from './package';
import { buildEngineApp } from './build';

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
  buildApp: async (request) => {
    const lock = await acquireHeavyLock({
      dir: defaultHeavyLockDir(),
      label: 'engine app build',
      signal: abort.signal,
    });
    try {
      return await buildEngineApp({ run: deps.run, platform: process.platform }, request, abort.signal);
    } finally {
      await lock.release();
    }
  },
  out: (text) => console.log(text),
  err: (text) => console.error(text),
}).then((code) => process.exit(code));
