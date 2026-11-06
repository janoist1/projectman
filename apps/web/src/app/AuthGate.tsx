import { useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { isApiError, onUnauthorized } from '../api/client';
import { useMe, useSetUiStyle, useSetupStatus } from '../api/queries';
import { SocketProvider } from '../api/SocketProvider';
import { ErrorState, LoadingState } from '../components/States';
import { setCurrentLanguage } from '../i18n/language';
import { DEFAULT_UI_STYLE, applyUiStyle, clearUiStylePending, pendingUiStyle } from '../lib/uiStyle';
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

  // The account's language wins over the one stored in this browser (PM-1168); it is stored for the next login page.
  const accountLanguage = me.data?.language;
  useEffect(() => {
    if (accountLanguage) setCurrentLanguage(accountLanguage);
  }, [accountLanguage]);

  // The style saved on the account follows the user to every device (PM-363). A choice whose save failed stays on
  // this device and is saved again now and whenever the connection returns.
  const loaded = me.data !== undefined;
  const savedStyle = me.data?.uiStyle ?? DEFAULT_UI_STYLE;
  const { mutate: saveStyle } = useSetUiStyle();
  useEffect(() => {
    if (!loaded) return;
    const pending = pendingUiStyle();
    if (!pending || pending === savedStyle) {
      clearUiStylePending(savedStyle);
      applyUiStyle(savedStyle);
      return;
    }
    applyUiStyle(pending);
    const resave = () => saveStyle({ style: pending }, { onSuccess: () => clearUiStylePending(pending) });
    resave();
    window.addEventListener('online', resave);
    return () => window.removeEventListener('online', resave);
  }, [loaded, savedStyle, saveStyle]);

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
