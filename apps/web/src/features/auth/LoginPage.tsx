import { useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { isApiError } from '../../api/client';
import { useLogin, useSetupStatus } from '../../api/queries';
import { Button } from '../../components/Button';
import { PasswordField, TextField } from '../../components/Field';
import { ErrorBanner } from '../../components/ErrorBanner';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { useDocumentTitle } from '../../lib/hooks';
import { AuthLayout } from './AuthLayout';
import styles from './AuthLayout.module.css';

/** Only same-app paths are accepted as a return target. */
function safeNext(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

export function LoginPage() {
  useDocumentTitle(t('auth.login.title'));
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const status = useSetupStatus();
  const login = useLogin();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});

  if (status.data?.needsSetup) return <Navigate to="/setup" replace />;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const found: { email?: string; password?: string } = {};
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) found.email = t('auth.validation.emailInvalid');
    if (!password) found.password = t('auth.validation.passwordRequired');
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    login.mutate({ email: email.trim(), password }, { onSuccess: () => navigate(next, { replace: true }) });
  };

  const failure = login.isError
    ? isApiError(login.error) && (login.error.status === 401 || login.error.status === 400)
      ? t('auth.login.invalid')
      : errorMessage(login.error)
    : null;

  return (
    <AuthLayout title={t('auth.login.title')} subtitle={t('auth.login.subtitle')}>
      <form className={styles.form} onSubmit={onSubmit} noValidate>
        <TextField
          label={t('auth.login.email')}
          type="email"
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          error={errors.email}
          required
          autoFocus
        />
        <PasswordField
          label={t('auth.login.password')}
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={errors.password}
          required
        />
        {failure ? <ErrorBanner>{failure}</ErrorBanner> : null}
        <Button type="submit" variant="primary" size="xl" fullWidth loading={login.isPending}>
          {login.isPending ? t('auth.login.submitting') : t('auth.login.submit')}
        </Button>
      </form>
    </AuthLayout>
  );
}
