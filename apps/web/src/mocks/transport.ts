import { ClientCommand } from '@projectman/shared';
import type { ServerEvent } from '@projectman/shared';
import type { WebSocketLike } from '../api/socket';
import type { MockBackend, MockConnection } from './backend';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** fetch() replacement that answers /api requests from the in-memory backend. */
export function createMockFetch(backend: MockBackend) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input, window.location.origin);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown;
    if (typeof init?.body === 'string' && init.body.length > 0) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = undefined;
      }
    }
    await delay(120 + Math.random() * 180);
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const result = backend.handle(method, url.pathname, body);
    const payload = result.body === undefined || result.status === 204 ? null : JSON.stringify(result.body);
    return new Response(payload, {
      status: result.status,
      headers: payload ? { 'content-type': 'application/json' } : {},
    });
  };
}

/** In-memory stand-in for the browser WebSocket, connected to the mock backend. */
export class MockWebSocket implements WebSocketLike, MockConnection {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private disconnect: (() => void) | null = null;
  private readonly backend: MockBackend;

  constructor(backend: MockBackend) {
    this.backend = backend;
    setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      // Register first: the client replays its subscriptions from onopen.
      this.disconnect = this.backend.connect(this);
      this.onopen?.(new Event('open'));
    }, 80);
  }

  deliver(event: ServerEvent): void {
    if (this.readyState !== 1) return;
    const data = JSON.stringify(event);
    setTimeout(() => this.onmessage?.(new MessageEvent('message', { data })), 0);
  }

  send(data: string): void {
    if (this.readyState !== 1) return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const command = ClientCommand.safeParse(json);
    if (command.success) this.backend.handleCommand(this, command.data);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.disconnect?.();
    this.disconnect = null;
    this.onclose?.(new Event('close') as CloseEvent);
  }
}
