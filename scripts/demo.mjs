#!/usr/bin/env node
/**
 * Isolated Acme webshop demo: fake Claude and Codex CLIs echo messages, without AI usage.
 * A message containing "PERMISSION" triggers an approval request.
 * All runtime data and credentials stay in .demo; --reset wipes that directory.
 * The instance itself (server, Vite, seed, fake CLIs) is scripts/lib/instance.mjs.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startInstance } from './lib/instance.mjs';
import { requireFreePort } from './lib/ports.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const demo = join(repo, '.demo');
const OWNER = { email: 'owner@demo.test', name: 'Te' };
const WELCOME_TASK = 'Build the product catalogue';

function credentials() {
  const path = join(demo, 'credentials.txt');
  if (!existsSync(path)) {
    writeFileSync(path, `Email: ${OWNER.email}\nPassword: ${randomBytes(18).toString('base64url')}\n`, {
      mode: 0o600,
    });
    console.log(`\nDemo login (saved in .demo/credentials.txt):\n${readFileSync(path, 'utf8')}`);
  }
  const password = /^Password: (.+)$/m.exec(readFileSync(path, 'utf8'))?.[1];
  if (!password) throw new Error('Invalid .demo/credentials.txt; restart with --reset.');
  return password;
}

/** The live fake session of the first card. Also resumes it if an interrupted first run left it unfinished. */
async function welcome(instance) {
  const tasks = await instance.api('/api/projects/AC/tasks');
  const first = tasks.find((task) => task.title === WELCOME_TASK);
  const detail = await instance.api(`/api/projects/AC/tasks/${first.key}`);
  const existing = detail.sessions[0];
  if (existing) {
    const { chat } = await instance.api(`/api/projects/AC/sessions/${existing.id}`);
    if (chat.some((entry) => entry.kind === 'assistant_text')) return false;
  }
  const sessionId =
    existing?.id ??
    (await instance.startSession(
      'AC',
      first.key,
      (await instance.api('/api/projects/AC/members')).find(
        (member) => member.kind === 'ai' && member.role === 'developer',
      ).handle,
    ));
  if (!existing) await instance.waitIdle('AC', sessionId);
  await instance.say('AC', sessionId, 'Hello Kata, welcome to the Acme webshop demo.');
  await instance.waitIdle('AC', sessionId);
  return true;
}

async function main() {
  if (process.argv.slice(2).some((arg) => arg !== '--reset'))
    throw new Error('Usage: npm run demo -- [--reset]');
  for (const port of [4700, 5173])
    await requireFreePort(port, `Port ${port} is busy; stop its server before running the demo.`);
  if (process.argv.includes('--reset')) rmSync(demo, { recursive: true, force: true });
  mkdirSync(demo, { recursive: true });
  // The instance ends the demo on Ctrl+C; these keep the process alive until it has stopped.
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {});
  instance = await startInstance({
    dir: demo,
    ports: { server: 4700, web: 5173 },
    owner: { ...OWNER, password: credentials() },
    terminal: 'pty',
    logs: 'inherit',
  });
  if (await welcome(instance)) console.log('Demo seeded: Acme webshop, four tasks, one live fake session.');
  else console.log('Reusing .demo; seeding skipped.');
  console.log(
    `\nOpen ${instance.webUrl}\nLogin: ${OWNER.email} (password in .demo/credentials.txt)\nCtrl+C stops both servers.`,
  );
  const failure = await instance.closed;
  if (failure) throw failure;
}

let instance;
try {
  await main();
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await instance?.stop();
}
