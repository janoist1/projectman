import { ServerEvent } from '@projectman/shared';
import type { ClientCommand } from '@projectman/shared';

/** The subset of the browser WebSocket the client uses (tests provide their own). */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface TerminalListener {
  onSnapshot(data: string, cols: number, rows: number): void;
  onData(data: string): void;
}

export interface SocketClientOptions {
  url: string;
  factory: WebSocketFactory;
  /** First retry delay; doubles per attempt up to maxDelayMs (with jitter). */
  baseDelayMs?: number;
  maxDelayMs?: number;
}

const OPEN = 1;

export function clampTerminalSize(cols: number, rows: number): { cols: number; rows: number } {
  return {
    cols: Math.min(500, Math.max(10, Math.round(cols))),
    rows: Math.min(300, Math.max(5, Math.round(rows))),
  };
}

/**
 * Websocket connection to /ws: reconnects with exponential backoff, re-sends project
 * subscriptions and terminal attachments after every reconnect, and routes terminal
 * frames to the attached terminal views.
 */
export class SocketClient {
  private readonly options: Required<SocketClientOptions>;
  private socket: WebSocketLike | null = null;
  private status: ConnectionStatus = 'idle';
  private attempts = 0;
  private connections = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private readonly projects = new Map<string, number>();
  private readonly terminals = new Map<string, Set<TerminalListener>>();
  private readonly eventListeners = new Set<(event: ServerEvent) => void>();
  private readonly statusListeners = new Set<() => void>();
  private readonly reconnectListeners = new Set<() => void>();

  constructor(options: SocketClientOptions) {
    this.options = { baseDelayMs: 500, maxDelayMs: 15_000, ...options };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.open();
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.close(1000, 'client stopped');
    }
    this.setStatus('closed');
  }

  getStatus = (): ConnectionStatus => this.status;

  onStatusChange(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onEvent(listener: (event: ServerEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Called after a reconnect (not the first connection): events may have been missed. */
  onReconnect(listener: () => void): () => void {
    this.reconnectListeners.add(listener);
    return () => this.reconnectListeners.delete(listener);
  }

  /** Reference-counted: the subscription lasts while at least one screen needs it. */
  subscribeProject(projectKey: string): () => void {
    const count = this.projects.get(projectKey) ?? 0;
    this.projects.set(projectKey, count + 1);
    if (count === 0) this.send({ type: 'subscribe_project', projectKey });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.projects.get(projectKey) ?? 0;
      if (current <= 1) {
        this.projects.delete(projectKey);
        this.send({ type: 'unsubscribe_project', projectKey });
      } else {
        this.projects.set(projectKey, current - 1);
      }
    };
  }

  attachTerminal(sessionId: string, listener: TerminalListener): () => void {
    let listeners = this.terminals.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      this.terminals.set(sessionId, listeners);
    }
    const first = listeners.size === 0;
    listeners.add(listener);
    // Every new viewer needs the screen snapshot, so attach again even if already attached.
    if (first || this.status === 'open') this.send({ type: 'terminal_attach', sessionId });
    return () => {
      const set = this.terminals.get(sessionId);
      if (!set) return;
      set.delete(listener);
      if (set.size === 0) {
        this.terminals.delete(sessionId);
        this.send({ type: 'terminal_detach', sessionId });
      }
    };
  }

  terminalInput(sessionId: string, data: string): void {
    this.send({ type: 'terminal_input', sessionId, data });
  }

  terminalResize(sessionId: string, cols: number, rows: number): void {
    this.send({ type: 'terminal_resize', sessionId, ...clampTerminalSize(cols, rows) });
  }

  /** Sends when connected; state (subscriptions, attachments) is replayed on reconnect. */
  send(command: ClientCommand): void {
    if (this.socket && this.socket.readyState === OPEN) this.socket.send(JSON.stringify(command));
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.statusListeners.forEach((listener) => listener());
  }

  private open(): void {
    this.setStatus(this.connections === 0 ? 'connecting' : 'reconnecting');
    let socket: WebSocketLike;
    try {
      socket = this.options.factory(this.options.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempts = 0;
      this.connections += 1;
      this.setStatus('open');
      for (const projectKey of this.projects.keys()) this.send({ type: 'subscribe_project', projectKey });
      for (const sessionId of this.terminals.keys()) this.send({ type: 'terminal_attach', sessionId });
      if (this.connections > 1) this.reconnectListeners.forEach((listener) => listener());
    };
    socket.onmessage = (message) => {
      if (this.socket !== socket) return;
      this.handleMessage(message.data);
    };
    socket.onerror = () => {
      // A close event follows; reconnecting happens there.
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.running) this.scheduleReconnect();
      else this.setStatus('closed');
    };
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    this.attempts += 1;
    const { baseDelayMs, maxDelayMs } = this.options;
    const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (this.attempts - 1));
    const jittered = delay * (0.75 + Math.random() * 0.5);
    this.setStatus('reconnecting');
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.running) this.open();
    }, jittered);
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      console.warn('[ws] ignoring a frame that is not JSON');
      return;
    }
    const parsed = ServerEvent.safeParse(json);
    if (!parsed.success) {
      console.warn('[ws] ignoring an event that does not match the protocol', parsed.error.issues);
      return;
    }
    const event = parsed.data;
    if (event.type === 'terminal_data' || event.type === 'terminal_snapshot') {
      const listeners = this.terminals.get(event.sessionId);
      if (!listeners) return;
      listeners.forEach((listener) =>
        event.type === 'terminal_data'
          ? listener.onData(event.data)
          : listener.onSnapshot(event.data, event.cols, event.rows),
      );
      return;
    }
    this.eventListeners.forEach((listener) => listener(event));
  }
}

export function createSocketClient(): SocketClient {
  const { protocol, host } = window.location;
  const url = `${protocol === 'https:' ? 'wss' : 'ws'}://${host}/ws`;
  return new SocketClient({ url, factory: (target) => new WebSocket(target) });
}
