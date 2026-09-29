import { useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { isApiError, onUnauthorized } from '../api/client';
import { useMe, useSetupStatus } from '../api/queries';
import { SocketProvider } from '../api/SocketProvider';
import { ErrorState, LoadingState } from '../components/States';
import { MeContext } from './contexts';
import { loginPath } from './paths';
import styles from './AuthGate.module.css';

/**
 * Lets the app through once the owner account exists and the user is logged in;
 * otherwise sends them to the setup or login page. Also owns the websocket.
 */
export function AuthGate() {
  const location = useLocation();
  const setup = useSetupStatus();
  const needsSetup = setup.data?.needsSetup;
  const me = useMe(needsSetup === false);
  const [expired, setExpired] = useState(false);

  useEffect(() => onUnauthorized(() => setExpired(true)), []);

  const next = `${location.pathname}${location.search}`;
  if (setup.isPending) return <LoadingState className={styles.full} />;
  if (setup.isError)
    return <ErrorState className={styles.full} error={setup.error} onRetry={() => void setup.refetch()} />;
  if (needsSetup) return <Navigate to="/setup" replace />;
  if (expired) return <Navigate to={loginPath(next)} replace />;
  if (me.isPending) return <LoadingState className={styles.full} />;
  if (me.isError) {
    if (isApiError(me.error) && me.error.status === 401) return <Navigate to={loginPath(next)} replace />;
    return <ErrorState className={styles.full} error={me.error} onRetry={() => void me.refetch()} />;
  }
  return (
    <MeContext.Provider value={me.data}>
      <SocketProvider>
        <Outlet />
      </SocketProvider>
    </MeContext.Provider>
  );
}
