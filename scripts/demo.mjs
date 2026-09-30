#!/usr/bin/env node
/**
 * Isolated Acme webshop demo: fake Claude and Codex CLIs echo messages, without AI usage.
 * A message containing "PERMISSION" triggers an approval request.
 * All runtime data and credentials stay in .demo; --reset wipes that directory.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { fakeCliEnv } from './lib/fake-cli.mjs';
import { requireFreePort } from './lib/ports.mjs';
import { stopProcessGroup } from './lib/processes.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const demo = join(repo, '.demo');
const workspace = join(demo, 'workspace');
const baseUrl = 'http://127.0.0.1:4700';
const seedMarker = 'Acme webshop demo seeded with both providers.\n';
const children = [];
let stopping = false;
let closing;
let failure;
let cookie;

async function shutdown() {
  if (closing) return closing;
  stopping = true;
  closing = Promise.all(children.map(({ child, exited }) => stopProcessGroup(child, exited, 8_000)));
  return closing;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => void shutdown());
}

function start(name, args, cwd, env) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: 'inherit', detached: true });
  const exited = new Promise((resolve) => {
    child.once('error', (err) => {
      failure = err;
      void shutdown();
      resolve();
    });
    child.once('exit', (code, signal) => {
      if (!stopping) {
        failure = new Error(`${name} stopped unexpectedly (${signal ?? code})`);
        void shutdown();
      }
      resolve();
    });
  });
  children.push({ child, exited });
}

async function waitFor(check) {
  const deadline = Date.now() + 30_000;
  while (!stopping && Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw failure ?? new Error(stopping ? 'Demo stopped.' : 'Timed out waiting for the demo.');
}

async function api(path, method = 'GET', body) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return response.status === 204 ? null : response.json();
}

function git(args) {
  const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'Demo git command failed.');
}

async function seed() {
  const credentialsPath = join(demo, 'credentials.txt');
  if (!existsSync(credentialsPath)) {
    writeFileSync(
      credentialsPath,
      `Email: owner@demo.test\nPassword: ${randomBytes(18).toString('base64url')}\n`,
      {
        mode: 0o600,
      },
    );
    console.log(`\nDemo login (saved in .demo/credentials.txt):\n${readFileSync(credentialsPath, 'utf8')}`);
  }
  const password = /^Password: (.+)$/m.exec(readFileSync(credentialsPath, 'utf8'))?.[1];
  if (!password) throw new Error('Invalid .demo/credentials.txt; restart with --reset.');
  const needsSetup = (await api('/setup')).needsSetup;
  await api(needsSetup ? '/setup' : '/auth/login', 'POST', {
    name: 'Te',
    email: 'owner@demo.test',
    password,
  });
  if (!(await api('/projects')).some((project) => project.key === 'AC')) {
    await api('/projects', 'POST', {
      key: 'AC',
      name: 'Acme webshop',
      templateId: 'web-client-project',
      workspacePath: workspace,
      repos: [{ name: 'webshop', path: '.' }],
    });
  }
  const developers = (await api('/projects/AC/members')).filter(
    (member) => member.kind === 'ai' && member.role === 'developer',
  );
  await api(`/projects/AC/members/${developers[0].handle}`, 'PATCH', { displayName: 'Kata' });
  await api(`/projects/AC/members/${developers[1].handle}`, 'PATCH', {
    displayName: 'Bence',
    provider: 'codex',
  });
  const titles = [
    'Build the product catalogue',
    'Add a shopping basket',
    'Design the checkout page',
    'Show order confirmation',
  ];
  let tasks = await api('/projects/AC/tasks');
  for (const title of titles) {
    if (!tasks.some((task) => task.title === title)) {
      tasks.push(
        await api('/projects/AC/tasks', 'POST', {
          title,
          repo: 'webshop',
          description: 'Fictional Acme webshop demo task.',
        }),
      );
    }
  }
  const first = tasks.find((task) => task.title === titles[0]);
  const detail = await api(`/projects/AC/tasks/${first.key}`);
  const started = detail.sessions.length
    ? detail
    : await api(`/projects/AC/tasks/${first.key}/start`, 'POST', { assignee: developers[0].handle });
  const session = started.sessions[0];
  if (!session) throw new Error('Demo task did not create a session.');
  // Also resumes the fake session if an interrupted first run needs to finish seeding.
  await api(`/projects/AC/sessions/${session.id}/messages`, 'POST', {
    text: 'Hello Kata, welcome to the Acme webshop demo.',
  });
  await waitFor(async () => {
    const { session: current, chat } = await api(`/projects/AC/sessions/${session.id}`);
    return current.state === 'idle' && chat.some((entry) => entry.kind === 'assistant_text');
  });
  writeFileSync(join(demo, 'seeded'), seedMarker);
  console.log('Demo seeded: Acme webshop, four tasks, one live fake session.');
}

async function main() {
  if (process.argv.slice(2).some((arg) => arg !== '--reset'))
    throw new Error('Usage: npm run demo -- [--reset]');
  for (const port of [4700, 5173])
    await requireFreePort(port, `Port ${port} is busy; stop its server before running the demo.`);
  if (process.argv.includes('--reset')) rmSync(demo, { recursive: true, force: true });
  for (const dir of ['workspace', 'home']) mkdirSync(join(demo, dir), { recursive: true });
  if (!existsSync(join(workspace, '.git'))) {
    writeFileSync(
      join(workspace, 'README.md'),
      '# Acme webshop\n\nA fictional webshop for the projectman demo.\n',
    );
    git(['init', '--initial-branch=main']);
    git(['add', 'README.md']);
    git([
      '-c',
      'user.name=Demo Owner',
      '-c',
      'user.email=owner@demo.test',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-m',
      'Initialize Acme webshop demo',
    ]);
  }
  const env = {
    // The fake claude, codex and gh CLIs; the demo folder is trusted.
    ...fakeCliEnv(demo, { trusted: [demo] }),
    PROJECTMAN_HOME: join(demo, 'home'),
    PORT: '4700',
    HOST: '127.0.0.1',
    LOG_LEVEL: 'warn',
    PROJECTMAN_SERVER_URL: baseUrl,
  };
  start('Server', ['--import', 'tsx', 'src/index.ts'], join(repo, 'apps/server'), env);
  await waitFor(() =>
    fetch(`${baseUrl}/api/setup`, { signal: AbortSignal.timeout(1_000) })
      .then((res) => res.ok)
      .catch(() => false),
  );
  const seeded = join(demo, 'seeded');
  if (!existsSync(seeded) || readFileSync(seeded, 'utf8') !== seedMarker) await seed();
  else console.log('Reusing .demo; seeding skipped.');
  start(
    'Vite',
    [
      join(
        dirname(createRequire(join(repo, 'apps/web/package.json')).resolve('vite/package.json')),
        'bin/vite.js',
      ),
      '--host',
      '127.0.0.1',
      '--port',
      '5173',
      '--strictPort',
    ],
    join(repo, 'apps/web'),
    env,
  );
  await waitFor(() =>
    fetch('http://127.0.0.1:5173', { signal: AbortSignal.timeout(1_000) })
      .then((res) => res.ok)
      .catch(() => false),
  );
  console.log(
    '\nOpen http://127.0.0.1:5173\nLogin: owner@demo.test (password in .demo/credentials.txt)\nCtrl+C stops both servers.',
  );
  await Promise.all(children.map(({ exited }) => exited));
  if (failure) throw failure;
}

try {
  await main();
} catch (err) {
  if (!stopping || failure) {
    console.error(failure?.message ?? err.message);
    process.exitCode = 1;
  }
} finally {
  await shutdown();
}
