import { CLIENT_CHANNEL_HEADER, CLIENT_CHANNEL_VALUE } from '@projectman/shared';
import type { ClientCredentials } from './config';
import { redact, safeMessage } from './redact';

/** Everything that went wrong with one request, with the secrets already taken out of its text. */
export class ApiError extends Error {
  readonly kind: 'auth' | 'refused' | 'network' | 'redirect' | 'protocol';
  readonly code: string;
  readonly status: number | null;
  /** A write whose request left the machine and whose answer never came: it may or may not have happened. */
  readonly uncertain: boolean;
  /** The id the failed write carried, so the user can read its state. Set by the client that sent it. */
  requestId: string | null = null;
  constructor(
    kind: 'auth' | 'refused' | 'network' | 'redirect' | 'protocol',
    code: string,
    message: string,
    status: number | null = null,
    uncertain = false,
  ) {
    super(message);
    this.kind = kind;
    this.code = code;
    this.status = status;
    this.uncertain = uncertain;
    this.name = 'ApiError';
  }
}

export interface ApiRequest {
  method: 'GET' | 'POST' | 'PUT';
  /** The path with its query already encoded, starting with `/`. */
  path: string;
  body?: unknown;
  /** Separate from the method: a POST can read. */
  write: boolean;
  signal?: AbortSignal | undefined;
  /** The client's own id of the write, for correlation in the server's and the user's records. */
  requestId?: string | undefined;
}

export interface ApiResponse {
  status: number;
  json: unknown;
}

export interface ApiClientOptions {
  credentials: ClientCredentials;
  fetch: typeof fetch;
  /** Debug lines (method, path, status only), already redacted. */
  verbose?: ((line: string) => void) | undefined;
  timeoutMs?: number;
}

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * One request to the server with the integrator's headers. The key and the Access headers are put into the
 * request here and nowhere else; a 3xx is never followed (a redirect to another origin would take them along);
 * every message that comes out of here is redacted.
 */
export function createApiClient(options: ApiClientOptions) {
  const { credentials } = options;
  const secrets = credentials.secrets;
  const origin = credentials.baseUrl.origin;

  async function send(request: ApiRequest): Promise<ApiResponse> {
    try {
      return await sendOnce(request);
    } catch (error) {
      if (error instanceof ApiError && error.uncertain) error.requestId = request.requestId ?? null;
      throw error;
    }
  }

  async function sendOnce(request: ApiRequest): Promise<ApiResponse> {
    const url = new URL(request.path, origin);
    if (url.origin !== origin)
      throw new ApiError('protocol', 'cross_origin', 'refusing a request to another origin');
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${credentials.key}`,
      [CLIENT_CHANNEL_HEADER]: CLIENT_CHANNEL_VALUE,
      ...credentials.accessHeaders,
    };
    if (request.body !== undefined) headers['content-type'] = 'application/json';
    if (request.requestId) headers['x-request-id'] = request.requestId;
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 60_000);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    options.verbose?.(redact(`${request.method} ${url.pathname}`, secrets));
    let response: Response;
    try {
      response = await options.fetch(url, {
        method: request.method,
        headers,
        redirect: 'manual',
        signal,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });
    } catch (error) {
      if (request.signal?.aborted) throw error;
      throw new ApiError(
        'network',
        'network_error',
        `the request failed: ${safeMessage(error, secrets)}`,
        null,
        request.write,
      );
    }
    options.verbose?.(`  -> ${response.status}`);
    if (response.status >= 300 && response.status < 400)
      throw new ApiError(
        'redirect',
        'redirect_refused',
        `the server answered with a redirect (${response.status}); redirects are not followed`,
        response.status,
        request.write,
      );
    let text: string;
    try {
      text = await readLimited(response);
    } catch (error) {
      if (request.signal?.aborted) throw error;
      throw new ApiError(
        'network',
        'network_error',
        `the answer could not be read: ${safeMessage(error, secrets)}`,
        response.status,
        request.write,
      );
    }
    // A gateway answer (Cloudflare or a proxy while the server restarts) says nothing about the request: the
    // server's own refusals carry an error code. It is a network-like failure, which `events follow` retries; a
    // change behind a 502 or 504 may have run, a 503 was not served.
    if (GATEWAY_STATUSES.has(response.status) && !hasServerErrorCode(text))
      throw new ApiError(
        'network',
        'gateway_error',
        `the server could not be reached through its gateway (HTTP ${response.status})`,
        response.status,
        request.write && response.status !== 503,
      );
    let json: unknown = null;
    if (text.trim() !== '') {
      try {
        json = JSON.parse(text);
      } catch {
        throw new ApiError(
          'protocol',
          'invalid_response',
          'the server answered with something that is not JSON',
          response.status,
          request.write && response.ok,
        );
      }
    }
    if (response.ok) return { status: response.status, json };
    const failure = errorOf(json);
    const code = redact(failure.code, secrets);
    const message = redact(failure.message, secrets);
    if (response.status === 401) throw new ApiError('auth', code, message, response.status);
    throw new ApiError('refused', code, message, response.status);
  }

  return { send, origin };
}
export type ApiClient = ReturnType<typeof createApiClient>;

const GATEWAY_STATUSES = new Set([502, 503, 504]);

function hasServerErrorCode(text: string): boolean {
  try {
    return typeof (JSON.parse(text) as { error?: { code?: unknown } } | null)?.error?.code === 'string';
  } catch {
    return false;
  }
}

function errorOf(json: unknown): { code: string; message: string } {
  const error = (json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  return {
    code: typeof error?.code === 'string' ? error.code : 'http_error',
    message: typeof error?.message === 'string' ? error.message : 'the server refused the request',
  };
}

export async function readLimited(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('the answer is too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
