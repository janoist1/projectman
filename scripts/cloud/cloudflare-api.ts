import type { CloudDeps } from './deps';
import { CloudError, refused } from './errors';
import type { Report } from './report';
import { readSecret } from './secrets';

/**
 * The Cloudflare API client of the cloud commands (PM-536): `fetch` through `deps`, one bearer token read from
 * the token file. The token is sent only in the `Authorization` header; it is never in a URL, an argument, an
 * error message or the report (it is registered with `Report.protect` as a last guard). A read-only client
 * (`--dry-run`) refuses every call that is not a GET, so a missing `if (dryRun)` in a step cannot change anything.
 */

const API = 'https://api.cloudflare.com/client/v4';
const TIMEOUT_MS = 30_000;
const RATE_LIMIT_ATTEMPTS = 3;
const PAGE_SIZE = 50;
const MAX_PAGES = 100;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface CloudflareMessage {
  code?: number;
  message?: string;
}

/** A call the API refused (or could not answer); the message has the status, the codes and Cloudflare's words. */
export class CloudflareError extends CloudError {
  readonly status: number;
  readonly codes: number[];
  readonly messages: string[];

  constructor(call: string, status: number, errors: CloudflareMessage[]) {
    const codes = errors.flatMap((error) => (typeof error.code === 'number' ? [error.code] : []));
    const messages = errors.flatMap((error) => (error.message ? [error.message] : []));
    const detail = errors.map((error) => `${error.code ?? '?'}: ${error.message ?? 'no message'}`).join('; ');
    super(`Cloudflare ${call} failed: HTTP ${status}${detail ? ` (${detail})` : ''}`, 1);
    this.name = 'CloudflareError';
    this.status = status;
    this.codes = codes;
    this.messages = messages;
  }

  /** The token lacks a right (or is not accepted): authentication and authorization failures. */
  get isPermission(): boolean {
    return this.status === 401 || this.status === 403 || this.codes.includes(10000);
  }
}

export interface PageInfo {
  page?: number;
  per_page?: number;
  total_pages?: number;
  count?: number;
  total_count?: number;
}

interface Envelope {
  success?: boolean;
  errors?: CloudflareMessage[];
  result?: Json;
  result_info?: PageInfo;
}

export type Query = Record<string, string | number | boolean>;

export interface CallOptions {
  query?: Query;
  body?: Json;
}

export class CloudflareApi {
  private readonly deps: CloudDeps;
  private readonly token: string;
  private readonly readOnly: boolean;
  /** Counts the calls that change something (a test asserts it; `--dry-run` keeps it at zero). */
  mutations = 0;

  constructor(deps: CloudDeps, report: Report, token: string, readOnly: boolean) {
    this.deps = deps;
    this.token = token;
    this.readOnly = readOnly;
    report.protect(token);
  }

  static fromTokenFile(context: { deps: CloudDeps; report: Report }, tokenFile: string, readOnly: boolean) {
    const token = readCloudflareToken(tokenFile);
    return new CloudflareApi(context.deps, context.report, token, readOnly);
  }

  private async send(method: string, apiPath: string, options: CallOptions): Promise<Envelope> {
    const mutating = method !== 'GET';
    if (mutating && this.readOnly)
      throw new Error(`internal error: ${method} ${apiPath} in a read-only run (--dry-run)`);
    const url = new URL(`${API}${apiPath}`);
    for (const [name, value] of Object.entries(options.query ?? {}))
      url.searchParams.set(name, String(value));
    const call = `${method} ${apiPath}`;
    for (let attempt = 1; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.deps.fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/json',
            ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        throw new CloudError(
          `Cloudflare ${call} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (mutating) this.mutations += 1;
      if (response.status === 429 && attempt < RATE_LIMIT_ATTEMPTS) {
        const wait = Number(response.headers.get('retry-after'));
        await this.deps.sleep(Number.isFinite(wait) && wait > 0 ? Math.min(wait, 30) * 1000 : 2000);
        continue;
      }
      let envelope: Envelope = {};
      try {
        envelope = (await response.json()) as Envelope;
      } catch {
        if (response.ok) throw new CloudError(`Cloudflare ${call} answered something that is not JSON`);
      }
      if (!response.ok || envelope.success === false)
        throw new CloudflareError(call, response.status, envelope.errors ?? []);
      return envelope;
    }
  }

  /** The `result` of a call, as the caller expects it (the shape is the caller's responsibility). */
  async call<T = Json>(method: string, apiPath: string, options: CallOptions = {}): Promise<T> {
    const envelope = await this.send(method, apiPath, options);
    return (envelope.result ?? null) as T;
  }

  get<T = Json>(apiPath: string, query?: Query): Promise<T> {
    return this.call<T>('GET', apiPath, query ? { query } : {});
  }

  /** A GET whose 404 means "not there": returns null then. */
  async getOrNull<T = Json>(apiPath: string, query?: Query): Promise<T | null> {
    try {
      return await this.get<T>(apiPath, query);
    } catch (error) {
      if (error instanceof CloudflareError && error.status === 404) return null;
      throw error;
    }
  }

  post<T = Json>(apiPath: string, body: Json): Promise<T> {
    return this.call<T>('POST', apiPath, { body });
  }

  put<T = Json>(apiPath: string, body: Json): Promise<T> {
    return this.call<T>('PUT', apiPath, { body });
  }

  patch<T = Json>(apiPath: string, body: Json): Promise<T> {
    return this.call<T>('PATCH', apiPath, { body });
  }

  delete<T = Json>(apiPath: string): Promise<T> {
    return this.call<T>('DELETE', apiPath);
  }

  /** Every item of a paged list (`page` and `per_page`). */
  async list<T = Json>(apiPath: string, query: Query = {}): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const envelope = await this.send('GET', apiPath, { query: { ...query, page, per_page: PAGE_SIZE } });
      if (!Array.isArray(envelope.result))
        throw new CloudError(`Cloudflare GET ${apiPath} answered in an unexpected list shape`);
      const items = envelope.result as T[];
      all.push(...items);
      const pages = envelope.result_info?.total_pages;
      if (items.length === 0 || (pages !== undefined ? page >= pages : items.length < PAGE_SIZE)) break;
    }
    return all;
  }
}

/** The token of the token file: refuses a wide mode or a link, an empty or a missing file (exit status 2). */
export function readCloudflareToken(tokenFile: string): string {
  const text = readSecret(tokenFile);
  if (text === null)
    throw refused(
      `${tokenFile} does not exist; create the Cloudflare API token (docs/AWS.md, "The Cloudflare token") and save it there with mode 600`,
    );
  const token = text.trim();
  if (token === '' || /\s/.test(token))
    throw refused(`${tokenFile} must hold the API token and nothing else`);
  return token;
}

/** Whether two JSON values are equal (key order does not matter). */
export function sameJson(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
