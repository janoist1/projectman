/** Types of `instance.mjs`, for the TypeScript tests and for scripts that import it. */

/** A person of the instance. The password stays inside `instance.mjs`. */
export interface Account {
  readonly email: string;
  readonly name: string;
}

export type InviteAccess = 'admin' | 'developer' | 'client' | 'viewer';

export interface InstanceOptions {
  /** Default: a new `os.tmpdir()/projectman-instance-*` that `stop()` removes. A given one is kept. */
  dir?: string;
  /** Default `demo`: the Acme webshop (project AC, four cards), no session. */
  seed?: 'demo' | 'none';
  /** Default true: Vite starts too. */
  web?: boolean;
  /**
   * The JSON text of a fixed machine (`scripts/fixtures/machine/*.json`, `PROJECTMAN_MACHINE_FIXTURE`, PM-320):
   * the machine display shows it, not the real machine. Default: the real machine.
   */
  machine?: string;
  /** Only FAKE_CLAUDE_*, FAKE_CODEX_* and FAKE_GH_* names. */
  fakeEnv?: Record<string, string>;
  /** Default: free ports, chosen again up to 3 times on a collision. */
  ports?: { server?: number; web?: number };
  /** For `scripts/demo.mjs`: the owner's login; a given password logs in again to a kept `dir`. */
  owner?: { email?: string; name?: string; password?: string };
  /** Default `pipe`; `pty` starts the agent sessions in a terminal, as `npm run dev` does. */
  terminal?: 'pipe' | 'pty';
  /** Default `files` (`<dir>/logs/server.log`, `vite.log`); `inherit` writes to this process's output. */
  logs?: 'files' | 'inherit';
  /** For `scripts/shots.mjs`. Default true: SIGINT/SIGTERM stop the instance, then end the process; false: the caller does. */
  handleSignals?: boolean;
}

export interface FakeCall {
  tool: string;
  arguments: object;
  delayMs?: number;
}

export interface Instance {
  readonly dir: string;
  readonly serverUrl: string;
  readonly webUrl: string | null;
  readonly owner: Account;
  /** Resolves when the instance has stopped: with an Error when a child died by itself, else null. */
  readonly closed: Promise<Error | null>;
  /** `path` is an API path (`/api/projects`); the answer is the parsed JSON (null for 204). */
  api(path: string, init?: { method?: string; body?: unknown; as?: Account }): Promise<any>;
  /** A Playwright `storageState` holding the account's session cookie (default: the owner's). */
  storageState(account?: Account): Promise<{
    cookies: {
      name: string;
      value: string;
      domain: string;
      path: string;
      expires: number;
      httpOnly: boolean;
      secure: boolean;
      sameSite: 'Lax';
    }[];
    origins: [];
  }>;
  invite(input: { project: string; email: string; name: string; access: InviteAccess }): Promise<Account>;
  startSession(project: string, taskKey: string, assignee: string): Promise<string>;
  say(project: string, sessionId: string, text: string): Promise<void>;
  waitIdle(project: string, sessionId: string, timeoutMs?: number): Promise<void>;
  setFakeCalls(calls: FakeCall[]): Promise<void>;
  stop(): Promise<void>;
}

/** A request the instance's API answered with a status other than 2xx. */
export class InstanceApiError extends Error {
  readonly status: number;
  readonly body: unknown;
}

export function startInstance(options?: InstanceOptions): Promise<Instance>;
