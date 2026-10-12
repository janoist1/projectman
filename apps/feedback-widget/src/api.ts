import type {
  CreateFeedbackMarkRequest,
  FeedbackMarkDetail,
  FeedbackSessionResponse,
  FeedbackWidgetListResponse,
} from '@projectman/shared';

/**
 * The client of the public widget API (`/feedback/api/v1`, PM-509). The session token is a bearer in
 * a header (no cookies: a third-party cookie would not work on the customer's page).
 */
export class ApiFailure extends Error {
  /** 0: the request did not get an answer (network, timeout, or a refused address). */
  readonly status: number;
  readonly code: string | null;
  readonly retryAfterSeconds: number | null;

  constructor(status: number, code: string | null, retryAfterSeconds: number | null = null) {
    super(code ?? `request failed (${status})`);
    this.name = 'ApiFailure';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  get unauthorized(): boolean {
    return this.status === 401;
  }
}

export interface Api {
  exchange(code: string): Promise<FeedbackSessionResponse>;
  list(since: string | null): Promise<FeedbackWidgetListResponse>;
  detail(markId: string): Promise<FeedbackMarkDetail>;
  createMark(request: CreateFeedbackMarkRequest): Promise<FeedbackMarkDetail>;
  comment(markId: string, body: string): Promise<FeedbackMarkDetail>;
  markRead(markId: string): Promise<void>;
  logout(): Promise<void>;
}

export interface ApiOptions {
  /** The origin the widget script was loaded from. */
  base: string;
  token: () => string | null;
  fetchImpl?: typeof fetch;
  /** Milliseconds; the code exchange gets `exchangeTimeoutMs`. */
  timeoutMs?: number;
  exchangeTimeoutMs?: number;
}

const PREFIX = '/feedback/api/v1';

async function failureOf(response: Response): Promise<ApiFailure> {
  let code: string | null = null;
  try {
    const body: unknown = await response.json();
    const error = (body as { error?: { code?: unknown } } | null)?.error;
    if (typeof error?.code === 'string') code = error.code;
  } catch {
    /* no JSON body */
  }
  const retry = Number(response.headers.get('retry-after'));
  return new ApiFailure(response.status, code, Number.isFinite(retry) && retry > 0 ? retry : null);
}

export function createApi(options: ApiOptions): Api {
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 15_000;
  const exchangeTimeoutMs = options.exchangeTimeoutMs ?? 10_000;

  async function send(
    method: string,
    path: string,
    body: unknown,
    { authed = true, timeout = timeoutMs } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (authed) headers.authorization = `Bearer ${options.token() ?? ''}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let response: Response;
    try {
      response = await doFetch(`${options.base}${PREFIX}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch {
      throw new ApiFailure(0, 'network');
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw await failureOf(response);
    return response;
  }

  const json = async <T>(response: Response): Promise<T> => {
    try {
      return (await response.json()) as T;
    } catch {
      throw new ApiFailure(0, 'bad_response');
    }
  };

  return {
    exchange: async (code) =>
      json(await send('POST', '/sessions', { code }, { authed: false, timeout: exchangeTimeoutMs })),
    list: async (since) =>
      json(await send('GET', `/marks${since === null ? '' : `?since=${encodeURIComponent(since)}`}`, undefined)),
    detail: async (markId) => json(await send('GET', `/marks/${encodeURIComponent(markId)}`, undefined)),
    createMark: async (request) => json(await send('POST', '/marks', request)),
    comment: async (markId, body) =>
      json(await send('POST', `/marks/${encodeURIComponent(markId)}/comments`, { body })),
    markRead: async (markId) => {
      await send('POST', `/marks/${encodeURIComponent(markId)}/read`, {});
    },
    logout: async () => {
      await send('DELETE', '/sessions/current', undefined);
    },
  };
}
