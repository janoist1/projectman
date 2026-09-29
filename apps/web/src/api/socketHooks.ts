import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import type { ConnectionStatus, SocketClient } from './socket';

export const SocketContext = createContext<SocketClient | null>(null);

export function useSocket(): SocketClient {
  const client = useContext(SocketContext);
  if (!client) throw new Error('useSocket must be used inside <SocketProvider>');
  return client;
}

const noopSubscribe = () => () => {};
const openStatus = (): ConnectionStatus => 'open';

export function useConnectionStatus(): ConnectionStatus {
  const client = useContext(SocketContext);
  return useSyncExternalStore(
    client ? (listener) => client.onStatusChange(listener) : noopSubscribe,
    client ? client.getStatus : openStatus,
  );
}

/** Keeps the live subscription for a project while the calling screen is mounted. */
export function useProjectSubscription(projectKey: string | undefined): void {
  const client = useContext(SocketContext);
  useEffect(() => {
    if (!client || !projectKey) return;
    return client.subscribeProject(projectKey);
  }, [client, projectKey]);
}
