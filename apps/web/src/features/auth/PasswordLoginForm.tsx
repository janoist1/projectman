import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { isApiError } from '../../api/client';
import { useLogin } from '../../api/queries';
import { Button } from '../../components/Button';
import { PasswordField, TextField } from '../../components/Field';
import { ErrorBanner } from '../../components/ErrorBanner';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import styles from './AuthLayout.module.css';

/** The password login: the owner's and the internal members' way in. */
export function PasswordLoginForm({
  email,
  onEmailChange,
  next,
  focus = 'email',
  passwordCodes = false,
}: {
  email: string;
  onEmailChange: (value: string) => void;
  /** Where a login goes; absent: the home page. */
  next: string | null;
  /** The field that takes the focus when the form appears. */
  focus?: 'email' | 'password';
  /** Whether the server can mail a code that sets the password: shows the way to that page. */
  passwordCodes?: boolean;
}) {
  const login = useLogin();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const found: { email?: string; password?: string } = {};
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) found.email = t('auth.validation.emailInvalid');
    if (!password) found.password = t('auth.validation.passwordRequired');
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    login.mutate(
      { email: email.trim(), password },
      { onSuccess: () => navigate(next ?? '/', { replace: true }) },
    );
  };

  const failure = login.isError
    ? isApiError(login.error) && (login.error.status === 401 || login.error.status === 400)
      ? t('auth.login.invalid')
      : errorMessage(login.error)
    : null;

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate>
      <TextField
        label={t('auth.login.email')}
        type="email"
        autoComplete="username"
        value={email}
        onChange={(event) => onEmailChange(event.target.value)}
        error={errors.email}
        required
        autoFocus={focus === 'email'}
      />
      <PasswordField
        label={t('auth.login.password')}
        autoComplete="current-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        error={errors.password}
        required
        autoFocus={focus === 'password'}
      />
      {passwordCodes ? (
        <div className={styles.forgot}>
          <Link
            to={{ pathname: '/login/password', search: next ? `?next=${encodeURIComponent(next)}` : '' }}
            state={{ email: email.trim() }}
            className={styles.linkButton}
          >
            {t('auth.passwordReset.link')}
          </Link>
        </div>
      ) : null}
      {failure ? <ErrorBanner>{failure}</ErrorBanner> : null}
      <Button type="submit" variant="primary" size="xl" fullWidth loading={login.isPending}>
        {login.isPending ? t('auth.login.submitting') : t('auth.login.submit')}
      </Button>
    </form>
  );
}
