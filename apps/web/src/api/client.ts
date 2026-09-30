import { ApiError as ApiErrorBody } from '@projectman/shared';

/**
 * Minimal structural view of a zod schema, so the client does not depend on zod directly.
 * The shared package exports the schemas (BoardView, TaskDetail, ...).
 */
export interface ResponseSchema<T> {
  safeParse(data: unknown):
    | { success: true; data: T }
    | {
        success: false;
        error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> };
      };
}

/** Every failed request surfaces as an ApiError (HTTP errors, network errors, bad responses). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isNetworkError(): boolean {
    return this.status === 0;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init);

/** Swaps the transport (UI tests route requests to the in-memory MockBackend). */
export function setFetchImplementation(impl: FetchLike): void {
  fetchImpl = impl;
}

const unauthorizedListeners = new Set<() => void>();

/** Called on every 401 so the app can send the user to the login page. */
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions<T> {
  method?: HttpMethod;
  body?: unknown;
  /** Response contract; validated in development builds. */
  schema?: ResponseSchema<T>;
  signal?: AbortSignal;
}

async function readBody(res: Response): Promise<unknown> {
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('json') || /^[[{"]/.test(text.trim())) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

function formatIssues(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): string {
  return issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/** Validates a response against its contract in development; throws on mismatch. */
export function checkContract<T>(schema: ResponseSchema<T> | undefined, data: unknown, path: string): void {
  if (!schema || !import.meta.env.DEV) return;
  const result = schema.safeParse(data);
  if (!result.success) {
    const summary = formatIssues(result.error.issues);
    console.error(`[api] ${path}: response does not match the contract`, result.error.issues);
    throw new ApiError(200, 'invalid_response', `${path}: ${summary}`, result.error.issues);
  }
}

export async function apiRequest<T>(path: string, options: RequestOptions<T> = {}): Promise<T> {
  const { method = 'GET', body, schema, signal } = options;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';

  let res: Response;
  try {
    res = await fetchImpl(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'network_error', error instanceof Error ? error.message : String(error));
  }

  const data = await readBody(res);

  if (!res.ok) {
    const parsed = ApiErrorBody.safeParse(data);
    const error = parsed.success
      ? new ApiError(res.status, parsed.data.error.code, parsed.data.error.message, parsed.data.error.details)
      : new ApiError(res.status, `http_${res.status}`, res.statusText || `HTTP ${res.status}`);
    if (res.status === 401) unauthorizedListeners.forEach((listener) => listener());
    throw error;
  }

  checkContract(schema, data, path);
  return data as T;
}

/**
 * Some list endpoints have no wrapper DTO in the contract yet; accept both a bare array and
 * `{ [prop]: [...] }` and validate the items.
 */
export function unwrapList<T>(data: unknown, prop: string, item: ResponseSchema<T>, path: string): T[] {
  let list: unknown = data;
  if (!Array.isArray(list) && list !== null && typeof list === 'object') {
    list = (list as Record<string, unknown>)[prop];
  }
  if (!Array.isArray(list)) {
    throw new ApiError(200, 'invalid_response', `${path}: expected a list of ${prop}`);
  }
  list.forEach((entry) => checkContract(item, entry, path));
  return list as T[];
}
