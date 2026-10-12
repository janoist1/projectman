import type {
  FeedbackAnchor,
  FeedbackMarkDetail,
  FeedbackMarkView,
  FeedbackPerson,
  FeedbackSessionResponse,
} from '@projectman/shared';

export const API = 'http://api.test';
export const PAGE = 'http://shop.test/page';
/** A well-formed launch code: 43 base64url characters. */
export const CODE = 'a'.repeat(43);

/** Points the happy-dom window at an address (its location is not writable otherwise). */
export function setUrl(url: string): void {
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(url);
}

export const person = (overrides: Partial<FeedbackPerson> = {}): FeedbackPerson => ({
  handle: 'anna',
  name: 'Kovács Anna',
  kind: 'human',
  color: 1,
  ...overrides,
});

export const pointAnchor = (x = 100, y = 200): FeedbackAnchor => ({
  kind: 'point',
  selector: null,
  textSnippet: null,
  elementOffset: null,
  pagePoint: { x, y },
  rect: null,
});

export const pageAnchor = (): FeedbackAnchor => ({
  kind: 'page',
  selector: null,
  textSnippet: null,
  elementOffset: null,
  pagePoint: null,
  rect: null,
});

export function mark(overrides: Partial<FeedbackMarkView> = {}): FeedbackMarkView {
  return {
    id: 'fbm_aaaaaaaaaa',
    projectKey: 'PM',
    author: person(),
    surface: { id: 'fbs_1', name: 'Shop', origin: 'http://shop.test' },
    pageUrl: PAGE,
    pagePath: '/page',
    pageTitle: 'Page',
    kind: 'point',
    body: 'The button is cut off',
    anchor: pointAnchor(),
    status: 'new',
    outcome: null,
    card: null,
    working: false,
    commentCount: 0,
    unread: false,
    hasScreenshot: false,
    createdAt: '2026-10-12T08:00:00.000Z',
    updatedAt: '2026-10-12T08:00:00.000Z',
    lastActivityAt: '2026-10-12T08:00:00.000Z',
    closedAt: null,
    ...overrides,
  };
}

export const detail = (overrides: Partial<FeedbackMarkDetail> = {}): FeedbackMarkDetail => ({
  ...mark(),
  thread: [],
  environment: null,
  screenshot: null,
  canProcess: false,
  canComment: true,
  ...overrides,
});

export const session = (overrides: Partial<FeedbackSessionResponse> = {}): FeedbackSessionResponse => ({
  token: 'tok_secret',
  expiresAt: '2026-11-12T08:00:00.000Z',
  me: person(),
  project: { key: 'PM', name: 'projectman' },
  surface: { id: 'fbs_1', name: 'Shop', origin: 'http://shop.test' },
  markId: null,
  appUrl: 'http://app.test/p/PM/feedback',
  ...overrides,
});

export interface RecordedCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Handler = (call: RecordedCall) => Response | Promise<Response>;

export const reply = (status: number, body?: unknown, headers: Record<string, string> = {}): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

export const failure = (status: number, code: string, headers: Record<string, string> = {}): Response =>
  reply(status, { error: { code, message: code, details: null } }, headers);

/**
 * A fake of the widget API: handlers by `METHOD /path` (the query string is dropped from the key), and
 * every request recorded. An unknown route answers 404.
 */
export function fakeServer(handlers: Record<string, Handler>) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const call: RecordedCall = {
      method: init?.method ?? 'GET',
      path: `${url.pathname.replace('/feedback/api/v1', '')}${url.search}`,
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const handler = handlers[`${call.method} ${url.pathname.replace('/feedback/api/v1', '')}`];
    return handler ? handler(call) : failure(404, 'not_found');
  }) as typeof fetch;
  return { fetchImpl, calls };
}

export const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
