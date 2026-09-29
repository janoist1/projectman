import type { ServerEvent } from '@projectman/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SocketClient, clampTerminalSize } from './socket';
import type { WebSocketLike } from './socket';

class FakeSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  sent: unknown[] = [];

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  receive(event: ServerEvent | string) {
    this.onmessage?.(new MessageEvent('message', { data: typeof event === 'string' ? event : JSON.stringify(event) }));
  }
  drop() {
    this.readyState = 3;
    this.onclose?.(new Event('close') as CloseEvent);
  }
}

describe('SocketClient', () => {
  let sockets: FakeSocket[];
  let client: SocketClient;

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    client = new SocketClient({
      url: 'ws://test/ws',
      factory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      baseDelayMs: 100,
      maxDelayMs: 1000,
    });
  });

  afterEach(() => {
    client.stop();
    vi.useRealTimers();
  });

  it('subscribes once per project and unsubscribes when the last user leaves', () => {
    client.start();
    sockets[0]!.open();
    const first = client.subscribeProject('AC');
    const second = client.subscribeProject('AC');
    expect(sockets[0]!.sent).toEqual([{ type: 'subscribe_project', projectKey: 'AC' }]);
    first();
    expect(sockets[0]!.sent).toHaveLength(1);
    second();
    expect(sockets[0]!.sent.at(-1)).toEqual({ type: 'unsubscribe_project', projectKey: 'AC' });
  });

  it('reconnects with backoff and replays subscriptions and terminal attachments', () => {
    const onReconnect = vi.fn();
    client.onReconnect(onReconnect);
    client.subscribeProject('AC');
    client.attachTerminal('ses_1', { onData: () => {}, onSnapshot: () => {} });
    client.start();
    sockets[0]!.open();
    expect(sockets[0]!.sent).toEqual([
      { type: 'subscribe_project', projectKey: 'AC' },
      { type: 'terminal_attach', sessionId: 'ses_1' },
    ]);
    expect(client.getStatus()).toBe('open');

    sockets[0]!.drop();
    expect(client.getStatus()).toBe('reconnecting');
    vi.advanceTimersByTime(200);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(sockets[1]!.sent).toEqual([
      { type: 'subscribe_project', projectKey: 'AC' },
      { type: 'terminal_attach', sessionId: 'ses_1' },
    ]);
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('routes terminal frames to the attached view and other events to listeners', () => {
    const onData = vi.fn();
    const onSnapshot = vi.fn();
    const onEvent = vi.fn();
    client.onEvent(onEvent);
    client.start();
    sockets[0]!.open();
    client.attachTerminal('ses_1', { onData, onSnapshot });
    sockets[0]!.receive({ type: 'terminal_snapshot', sessionId: 'ses_1', data: 'screen', cols: 100, rows: 30 });
    sockets[0]!.receive({ type: 'terminal_data', sessionId: 'ses_1', data: 'abc' });
    sockets[0]!.receive({ type: 'terminal_data', sessionId: 'ses_2', data: 'other' });
    sockets[0]!.receive({ type: 'config_changed', projectKey: 'AC', version: 'v2' });
    expect(onSnapshot).toHaveBeenCalledWith('screen', 100, 30);
    expect(onData).toHaveBeenCalledTimes(1);
    expect(onData).toHaveBeenCalledWith('abc');
    expect(onEvent).toHaveBeenCalledWith({ type: 'config_changed', projectKey: 'AC', version: 'v2' });
  });

  it('ignores frames that are not valid protocol events', () => {
    const onEvent = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    client.onEvent(onEvent);
    client.start();
    sockets[0]!.open();
    sockets[0]!.receive('not json');
    sockets[0]!.receive(JSON.stringify({ type: 'nope' }));
    expect(onEvent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('sends terminal input and clamped resizes', () => {
    client.start();
    sockets[0]!.open();
    client.terminalInput('ses_1', 'ls\r');
    client.terminalResize('ses_1', 2, 1000);
    expect(sockets[0]!.sent).toEqual([
      { type: 'terminal_input', sessionId: 'ses_1', data: 'ls\r' },
      { type: 'terminal_resize', sessionId: 'ses_1', cols: 10, rows: 300 },
    ]);
    expect(clampTerminalSize(120.4, 40.6)).toEqual({ cols: 120, rows: 41 });
  });
});
