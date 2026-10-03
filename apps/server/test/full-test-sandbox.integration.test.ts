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
import { fullTestSandbox } from '../src/domain';
import { createFullTestExecutor, runDirOf } from '../src/full-test';
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
import { readFileSync, writeFileSync } from 'node:fs';
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

mustBeRefused('writing into the checkout', () => writeFileSync('written-by-the-run.txt', 'x'));
mustBeRefused('reading the secret below the home', () => readFileSync(secretFile, 'utf8'));
mustWork('writing into TMPDIR', () => writeFileSync(join(process.env.TMPDIR, 'ok.txt'), 'x'));
mustWork('reading the checkout', () => readFileSync('package.json', 'utf8'));
mustWork('opening a PTY', () => execFileSync('/usr/bin/script', ['-q', '/dev/null', '/usr/bin/true']));

for (const name of Object.keys(process.env)) {
  if (/^PROJECTMAN_|TOKEN|SSH_AUTH_SOCK|API_KEY/.test(name)) problems.push('environment has ' + name);
}
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

describe.runIf(process.platform === 'darwin')('the full test sandbox', () => {
  let root: string;
  let userHome: string;
  let checkout: string;
  let tmpDir: string;
  let secretFile: string;

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
    'runs the command with a PTY, a read-only checkout, a closed home, no outside network and a clean environment',
    { timeout: 180_000 },
    async () => {
      // The file exists, so a refusal below is the sandbox's and not a missing file.
      expect(readFileSync(secretFile, 'utf8')).toBe('secret');
      const result = await executor().run(
        spec('ftr_probe', `node probe.mjs '${secretFile}'`),
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
      const result = await createFullTestExecutor({
        logger,
        tmpDir: deep,
        env: { PATH: process.env.PATH },
      }).run(spec('ftr_deepdir', 'echo deep'), new AbortController().signal);
      expect(result).toMatchObject({ outcome: 'passed', exitCode: 0 });
      expect(readdirSync(deep)).toEqual([]);
      // The fallback directory (the name comes from the run id) is gone too.
      const fallback = basename(runDirOf('/private/tmp', '/private/tmp', 'ftr_deepdir'));
      expect(fallback).toBe('pmft-rdeepdir');
      expect(readdirSync('/private/tmp').filter((name) => name === fallback)).toEqual([]);
    },
  );

  it(
    'tells a failing command from one that could not run, and stops a run',
    { timeout: 180_000 },
    async () => {
      const failed = await executor().run(
        spec('ftr_failed', "echo ' FAIL  test/a.test.ts > case'; exit 3"),
        new AbortController().signal,
      );
      expect(failed).toMatchObject({ outcome: 'failed', exitCode: 3, failedFiles: ['test/a.test.ts'] });
      expect(failed.outputTail).toContain('FAIL');

      const timedOut = await executor().run(
        spec('ftr_timeout', 'sleep 60', 5000),
        new AbortController().signal,
      );
      expect(timedOut).toMatchObject({ outcome: 'error', reason: 'timeout' });

      const controller = new AbortController();
      const stopped = executor().run(spec('ftr_abort', 'sleep 60'), controller.signal);
      setTimeout(() => controller.abort(), 6000);
      expect(await stopped).toMatchObject({ outcome: 'error', reason: 'killed' });
      expect(readdirSync(tmpDir)).toEqual([]);
    },
  );
});
