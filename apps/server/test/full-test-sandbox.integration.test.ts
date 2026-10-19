import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import os from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fullTestSandbox } from '../src/runtime/sessions';
import { createFullTestExecutor, fullTestEnv, runDirOf, runPaths, runSandboxed } from '../src/full-test';
import { installerSettings } from '../src/full-test/sandbox';
import { silentLogger } from '../src/runner/test-helpers';

/**
 * The server's full test in the real sandbox (PM-217; Anthropic Sandbox Runtime, macOS Seatbelt): it
 * opens a PTY, writes only its own directory, reads only the checkout below the user's home, reaches
 * no outside network but local ports, and gets nothing of the server's environment. It needs a real
 * sandbox and a PTY, so it runs only on macOS, outside a member's sandbox (the integrating session's
 * full run); it uses a temporary "home", never the real one.
 */

// The script the command runs inside the sandbox: it exits 1 and says what was wrong.
const PROBE = `
import { execFileSync } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const problems = [];
const mustFail = (what, fn) => { try { fn(); problems.push(what + ' worked'); } catch {} };
const mustWork = (what, fn) => { try { fn(); } catch (err) { problems.push(what + ' failed: ' + err.message); } };
// The sandbox refuses with EPERM or EACCES: any other error (a missing file, a bad path) proves nothing.
const mustBeRefused = (what, fn) => {
  try { fn(); problems.push(what + ' worked'); }
  catch (err) { if (err.code !== 'EPERM' && err.code !== 'EACCES') problems.push(what + ' failed with ' + err.code + ', not a refusal'); }
};

// The environment allow list leaves the server's variables out, so the secret's path comes as an argument.
const secretFile = process.argv[2];
if (!secretFile) problems.push('the secret path was not given');
const expectedTmp = process.argv[3];
if (!expectedTmp) problems.push('the expected TMPDIR was not given');

mustBeRefused('writing into the checkout', () => writeFileSync('written-by-the-run.txt', 'x'));
mustBeRefused('reading the secret below the home', () => readFileSync(secretFile, 'utf8'));
// srt's default temporary directory is shared with the members' sandboxes: the run may not write there
// (creating it is a write too, when it does not exist).
for (const dir of ['/tmp/claude', '/private/tmp/claude']) {
  mustBeRefused('writing into ' + dir, () => mkdirSync(dir + '/pm-full-test', { recursive: true }));
}
mustWork('writing into TMPDIR', () => writeFileSync(join(process.env.TMPDIR, 'ok.txt'), 'x'));
mustWork('reading the checkout', () => readFileSync('package.json', 'utf8'));
// Node's default 'pipe' input is a socket pair on macOS, which \`script\` cannot use: the input is ignored.
mustWork('opening a PTY', () =>
  execFileSync('/usr/bin/script', ['-q', '/dev/null', '/usr/bin/true'], { stdio: ['ignore', 'pipe', 'pipe'] }),
);
// srt sets TMPDIR itself: it must be the run's own temporary directory.
if (process.env.TMPDIR !== expectedTmp) problems.push('TMPDIR is ' + process.env.TMPDIR + ', not ' + expectedTmp);

for (const name of Object.keys(process.env)) {
  // PROJECTMAN_HEAVY_LOCK_HELD is the run's own: the scripts inside do not queue again (PM-336).
  if (!['PROJECTMAN_HEAVY_LOCK_HELD', 'PROJECTMAN_FULL_TEST_SANDBOX'].includes(name) && /^PROJECTMAN_|TOKEN|SSH_AUTH_SOCK|API_KEY/.test(name))
    problems.push('environment has ' + name);
}
if (process.env.PROJECTMAN_HEAVY_LOCK_HELD !== '1') problems.push('PROJECTMAN_HEAVY_LOCK_HELD is not 1');
if (process.env.VITEST_MAX_FORKS !== '2') problems.push('VITEST_MAX_FORKS is ' + process.env.VITEST_MAX_FORKS);

try {
  await fetch('https://registry.npmjs.org/', { signal: AbortSignal.timeout(8000) });
  problems.push('the outside network is reachable');
} catch {}

await new Promise((resolve) => {
  const server = createServer((socket) => socket.end('hi'));
  server.on('error', (err) => { problems.push('listening failed: ' + err.message); resolve(); });
  server.listen(0, '127.0.0.1', () => {
    const socket = connect(server.address().port, '127.0.0.1');
    socket.on('data', () => {});
    socket.on('close', () => { server.close(); resolve(); });
    socket.on('error', (err) => { problems.push('connecting to a local port failed: ' + err.message); server.close(); resolve(); });
  });
});

if (problems.length) { console.log('PROBLEMS: ' + problems.join('; ')); process.exit(1); }
`;

const logger = silentLogger();

// A fake lifecycle script: exercises the installer policy without invoking npm or downloading packages.
const INSTALLER_PROBE = `
import { mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
const [secret, hostConfig, marker, sandboxHome, userConfig, globalConfig] = process.argv.slice(2);
const problems = [];
const refused = (name, fn) => {
  try { fn(); problems.push(name + ' worked'); }
  catch (err) { if (!['EPERM', 'EACCES'].includes(err.code)) problems.push(name + ': ' + err.code); }
};
for (const file of ['package.json', 'package-lock.json', 'source.ts', '.git/config', marker, userConfig, globalConfig])
  refused('writing ' + file, () => writeFileSync(file, 'changed'));
for (const file of [secret, hostConfig, marker]) refused('reading ' + file, () => readFileSync(file));
for (const file of [userConfig, globalConfig]) if (readFileSync(file, 'utf8') !== '') problems.push('nonempty npm config');
for (const dir of ['node_modules', 'apps/server/node_modules', sandboxHome]) {
  mkdirSync(dir, { recursive: true }); writeFileSync(dir + '/installed', 'ok');
}
symlinkSync('../source.ts', 'node_modules/source-link');
refused('writing source via package link', () => writeFileSync('node_modules/source-link', 'changed'));
for (const dir of ['/tmp/claude', '/private/tmp/claude']) refused('shared tmp', () => mkdirSync(dir + '/installer', { recursive: true }));
await new Promise(resolve => {
  const server = createServer();
  server.on('error', err => { if (!['EPERM', 'EACCES'].includes(err.code)) problems.push('binding: ' + err.code); resolve(); });
  server.listen(0, '127.0.0.1', () => { problems.push('local binding worked'); server.close(resolve); });
});
try {
  const response = await fetch('https://example.com', { signal: AbortSignal.timeout(5000) });
  if (response.status !== 403) problems.push('unexpected outbound response: ' + response.status);
} catch {}
if (problems.length) { console.log(problems.join('; ')); process.exit(1); }
`;

// Seatbelt cannot start a nested srt sandbox (sandbox_apply: Operation not permitted).
describe.skipIf(process.platform !== 'darwin' || process.env.PROJECTMAN_FULL_TEST_SANDBOX === '1')(
  'the full test sandbox',
  () => {
    let root: string;
    let userHome: string;
    let checkout: string;
    let tmpDir: string;
    let secretFile: string;

    // The run directory is named after the end of the run id and is never reused (a leftover of a run that
    // was killed before it cleaned up makes the next run with the same id `sandbox_unavailable`, PM-419):
    // every run of the test gets an id of its own, so a leftover of an earlier test run cannot collide.
    const runIdOf = (name: string) => `ftr_${name}_${randomBytes(3).toString('hex')}`;
    const spec = (runId: string, command: string, timeoutMs = 120_000) => ({
      runId,
      cwd: checkout,
      command,
      maxWorkers: 2,
      timeoutMs,
      sandbox: fullTestSandbox({ checkout, userHome }),
    });
    const executor = () =>
      createFullTestExecutor({
        logger,
        tmpDir,
        // The server's environment, with everything the run must not get.
        env: {
          PATH: process.env.PATH,
          PROJECTMAN_SKIP_PTY_TESTS: '1',
          PROJECTMAN_HOME: '/nonexistent',
          GH_TOKEN: 'token',
          NPM_TOKEN: 'token',
          SSH_AUTH_SOCK: '/nonexistent',
          ANTHROPIC_API_KEY: 'key',
        },
      });

    beforeAll(() => {
      root = realpathSync(mkdtempSync(join(os.tmpdir(), 'pm-full-test-')));
      userHome = join(root, 'home');
      checkout = join(userHome, 'checkout');
      tmpDir = join(root, 'runs');
      mkdirSync(checkout, { recursive: true });
      mkdirSync(tmpDir);
      secretFile = join(userHome, 'secret.txt');
      writeFileSync(secretFile, 'secret');
      writeFileSync(join(checkout, 'package.json'), '{}');
      writeFileSync(join(checkout, 'probe.mjs'), PROBE);
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it('reports the sandbox as available', async () => {
      expect(await executor().available()).toEqual({ ok: true });
    });

    it(
      'confines a fake installer to package trees and its private sandbox paths',
      { timeout: 120_000 },
      async () => {
        const id = runIdOf('installer');
        const paths = runPaths(runDirOf(tmpDir, '/private/tmp', id));
        const installCheckout = join(userHome, 'installer-check');
        const hostConfig = join(userHome, '.npmrc');
        const store = join(userHome, 'dependency-store');
        const marker = join(store, 'ready.json');
        mkdirSync(join(installCheckout, 'apps/server'), { recursive: true });
        mkdirSync(join(installCheckout, '.git'));
        mkdirSync(store);
        writeFileSync(marker, '{}');
        writeFileSync(hostConfig, 'fixture-only');
        for (const file of ['package.json', 'package-lock.json', 'source.ts', '.git/config'])
          writeFileSync(join(installCheckout, file), '{}');
        writeFileSync(join(installCheckout, 'installer-probe.mjs'), INSTALLER_PROBE);
        const installSpec = {
          ...spec(id, ''),
          cwd: installCheckout,
          sandbox: fullTestSandbox({ checkout: installCheckout, userHome }),
        };
        mkdirSync(paths.runDir, { mode: 0o700 });
        for (const dir of [paths.home, paths.tmp, paths.npmCache]) mkdirSync(dir, { recursive: true });
        for (const file of [paths.npmUserConfig, paths.npmGlobalConfig])
          writeFileSync(file, '', { mode: 0o600 });
        writeFileSync(
          paths.installerSettings,
          JSON.stringify(
            installerSettings(
              installSpec,
              paths,
              ['node_modules', 'apps/server/node_modules'].map((dir) => join(installCheckout, dir)),
            ),
          ),
        );
        try {
          const args = [
            secretFile,
            hostConfig,
            marker,
            paths.home,
            paths.npmUserConfig,
            paths.npmGlobalConfig,
          ]
            .map((value) => `'${value}'`)
            .join(' ');
          const result = await runSandboxed({
            cwd: installCheckout,
            command: `node installer-probe.mjs ${args}`,
            settings: paths.installerSettings,
            env: fullTestEnv(paths, 2),
            timeoutMs: 60_000,
            signal: new AbortController().signal,
          });
          expect(result.exitCode, result.output).toBe(0);
          expect(result).toMatchObject({ exitCode: 0, aborted: false, timedOut: false });
          expect(readFileSync(join(installCheckout, 'source.ts'), 'utf8')).toBe('{}');
          expect(readFileSync(marker, 'utf8')).toBe('{}');
        } finally {
          rmSync(paths.runDir, { recursive: true, force: true });
        }
      },
    );

    it(
      'runs the command with a PTY, a read-only checkout, a closed home, no outside network and a clean environment',
      { timeout: 180_000 },
      async () => {
        // The file exists, so a refusal below is the sandbox's and not a missing file.
        expect(readFileSync(secretFile, 'utf8')).toBe('secret');
        // The run's own temporary directory, which the probe finds as its TMPDIR.
        const probeId = runIdOf('probe');
        const expectedTmp = runPaths(runDirOf(tmpDir, '/private/tmp', probeId)).tmp;
        const result = await executor().run(
          spec(probeId, `node probe.mjs '${secretFile}' '${expectedTmp}'`),
          new AbortController().signal,
        );
        expect(result.outputTail).toBe('');
        expect(result).toMatchObject({ outcome: 'passed', exitCode: 0 });
        expect(existsSync(join(checkout, 'written-by-the-run.txt'))).toBe(false);
        // The run's own directory is gone.
        expect(readdirSync(tmpDir)).toEqual([]);
      },
    );

    it(
      'runs when the temporary directory is too deep for the socket of the sandbox, and leaves nothing behind',
      { timeout: 180_000 },
      async () => {
        const deep = join(root, 'a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40));
        mkdirSync(deep, { recursive: true });
        const deepId = runIdOf('deepdir');
        const result = await createFullTestExecutor({
          logger,
          tmpDir: deep,
          env: { PATH: process.env.PATH },
        }).run(spec(deepId, 'echo deep'), new AbortController().signal);
        expect(result).toMatchObject({ outcome: 'passed', exitCode: 0 });
        expect(readdirSync(deep)).toEqual([]);
        // The fallback directory (the name comes from the run id) is gone too.
        const fallback = basename(runDirOf('/private/tmp', '/private/tmp', deepId));
        expect(fallback).toMatch(/^pmft-[A-Za-z0-9]{8}$/);
        expect(readdirSync('/private/tmp').filter((name) => name === fallback)).toEqual([]);
      },
    );

    it(
      'kills a fake merge-test and its TERM-resistant worker on timeout and cancellation',
      { timeout: 120_000 },
      async () => {
        // Exercise the real srt launch chain, not just a shell in the outer process group.
        writeFileSync(
          join(checkout, 'merge-worker.mjs'),
          `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
process.on('SIGTERM', () => {});
console.log('worker=' + process.pid);
writeFileSync(join(process.env.TMPDIR, 'worker-ready'), String(process.pid));
setInterval(() => {}, 1000);
`,
        );
        writeFileSync(
          join(checkout, 'fake-merge-test.mjs'),
          `
import { spawn } from 'node:child_process';
console.log('parent=' + process.pid);
spawn(process.execPath, ['merge-worker.mjs'], { stdio: ['ignore', 'inherit', 'inherit'] });
setInterval(() => {}, 1000);
`,
        );
        for (const mode of ['timeout', 'abort']) {
          const controller = new AbortController();
          const runId = runIdOf(mode);
          const pending = executor().run(
            spec(runId, 'node fake-merge-test.mjs', mode === 'timeout' ? 5000 : 60_000),
            controller.signal,
          );
          let pids: number[] = [];
          try {
            if (mode === 'abort') {
              const ready = join(runPaths(runDirOf(tmpDir, '/private/tmp', runId)).tmp, 'worker-ready');
              await expect.poll(() => existsSync(ready), { timeout: 30_000 }).toBe(true);
              controller.abort();
            }
            const result = await pending;
            pids = [...result.outputTail.matchAll(/(?:parent|worker)=(\d+)/g)].map((m) => Number(m[1]));
            expect(result).toMatchObject({
              outcome: 'error',
              reason: mode === 'timeout' ? 'timeout' : 'killed',
            });
            expect(pids).toHaveLength(2);
            for (const pid of pids) {
              await expect
                .poll(() => {
                  try {
                    process.kill(pid, 0);
                    return false;
                  } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
                    throw error;
                  }
                })
                .toBe(true);
            }
          } finally {
            controller.abort();
            await pending;
            for (const pid of pids) {
              try {
                process.kill(pid, 'SIGKILL');
              } catch {
                /* Already gone. */
              }
            }
          }
        }
        expect(readdirSync(tmpDir)).toEqual([]);
      },
    );

    it(
      'tells a failing command from one that could not run, and stops a run',
      { timeout: 180_000 },
      async () => {
        const failed = await executor().run(
          spec(runIdOf('failed'), "echo ' FAIL  test/a.test.ts > case'; exit 3"),
          new AbortController().signal,
        );
        expect(failed).toMatchObject({ outcome: 'failed', exitCode: 3, failedFiles: ['test/a.test.ts'] });
        expect(failed.outputTail).toContain('FAIL');

        const timedOut = await executor().run(
          spec(runIdOf('timeout'), 'sleep 60', 5000),
          new AbortController().signal,
        );
        expect(timedOut).toMatchObject({ outcome: 'error', reason: 'timeout' });

        const controller = new AbortController();
        const stopped = executor().run(spec(runIdOf('abort'), 'sleep 60'), controller.signal);
        setTimeout(() => controller.abort(), 6000);
        expect(await stopped).toMatchObject({ outcome: 'error', reason: 'killed' });
        expect(readdirSync(tmpDir)).toEqual([]);
      },
    );
  },
);
