import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const build = spawn(npm, ['run', 'build'], { cwd: root, stdio: 'inherit' });
assert.equal((await once(build, 'exit'))[0], 0, 'production build failed');

const home = await mkdtemp(join(tmpdir(), 'projectman-prod-'));
let server;
let exited;
let output = '';
let port = 4700;
let base;
const credentials = { name: 'Acme Owner', email: 'owner@example.com', password: 'fictional smoke password' };

async function fetchApp(path, options) {
  return fetch(`${base}${path}`, { ...options, signal: AbortSignal.timeout(2000) });
}

try {
  // Use an isolated port so a running development server is never touched.
  const { createServer } = await import('node:net');
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  port = probe.address().port;
  base = `http://127.0.0.1:${port}`;
  await new Promise((resolve, reject) => probe.close((err) => (err ? reject(err) : resolve())));
  await mkdir(join(home, '.codex'));
  server = spawn(npm, ['start'], {
    cwd: root,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      HOME: home,
      PROJECTMAN_HOME: join(home, 'data'),
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CODEX_HOME: join(home, '.codex'),
      CLAUDE_BIN: join(root, 'apps/server/test/fixtures/fake-claude.mjs'),
      CODEX_BIN: join(root, 'apps/server/test/fixtures/fake-codex.mjs'),
      GH_BIN: join(root, 'apps/server/src/github/test-fixtures/fake-gh.mjs'),
      HOST: '127.0.0.1',
      PORT: String(port),
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  exited = once(server, 'exit');
  server.stdout.on('data', (chunk) => (output += chunk));
  server.stderr.on('data', (chunk) => (output += chunk));
  const deadline = Date.now() + 20_000;
  for (;;) {
    assert.equal(server.exitCode, null, `server exited during startup: ${output}`);
    try {
      const response = await fetchApp('/api/setup');
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { needsSetup: true });
      break;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const index = await fetchApp('/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  const html = await index.text();
  assert.match(html, /<div id="root">/);
  const asset = /src="([^"\s]+\.js)"/.exec(html)?.[1];
  assert.ok(asset, 'missing built JavaScript asset');
  assert.equal((await fetchApp(asset)).status, 200);
  const fallback = await fetchApp('/projects/ACME/board');
  assert.equal(fallback.status, 200);
  assert.equal(await fallback.text(), html);
  assert.equal((await fetchApp('/api/unknown')).status, 401);

  const setup = await fetchApp('/api/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify(credentials),
  });
  assert.equal(setup.status, 201);
  const cookie = setup.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, 'setup did not issue a login cookie');
  await new Promise((resolve, reject) => {
    const upgrade = request(`${base}/ws`, {
      headers: {
        cookie,
        origin: base,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'cHJvamVjdG1hbnNtb2tlIQ==',
      },
    });
    upgrade.setTimeout(3000, () => upgrade.destroy(new Error('websocket handshake timed out')));
    upgrade.once('error', reject);
    upgrade.once('response', (response) => {
      response.resume();
      reject(new Error(`websocket handshake returned ${response.statusCode}`));
    });
    upgrade.once('upgrade', (response, socket) => {
      socket.destroy();
      try {
        assert.equal(response.statusCode, 101);
        resolve();
      } catch (err) {
        reject(err);
      }
    });
    upgrade.end();
  });
  console.log(`production smoke passed: web, SPA, API and websocket on port ${port}`);
} catch (err) {
  if (output) console.error(output);
  throw err;
} finally {
  if (server && server.exitCode === null) {
    const kill = (signal) => {
      if (process.platform === 'win32') server.kill(signal);
      else process.kill(-server.pid, signal);
    };
    kill('SIGTERM');
    const timer = setTimeout(() => kill('SIGKILL'), 5000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }
  await rm(home, { recursive: true, force: true });
}
