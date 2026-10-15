import { useState } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { useSetupStatus } from '../../api/queries';
import { t } from '../../i18n/t';
import { useDocumentTitle } from '../../lib/hooks';
import { AuthLayout } from './AuthLayout';
import { EmailLoginFlow } from './EmailLoginFlow';
import { safeNextOrNull } from './emailLogin';
import { PasswordLoginForm } from './PasswordLoginForm';
import styles from './AuthLayout.module.css';

export function LoginPage() {
  useDocumentTitle(t('auth.login.title'));
  const [params] = useSearchParams();
  const next = safeNextOrNull(params.get('next'));
  const status = useSetupStatus();
  const [email, setEmail] = useState('');
  // Behind an invitation the person has an account and a password; otherwise the code comes first.
  const [mode, setMode] = useState<'code' | 'password'>(next?.startsWith('/invite/') ? 'password' : 'code');

  if (status.data?.needsSetup) return <Navigate to="/setup" replace />;

  if (status.isPending)
    return (
      <AuthLayout title={t('auth.login.title')} subtitle={t('auth.login.subtitle')}>
        <div className={styles.skeletons} aria-busy="true">
          <div className={styles.skeleton} />
          <div className={`${styles.skeleton} ${styles.skeletonButton}`} />
          <span className="visually-hidden">{t('app.loading')}</span>
        </div>
      </AuthLayout>
    );

  // An older server, or one without a mailer, does not say so: the login is the password's alone.
  if (status.data?.emailLoginEnabled !== true)
    return (
      <AuthLayout title={t('auth.login.title')} subtitle={t('auth.login.subtitle')}>
        <PasswordLoginForm email={email} onEmailChange={setEmail} next={next} />
      </AuthLayout>
    );

  if (mode === 'password')
    return (
      <AuthLayout title={t('auth.login.title')} subtitle={t('auth.emailLogin.passwordSubtitle')}>
        <PasswordLoginForm
          email={email}
          onEmailChange={setEmail}
          next={next}
          focus={email.trim() ? 'password' : 'email'}
        />
        <div className={styles.alt}>
          {t('auth.emailLogin.noPassword')}
          <button type="button" className={styles.linkButton} onClick={() => setMode('code')}>
            {t('auth.emailLogin.useCode')}
          </button>
        </div>
      </AuthLayout>
    );

  return (
    <EmailLoginFlow
      email={email}
      onEmailChange={setEmail}
      next={next}
      onUsePassword={() => setMode('password')}
    />
  );
}
