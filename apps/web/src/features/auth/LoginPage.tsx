import { useState } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { useSetupStatus } from '../../api/queries';
import { t } from '../../i18n/t';
import { useDocumentTitle } from '../../lib/hooks';
import { AuthLayout } from './AuthLayout';
import { safeNextOrNull } from './emailLogin';
import { PasswordLoginForm } from './PasswordLoginForm';
import styles from './AuthLayout.module.css';

/**
 * The login page: e-mail and password only. A client without a password gets in through the
 * invitation page (the e-mail code lives there); a client who has an account but no (or a forgotten)
 * password sets one with an e-mailed code, on the page the link below the password field leads to (PM-946).
 */
export function LoginPage() {
  useDocumentTitle(t('auth.login.title'));
  const [params] = useSearchParams();
  const next = safeNextOrNull(params.get('next'));
  const status = useSetupStatus();
  const [email, setEmail] = useState('');

  if (status.data?.needsSetup) return <Navigate to="/setup" replace />;

  return (
    <AuthLayout title={t('auth.login.title')} subtitle={t('auth.login.subtitle')}>
      {status.isPending ? (
        <div className={styles.skeletons} aria-busy="true">
          <div className={styles.skeleton} />
          <div className={`${styles.skeleton} ${styles.skeletonButton}`} />
          <span className="visually-hidden">{t('app.loading')}</span>
        </div>
      ) : (
        <PasswordLoginForm
          email={email}
          onEmailChange={setEmail}
          next={next}
          passwordCodes={status.data?.emailLoginEnabled === true}
        />
      )}
    </AuthLayout>
  );
}
