import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { useToast } from '../components/Toast';
import { t } from '../i18n/t';
import { codeMessage } from '../lib/errors';
import { applyServerEvent } from './cache';
import { createSocketClient } from './socket';
import type { ConnectionStatus, SocketClient } from './socket';

const SocketContext = createContext<SocketClient | null>(null);

/** Owns the websocket for a logged-in user and feeds its events into the query cache. */
export function SocketProvider({
  children,
  client: provided,
}: {
  children: ReactNode;
  client?: SocketClient;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [client] = useState(() => provided ?? createSocketClient());

  useEffect(() => {
    const offEvent = client.onEvent((event) => {
      applyServerEvent(queryClient, event);
      // Error events carry a code; show it translated, never raw.
      if (event.type === 'error') toast.show(codeMessage(event.message) ?? t('errors.generic'), 'error');
    });
    // Events may have been missed while disconnected: refetch everything project-scoped.
    const offReconnect = client.onReconnect(() => {
      void queryClient.invalidateQueries({ queryKey: ['project'] });
    });
    client.start();
    return () => {
      offEvent();
      offReconnect();
      client.stop();
    };
  }, [client, queryClient, toast]);

  return <SocketContext.Provider value={client}>{children}</SocketContext.Provider>;
}

export function useSocket(): SocketClient {
  const client = useContext(SocketContext);
  if (!client) throw new Error('useSocket must be used inside <SocketProvider>');
  return client;
}

/** Null outside a provider (e.g. in component tests). */
export function useOptionalSocket(): SocketClient | null {
  return useContext(SocketContext);
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
