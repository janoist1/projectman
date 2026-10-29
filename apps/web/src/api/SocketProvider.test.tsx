import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/Toast';
import { SocketProvider } from './SocketProvider';
import type { SocketClient } from './socket';

function stubClient() {
  return {
    onEvent: vi.fn(() => () => {}),
    onReconnect: vi.fn(() => () => {}),
    reportVisibility: vi.fn(),
    checkAlive: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

function mount(client: ReturnType<typeof stubClient>) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ToastProvider>
        <SocketProvider client={client as unknown as SocketClient}>
          <p>child</p>
        </SocketProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => setVisibility('visible'));

describe('SocketProvider visibility report', () => {
  it('reports the state of the page when it connects, and again on every change', () => {
    const client = stubClient();
    mount(client);
    expect(client.reportVisibility).toHaveBeenLastCalledWith(true);
    // It is said before the connection starts, so the first open already carries it.
    expect(client.reportVisibility.mock.invocationCallOrder[0]!).toBeLessThan(
      client.start.mock.invocationCallOrder[0]!,
    );
    setVisibility('hidden');
    expect(client.reportVisibility).toHaveBeenLastCalledWith(false);
    setVisibility('visible');
    expect(client.reportVisibility).toHaveBeenLastCalledWith(true);
    expect(client.reportVisibility).toHaveBeenCalledTimes(3);
  });

  it('checks the connection whenever the page becomes visible, not when it hides', () => {
    const client = stubClient();
    mount(client);
    client.checkAlive.mockClear();
    setVisibility('hidden');
    expect(client.checkAlive).not.toHaveBeenCalled();
    setVisibility('visible');
    expect(client.checkAlive).toHaveBeenCalledTimes(1);
  });

  it('stops listening when it unmounts', () => {
    const client = stubClient();
    const view = mount(client);
    view.unmount();
    client.reportVisibility.mockClear();
    setVisibility('hidden');
    expect(client.reportVisibility).not.toHaveBeenCalled();
    expect(client.stop).toHaveBeenCalled();
  });
});
