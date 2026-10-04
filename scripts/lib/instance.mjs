/**
 * A throwaway projectman development instance for team members and scripts (PM-269): a server and,
 * by default, Vite on free ports, with their data and logs in one directory, the fake claude, codex
 * and gh CLIs, and no pseudo-terminal (PROJECTMAN_TERMINAL=pipe). `scripts/demo.mjs` builds on it.
 *
 *   const instance = await startInstance();
 *   await instance.invite({ project: 'AC', email: 'c@x.test', name: 'Client', access: 'client' });
 *   await instance.stop();
 *
 * The children are not detached, and each runs under `child-guard.mjs`: they stop when the parent
 * exits, even after a SIGKILL. Passwords stay inside this module: an `Account` holds only the email
 * and the name, and nothing writes a password out.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { fakeCliEnv } from './fake-cli.mjs';
import { freePort, requireFreePort } from './ports.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const guard = fileURLToPath(new URL('./child-guard.mjs', import.meta.url));
const LIVE_PORT = 4800;
const START_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 12_000;
const PORT_RETRIES = 3;
const LOG_TAIL_LINES = 40;
const FAKE_ENV_NAME = /^FAKE_(CLAUDE|CODEX|GH)_[A-Z0-9_]+$/;
const SEED_MARKER = 'Acme webshop demo seeded with both providers.\n';

/** A request the instance's API answered with a status other than 2xx. */
export class InstanceApiError extends Error {
  constructor(method, path, status, body) {
    super(`${method} ${path}: ${status} ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.name = 'InstanceApiError';
    this.status = status;
    this.body = body;
  }
}

/** Resolves the symbolic links of the longest part of the path that exists. */
function realish(path) {
  const rest = [];
  let current = resolve(path);
  while (!existsSync(current)) {
    rest.unshift(basename(current));
    current = dirname(current);
  }
  return join(realpathSync(current), ...rest);
}

function isInside(parent, path) {
  return path === parent || path.startsWith(parent + sep);
}

function checkOptions({ dir, seed, fakeEnv, ports }) {
  if (seed !== 'demo' && seed !== 'none') throw new Error(`Unknown seed: ${seed} (demo or none).`);
  for (const [name, value] of Object.entries(fakeEnv)) {
    if (!FAKE_ENV_NAME.test(name))
      throw new Error(`fakeEnv accepts only FAKE_CLAUDE_*, FAKE_CODEX_* and FAKE_GH_* names, not ${name}.`);
    if (typeof value !== 'string') throw new Error(`fakeEnv ${name} must be a string.`);
  }
  for (const [name, port] of Object.entries(ports)) {
    if (port === undefined) continue;
    if (!Number.isInteger(port) || port < 1 || port > 65_535)
      throw new Error(`Invalid ${name} port: ${port}.`);
    if (port === LIVE_PORT)
      throw new Error(`Port ${LIVE_PORT} is the live instance's: a development instance never uses it.`);
  }
  if (dir !== undefined && isLiveData(realish(dir)))
    throw new Error('A development instance never keeps its data below ~/.projectman (the live instance).');
}

/**
 * Below the live home (~/.projectman), except where the members' checkouts and caches are: a
 * member's worktree, where `npm run demo` keeps `.demo`, is `~/.projectman/worktrees/<project>/<task>`.
 */
function isLiveData(path) {
  const live = realish(join(homedir(), '.projectman'));
  if (!isInside(live, path)) return false;
  return !['worktrees', 'member-caches'].some(
    (sub) => isInside(join(live, sub), path) && path !== join(live, sub),
  );
}

function logTail(file) {
  try {
    return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-LOG_TAIL_LINES).join('\n');
  } catch {
    return '(no log)';
  }
}

/**
 * Starts the instance and resolves when it is ready. Options (see the task PM-269):
 *   dir        data directory (default: a new temporary one, which `stop()` removes; a given one is kept)
 *   seed       'demo' (the Acme project, four cards, no session) or 'none'
 *   web        start Vite too (default true)
 *   fakeEnv    FAKE_CLAUDE_*, FAKE_CODEX_*, FAKE_GH_* variables for the fake CLIs
 *   ports      { server, web }; by default free ports, chosen again up to 3 times on a collision
 * and, for scripts/demo.mjs:
 *   owner      { email, name, password }; a given password is used to log in again to a kept `dir`
 *   terminal   'pipe' (default) or 'pty' (no PROJECTMAN_TERMINAL: the sessions use a terminal)
 *   logs       'files' (default: <dir>/logs) or 'inherit' (the child's output goes to this process's)
 */
export async function startInstance(options = {}) {
  const {
    seed = 'demo',
    web = true,
    fakeEnv = {},
    ports = {},
    owner: ownerOptions = {},
    terminal = 'pipe',
    logs = 'files',
  } = options;
  checkOptions({ dir: options.dir, seed, fakeEnv, ports });
  if (terminal !== 'pipe' && terminal !== 'pty') throw new Error(`Unknown terminal: ${terminal}.`);
  const ownsDir = options.dir === undefined;
  // The real path: the fake claude trusts a folder by its real path, and a temporary directory is
  // below a symbolic link on macOS (/var -> /private/var).
  const dir = ownsDir
    ? realpathSync(mkdtempSync(join(tmpdir(), 'projectman-instance-')))
    : realish(options.dir);
  mkdirSync(join(dir, 'logs'), { recursive: true });
  const workspace = join(dir, 'workspace');
  const callsFile = join(dir, 'fake-claude-calls.json');

  const passwords = new Map(); // email -> password; never leaves this closure
  const cookies = new Map(); // email -> session cookie
  const children = [];
  let serverUrl = '';
  let webUrl = null;
  let stopping;
  let failure = null;
  let resolveClosed;
  const closed = new Promise((res) => (resolveClosed = res));

  const owner = Object.freeze({
    email: (ownerOptions.email ?? 'owner@instance.test').toLowerCase(),
    name: ownerOptions.name ?? 'Owner',
  });
  if (ownerOptions.password) passwords.set(owner.email, ownerOptions.password);

  function childEnv(serverPort) {
    const env = fakeCliEnv(dir, { trusted: [dir, workspace] });
    for (const key of Object.keys(env)) {
      if (key.startsWith('PROJECTMAN_')) delete env[key];
    }
    return {
      ...env,
      ...fakeEnv,
      PROJECTMAN_HOME: join(dir, 'home'),
      PORT: String(serverPort),
      HOST: '127.0.0.1',
      PROJECTMAN_SERVER_URL: `http://127.0.0.1:${serverPort}`,
      ...(terminal === 'pipe' ? { PROJECTMAN_TERMINAL: 'pipe' } : {}),
      LOG_LEVEL: 'warn',
      FAKE_CLAUDE_MCP_CALLS_FILE: callsFile,
      PROJECTMAN_VITE_CACHE_DIR: join(dir, 'vite-cache'),
    };
  }

  function spawnChild(name, args, cwd, env) {
    const logFile = join(dir, 'logs', `${name}.log`);
    const fd = logs === 'files' ? openSync(logFile, 'a') : undefined;
    const output = fd ?? 'inherit';
    // The pipe on stdin is the guard's lifeline: it closes when this process dies.
    const child = spawn(process.execPath, [guard, process.execPath, ...args], {
      cwd,
      env,
      stdio: ['pipe', output, output],
      detached: false,
    });
    if (fd !== undefined) closeSync(fd);
    const handle = { name, child, logFile, exitInfo: null, supervised: false };
    handle.exited = new Promise((res) => {
      child.once('error', (err) => {
        handle.exitInfo ??= `error: ${err.message}`;
        res();
      });
      child.once('exit', (code, signal) => {
        handle.exitInfo ??= `${signal ?? `code ${code}`}`;
        res();
      });
    }).then(() => {
      if (handle.supervised && !stopping) {
        failure = new Error(
          `${name} stopped unexpectedly (${handle.exitInfo})\n${logs === 'files' ? logTail(logFile) : ''}`.trimEnd(),
        );
        void stop();
      }
    });
    child.stdin.on('error', () => {});
    children.push(handle);
    return handle;
  }

  async function waitReady(handle, url) {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (stopping) throw new Error('The instance was stopped while starting.');
      if (handle.exitInfo) break;
      const ok = await fetch(url, { signal: AbortSignal.timeout(1_000) })
        .then((res) => res.ok)
        .catch(() => false);
      if (ok) {
        handle.supervised = true;
        return;
      }
      await delay(100);
    }
    const tail = logs === 'files' ? logTail(handle.logFile) : '';
    const error = new Error(
      `${handle.name} ${handle.exitInfo ? `exited (${handle.exitInfo}) while starting` : 'did not become ready'}.\n` +
        `${tail}${logs === 'files' ? `\n(log: ${handle.logFile})` : ''}`,
    );
    error.portInUse = /EADDRINUSE|already in use/i.test(tail);
    throw error;
  }

  async function terminate(handle) {
    if (handle.exitInfo) return;
    handle.child.kill('SIGTERM');
    const timer = setTimeout(() => handle.child.kill('SIGKILL'), STOP_TIMEOUT_MS);
    try {
      await handle.exited;
    } finally {
      clearTimeout(timer);
    }
  }

  async function startWithPortRetries(explicit, pickPort, attempt) {
    for (let tries = 0; ; tries++) {
      const port = explicit ?? (await pickPort());
      try {
        return await attempt(port);
      } catch (err) {
        if (explicit !== undefined || !err.portInUse || tries >= PORT_RETRIES || stopping) throw err;
      }
    }
  }

  /** One request; `cookie` is sent when given. Returns the status, the parsed body and the cookie set. */
  async function send(path, { method = 'GET', body, cookie, timeoutMs = 15_000 } = {}) {
    const url = `${serverUrl}${path.startsWith('/api/') ? path : `/api${path}`}`;
    const response = await fetch(url, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(cookie ? { cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!response.ok) throw new InstanceApiError(method, path, response.status, parsed);
    return {
      status: response.status,
      body: parsed,
      cookie: response.headers.get('set-cookie')?.split(';')[0],
    };
  }

  async function login(account) {
    const password = passwords.get(account.email);
    if (!password) throw new Error(`No password is known for ${account.email}.`);
    const result = await send('/api/auth/login', {
      method: 'POST',
      body: { email: account.email, password },
    });
    cookies.set(account.email, result.cookie);
    return result.cookie;
  }

  async function api(path, init = {}) {
    const account = init.as ?? owner;
    const cookie = cookies.get(account.email) ?? (await login(account));
    const result = await send(path, { method: init.method, body: init.body, cookie });
    return result.body;
  }

  async function ownerSetup() {
    const { needsSetup } = (await send('/api/setup')).body;
    if (needsSetup) {
      const password = passwords.get(owner.email) ?? randomBytes(18).toString('base64url');
      passwords.set(owner.email, password);
      const result = await send('/api/setup', {
        method: 'POST',
        body: { name: owner.name, email: owner.email, password },
      });
      cookies.set(owner.email, result.cookie);
    } else await login(owner);
  }

  function git(args) {
    const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || 'Git command failed while seeding.');
  }

  /** The Acme webshop: project AC, two renamed AI developers, four cards. No session is started. */
  async function seedDemo() {
    const marker = join(dir, 'seeded');
    if (existsSync(marker) && readFileSync(marker, 'utf8') === SEED_MARKER) return;
    mkdirSync(workspace, { recursive: true });
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
    if (!(await api('/api/projects')).some((project) => project.key === 'AC')) {
      await api('/api/projects', {
        method: 'POST',
        body: {
          key: 'AC',
          name: 'Acme webshop',
          templateId: 'web-client-project',
          workspacePath: workspace,
          repos: [{ name: 'webshop', path: '.' }],
        },
      });
    }
    const developers = (await api('/api/projects/AC/members')).filter(
      (member) => member.kind === 'ai' && member.role === 'developer',
    );
    await api(`/api/projects/AC/members/${developers[0].handle}`, {
      method: 'PATCH',
      body: { displayName: 'Kata' },
    });
    await api(`/api/projects/AC/members/${developers[1].handle}`, {
      method: 'PATCH',
      body: { displayName: 'Bence', provider: 'codex' },
    });
    const titles = [
      'Build the product catalogue',
      'Add a shopping basket',
      'Design the checkout page',
      'Show order confirmation',
    ];
    const tasks = await api('/api/projects/AC/tasks');
    for (const title of titles) {
      if (!tasks.some((task) => task.title === title)) {
        await api('/api/projects/AC/tasks', {
          method: 'POST',
          body: { title, repo: 'webshop', description: 'Fictional Acme webshop demo task.' },
        });
      }
    }
    writeFileSync(marker, SEED_MARKER);
  }

  async function stopNow() {
    for (const signal of ['SIGINT', 'SIGTERM']) process.off(signal, onSignal);
    // Vite first: it proxies to the server.
    await Promise.all([...children].reverse().map(terminate));
    if (ownsDir) rmSync(dir, { recursive: true, force: true });
    resolveClosed(failure);
  }

  function stop() {
    stopping ??= stopNow();
    return stopping;
  }

  function onSignal(signal) {
    void stop().then(() => {
      // Nobody else handles the signal: end the process as it would have ended without this handler.
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    });
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, onSignal);

  const instance = {
    dir,
    get serverUrl() {
      return serverUrl;
    },
    get webUrl() {
      return webUrl;
    },
    owner,
    /** Resolves when the instance has stopped: with an Error when a child died, otherwise with null. */
    closed,
    api,

    /**
     * A Playwright `storageState` that logs the account in to the browser (PM-270): the session
     * cookie only, for 127.0.0.1 (the cookie holds no port, so the web and the server share it).
     * The password still stays in this module.
     */
    async storageState(account = owner) {
      const cookie = cookies.get(account.email) ?? (await login(account));
      const separator = cookie.indexOf('=');
      return {
        cookies: [
          {
            name: cookie.slice(0, separator),
            value: cookie.slice(separator + 1),
            domain: '127.0.0.1',
            path: '/',
            expires: -1,
            httpOnly: true,
            secure: false,
            sameSite: 'Lax',
          },
        ],
        origins: [],
      };
    },

    async invite({ project, email, name, access }) {
      if (access === 'owner') throw new Error('An invitation cannot give owner access.');
      const created = await api(`/api/projects/${project}/invites`, {
        method: 'POST',
        body: { email, displayName: name, access, roles: [] },
      });
      const token = created.path.split('/').pop();
      const account = Object.freeze({ email: email.toLowerCase(), name });
      const password = randomBytes(18).toString('base64url');
      const result = await send(`/api/invites/${token}/accept`, { method: 'POST', body: { name, password } });
      passwords.set(account.email, password);
      cookies.set(account.email, result.cookie);
      return account;
    },

    async startSession(project, taskKey, assignee) {
      const detail = await api(`/api/projects/${project}/tasks/${taskKey}/start`, {
        method: 'POST',
        body: { assignee },
      });
      const sessions = [...(detail.sessions ?? [])].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      const session = sessions.at(-1);
      if (!session) throw new Error(`Starting ${taskKey} did not create a session.`);
      return session.id;
    },

    async say(project, sessionId, text) {
      const firstLine = text.split('\n')[0];
      const userTexts = async () =>
        (await api(`/api/projects/${project}/sessions/${sessionId}`)).chat.filter(
          (item) => item.kind === 'user_text' && item.text.includes(firstLine),
        ).length;
      const before = await userTexts();
      await api(`/api/projects/${project}/sessions/${sessionId}/messages`, {
        method: 'POST',
        body: { text },
      });
      // The message counts as said once it shows in the chat: a waitIdle right after must not see
      // the idle state from before the turn.
      const deadline = Date.now() + 10_000;
      while ((await userTexts()) <= before) {
        if (Date.now() > deadline) throw new Error(`The message did not reach session ${sessionId}.`);
        await delay(100);
      }
    },

    async waitIdle(project, sessionId, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      let state = 'unknown';
      while (Date.now() < deadline) {
        const { session, chat } = await api(`/api/projects/${project}/sessions/${sessionId}`);
        state = session.state;
        if (state === 'exited' || state === 'failed') throw new Error(`Session ${sessionId} is ${state}.`);
        if (
          state === 'idle' &&
          chat.some((item) => item.kind === 'assistant_text') &&
          chat.at(-1).kind !== 'user_text'
        )
          return;
        await delay(100);
      }
      throw new Error(`Session ${sessionId} did not become idle in ${timeoutMs} ms (it is ${state}).`);
    },

    async setFakeCalls(calls) {
      if (!Array.isArray(calls) || calls.some((call) => typeof call?.tool !== 'string' || !call.arguments))
        throw new Error('setFakeCalls takes an array of { tool, arguments, delayMs? }.');
      const temporary = `${callsFile}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(calls)}\n`);
      renameSync(temporary, callsFile);
    },

    stop,
  };

  try {
    const explicitWeb = ports.web;
    // Reserve two different free ports before either server listens.
    let webPortHint;
    const pickServer = async () => {
      const port = await freePort();
      webPortHint = web && explicitWeb === undefined ? await freePort() : explicitWeb;
      return port;
    };
    if (ports.server !== undefined) await requireFreePort(ports.server, `Port ${ports.server} is busy.`);
    await startWithPortRetries(ports.server, pickServer, async (port) => {
      serverUrl = `http://127.0.0.1:${port}`;
      const handle = spawnChild(
        'server',
        ['--import', 'tsx', 'src/index.ts'],
        join(repo, 'apps/server'),
        childEnv(port),
      );
      try {
        await waitReady(handle, `${serverUrl}/api/setup`);
      } catch (err) {
        await terminate(handle);
        children.splice(children.indexOf(handle), 1);
        throw err;
      }
    });
    await ownerSetup();
    if (seed === 'demo') await seedDemo();
    if (web) {
      const viteBin = join(
        dirname(createRequire(join(repo, 'apps/web/package.json')).resolve('vite/package.json')),
        'bin/vite.js',
      );
      await startWithPortRetries(
        explicitWeb,
        async () => webPortHint ?? (await freePort()),
        async (port) => {
          webPortHint = undefined;
          if (port === LIVE_PORT) throw new Error('The web port must not be the live instance port.');
          const handle = spawnChild(
            'vite',
            [
              viteBin,
              '--configLoader',
              'runner',
              '--host',
              '127.0.0.1',
              '--port',
              String(port),
              '--strictPort',
            ],
            join(repo, 'apps/web'),
            childEnv(new URL(serverUrl).port),
          );
          try {
            await waitReady(handle, `http://127.0.0.1:${port}`);
          } catch (err) {
            await terminate(handle);
            children.splice(children.indexOf(handle), 1);
            throw err;
          }
          webUrl = `http://127.0.0.1:${port}`;
        },
      );
    }
  } catch (err) {
    await stop();
    throw err;
  }
  return instance;
}
