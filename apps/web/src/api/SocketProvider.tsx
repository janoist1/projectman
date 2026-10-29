import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useToast } from '../components/toastContext';
import { t } from '../i18n/t';
import type { Me } from '@projectman/shared';
import { codeMessage } from '../lib/errors';
import { outageEndedToast } from '../lib/outage';
import { applyServerEvent } from './cache';
import { queryKeys } from './queryKeys';
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
      // An outage that ended by itself (PM-468) is told to whom the alert was for.
      if (event.type === 'inbox_upserted') {
        const me = queryClient.getQueryData<Me>(queryKeys.me);
        const text = outageEndedToast(event.item, me?.handles[event.projectKey] ?? null);
        if (text) toast.show(text, 'ok');
      }
    });
    // Events may have been missed while disconnected: refetch everything project-scoped.
    const offReconnect = client.onReconnect(() => {
      void queryClient.invalidateQueries({ queryKey: ['project'] });
      void queryClient.invalidateQueries({ queryKey: ['engines'] });
      void queryClient.invalidateQueries({ queryKey: ['integrator-keys'] });
    });
    // Whether this tab is on screen goes to the server on connect and on every change (PM-815).
    // A hidden tab's timers run late, so a connection that died meanwhile is dropped as the tab comes back.
    const reportVisibility = () => {
      client.reportVisibility(document.visibilityState === 'visible');
      if (document.visibilityState === 'visible') client.checkAlive();
    };
    reportVisibility();
    document.addEventListener('visibilitychange', reportVisibility);
    client.start();
    return () => {
      offEvent();
      offReconnect();
      document.removeEventListener('visibilitychange', reportVisibility);
      client.stop();
    };
  }, [client, queryClient, toast]);

  return <SocketContext.Provider value={client}>{children}</SocketContext.Provider>;
}
