import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CliIo } from '../../../../scripts/projectman/io';

/** The canaries: secret values whose presence anywhere but the Authorization and Access headers is a leak. */
export const CANARY_KEY = 'pmi_CANARYkeyVALUE0123456789abcdef';
export const CANARY_ACCESS_ID = 'canary-access-id.access';
export const CANARY_ACCESS_SECRET = 'canary-access-secret-0123456789abcdef0123456789abcdef';

export interface ClientHome {
  home: string;
  configDir: string;
  configFile: string;
  keyFile: string;
  accessFile: string;
  cleanup(): void;
}

export interface ClientHomeOptions {
  baseUrl?: string;
  access?: boolean;
  key?: string;
}

/** A temporary home with `~/.config/projectman/{client.json,integrator-key[,integrator-access-token.json]}`. */
export function createClientHome(options: ClientHomeOptions = {}): ClientHome {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pm-client-')));
  const configDir = path.join(home, '.config', 'projectman');
  fs.mkdirSync(configDir, { recursive: true });
  fs.chmodSync(configDir, 0o700);
  const configFile = path.join(configDir, 'client.json');
  const keyFile = path.join(configDir, 'integrator-key');
  const accessFile = path.join(configDir, 'integrator-access-token.json');
  fs.writeFileSync(keyFile, `${options.key ?? CANARY_KEY}\n`, { mode: 0o600 });
  fs.chmodSync(keyFile, 0o600);
  if (options.access) {
    fs.writeFileSync(
      accessFile,
      JSON.stringify({
        'CF-Access-Client-Id': CANARY_ACCESS_ID,
        'CF-Access-Client-Secret': CANARY_ACCESS_SECRET,
      }),
      { mode: 0o600 },
    );
    fs.chmodSync(accessFile, 0o600);
  }
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      version: 1,
      baseUrl: options.baseUrl ?? 'https://pm.example.com',
      keyFile: '~/.config/projectman/integrator-key',
      ...(options.access ? { accessHeadersFile: 'integrator-access-token.json' } : {}),
    }),
    { mode: 0o600 },
  );
  fs.chmodSync(configFile, 0o600);
  return {
    home,
    configDir,
    configFile,
    keyFile,
    accessFile,
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}

export interface Recorded {
  method: string;
  url: URL;
  /** Header names in lower case. */
  headers: Record<string, string>;
  body: string | undefined;
  redirect: RequestRedirect | undefined;
  signal: AbortSignal | undefined;
}

export type Handler = (request: Recorded, index: number) => Response | Promise<Response>;

export const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export interface TestIo {
  io: CliIo;
  requests: Recorded[];
  stdout: string[];
  stderr: string[];
  controller: AbortController;
  /** Everything the client wrote, for the leak checks. */
  output(): string;
}

export interface TestIoOptions {
  stdin?: string | string[] | AsyncIterable<string | Uint8Array>;
  /** The write callback of standard output gets this error (a consumer that went away) from the nth write on. */
  failStdoutFrom?: number;
  delays?: number[];
}

/** The client's world, in memory: a fake fetch, captured streams, fixed request ids. */
export function createTestIo(home: string, handler: Handler, options: TestIoOptions = {}): TestIo {
  const requests: Recorded[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const controller = new AbortController();
  let ids = 0;
  let writes = 0;
  const chunksOf = async function* (chunks: string[]) {
    for (const chunk of chunks) yield chunk;
  };
  const source = options.stdin;
  const stdin: AsyncIterable<string | Uint8Array> =
    source === undefined
      ? chunksOf([])
      : typeof source === 'string'
        ? chunksOf([source])
        : Array.isArray(source)
          ? chunksOf(source)
          : source;
  const io: CliIo = {
    stdout: {
      write(chunk, done) {
        writes += 1;
        if (options.failStdoutFrom !== undefined && writes >= options.failStdoutFrom) {
          done(new Error('EPIPE'));
          return false;
        }
        stdout.push(chunk);
        done();
        return true;
      },
    },
    stderr: {
      write(chunk) {
        stderr.push(chunk);
        return true;
      },
    },
    stdin,
    home,
    signal: controller.signal,
    newRequestId: () => {
      ids += 1;
      return `00000000-0000-4000-8000-${String(ids).padStart(12, '0')}`;
    },
    delay: async (ms) => {
      options.delays?.push(ms);
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>))
        headers[name.toLowerCase()] = value;
      const recorded: Recorded = {
        method: init?.method ?? 'GET',
        url: new URL(input instanceof Request ? input.url : String(input)),
        headers,
        body: typeof init?.body === 'string' ? init.body : undefined,
        redirect: init?.redirect,
        signal: init?.signal ?? undefined,
      };
      requests.push(recorded);
      return handler(recorded, requests.length - 1);
    }) as typeof fetch,
  };
  return {
    io,
    requests,
    stdout,
    stderr,
    controller,
    output: () => [...stdout, ...stderr].join(''),
  };
}
