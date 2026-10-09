import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useToast } from '../components/toastContext';
import { t } from '../i18n/t';
import { codeMessage } from '../lib/errors';
import { applyServerEvent } from './cache';
import { createSocketClient } from './socket';
import type { SocketClient } from './socket';
import { SocketContext } from './socketHooks';

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
      void queryClient.invalidateQueries({ queryKey: ['engines'] });
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
