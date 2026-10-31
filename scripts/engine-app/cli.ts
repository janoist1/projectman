// Builds a self-contained engine package and its distributable macOS app (PM-1104, PM-1121, PM-1122):
//
//   npm run engine-app -- package --commit <sha> --out <dir> [--repo <https-url>]
//   npm run engine-app -- build --package <dir> --out <dir> [--ad-hoc]
//   npm run engine-app -- publish --tag <tag> --config <absolute-file>
//   npm run engine-app -- upload --tag <tag> --dir <build output>  (PM-1198: the ad-hoc build of GitHub Actions)
//   npm run engine-app -- fetch --commit <sha> --out <new dir> [--run <number>] [--dry-run] [--open]  (PM-1156)
//
// The package lands in <dir>/<sha> (printed as the last line: the input of `build --package`); see package.ts for its layout. Exit status: 0 done, 1 failed, 2 refused
// (also an existing, non-empty target), 64 wrong usage. Signing options: docs/DEPLOY.md "Engine app build".
import { acquireHeavyLock, defaultHeavyLockDir, runSandboxed } from '../../apps/server/src/full-test';
import { realDeps } from '../cloud/deps';
import { Report } from '../cloud/report';
import { runEngineAppCli } from './commands';
import { fetchEngineApp } from './fetch';
import { buildEnginePackage } from './package';
import { buildEngineApp } from './build';
import { publishEngineApp } from './publish';
import { uploadEngineApp } from './upload';

const deps = realDeps();
const abort = new AbortController();
const packageDeps = {
  run: deps.run,
  fetch: deps.fetch,
  now: deps.now,
  homeDir: deps.homeDir,
  platform: process.platform,
  arch: process.arch,
  sandbox: runSandboxed,
  heavyLock: (label: string, signal: AbortSignal) =>
    acquireHeavyLock({ dir: defaultHeavyLockDir(), label, signal }),
  out: (line: string) => process.stdout.write(`${line}\n`),
};
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => abort.abort());

runEngineAppCli(process.argv.slice(2), {
  sourceRepo: deps.repoRoot,
  cwd: process.cwd(),
  publish: (request) =>
    publishEngineApp(
      {
        run: deps.run,
        heavyLock: (signal) =>
          acquireHeavyLock({ dir: defaultHeavyLockDir(), label: 'engine app publish', signal }),
        // publish holds the queue across both builders, so the package must not acquire it again.
        build: (input, signal) =>
          buildEnginePackage(
            { ...packageDeps, heavyLock: async () => ({ release: async () => {} }) },
            input,
            { signal },
          ),
        buildApp: (input, signal) =>
          buildEngineApp({ run: deps.run, platform: process.platform }, input, signal),
      },
      request,
      abort.signal,
    ),
  upload: (request) => uploadEngineApp({ run: deps.run }, request, abort.signal),
  fetch: (request) => fetchEngineApp({ deps, report: new Report((line) => console.log(line)) }, request),
  originUrl: async () => {
    const result = await deps.run('git', ['-C', deps.repoRoot, 'remote', 'get-url', 'origin']);
    return result.code === 0 ? result.stdout.trim() || null : null;
  },
  build: (request) => buildEnginePackage(packageDeps, request, { signal: abort.signal }),
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
