import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { EMAIL_LOGIN_ENV_NAMES } from '../src/services/email-login';

const startup = vi.hoisted(() => ({
  childEnvironments: [] as NodeJS.ProcessEnv[],
  ready: vi.fn(),
  listen: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: vi.fn(
    (
      _file: string,
      _args: string[],
      options: { env?: NodeJS.ProcessEnv },
      callback: (error: null, stdout: string, stderr: string) => void,
    ) => {
      // execFile inherits process.env when the caller supplies no explicit environment.
      startup.childEnvironments.push({ ...(options.env ?? process.env) });
      callback(null, 'a'.repeat(40), '');
    },
  ),
}));

vi.mock('../src/app', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/app')>()),
  buildApp: vi.fn(async () => ({
    listen: startup.listen,
    log: { info: startup.ready, warn: vi.fn(), error: vi.fn() },
    projectman: { pauseForShutdown: vi.fn() },
    close: vi.fn(),
  })),
}));

vi.mock('../src/logging', () => ({
  createServerLogStream: vi.fn(),
  serverLogFile: vi.fn(),
}));

let home: string;
let signalListeners: Map<'SIGINT' | 'SIGTERM', ReturnType<typeof process.listeners>>;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  startup.childEnvironments.length = 0;
  home = mkdtempSync(join(tmpdir(), 'projectman-email-login-startup-'));
  signalListeners = new Map(
    (['SIGINT', 'SIGTERM'] as const).map((signal) => [signal, process.listeners(signal)]),
  );
  vi.stubEnv('PROJECTMAN_HOME', home);
  vi.stubEnv('PROJECTMAN_VERSION', undefined);
  vi.stubEnv('PROJECTMAN_MODE', 'single');
  vi.stubEnv('PROJECTMAN_TERMINAL', 'pty');
  vi.stubEnv('PROJECTMAN_EMAIL_LOGIN_ENABLED', '1');
  vi.stubEnv('PROJECTMAN_SES_REGION', 'eu-central-1');
  vi.stubEnv('PROJECTMAN_SES_FROM', 'sender@example.test');
  vi.stubEnv('PROJECTMAN_SES_ACCESS_KEY_ID', 'fictional-ses-access-key');
  vi.stubEnv('PROJECTMAN_SES_SECRET_ACCESS_KEY', 'fictional-ses-secret-key');
  vi.stubEnv('PROJECTMAN_SES_SESSION_TOKEN', 'fictional-ses-session-token');
});

afterEach(() => {
  for (const [signal, previous] of signalListeners) {
    for (const listener of process.listeners(signal)) {
      if (!previous.includes(listener)) process.removeListener(signal, listener);
    }
  }
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

async function start(): Promise<void> {
  await import('../src/index');
  await vi.waitFor(() =>
    expect(startup.ready).toHaveBeenCalledWith(expect.any(Object), 'projectman server ready'),
  );
}

function expectNoEmailLoginEnvironment(): void {
  expect(startup.childEnvironments).not.toHaveLength(0);
  for (const env of [...startup.childEnvironments, vi.mocked(buildApp).mock.calls[0]![0]!.agentEnv!]) {
    for (const name of EMAIL_LOGIN_ENV_NAMES) expect(env).not.toHaveProperty(name);
    expect(env.PROJECTMAN_HOME).toBe(home);
  }
}

describe('e-mail login startup environment', () => {
  it.each(['single', 'cloud'])('keeps SES credentials out of the version lookup in %s mode', async (mode) => {
    vi.stubEnv('PROJECTMAN_MODE', mode);
    await start();
    expectNoEmailLoginEnvironment();
    expect(vi.mocked(buildApp).mock.calls[0]![0]!.emailCodeMailer?.send).toBeTypeOf('function');
  });

  it('scrubs leftover SES credentials before the version lookup when the mailer is disabled', async () => {
    vi.stubEnv('PROJECTMAN_EMAIL_LOGIN_ENABLED', '0');
    await start();
    expectNoEmailLoginEnvironment();
    expect(vi.mocked(buildApp).mock.calls[0]![0]!.emailCodeMailer).toBeUndefined();
  });
});
