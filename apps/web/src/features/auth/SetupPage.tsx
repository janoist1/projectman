import { useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { useSetup, useSetupStatus } from '../../api/queries';
import { Button } from '../../components/Button';
import { PasswordField, TextField } from '../../components/Field';
import { LoadingState } from '../../components/States';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { useDocumentTitle } from '../../lib/hooks';
import { AuthLayout } from './AuthLayout';
import { validateSetup } from './validation';
import type { SetupErrors } from './validation';
import styles from './AuthLayout.module.css';

/** First run: creates the owner account. */
export function SetupPage() {
  useDocumentTitle(t('auth.setup.title'));
  const status = useSetupStatus();
  const setup = useSetup();
  const navigate = useNavigate();
  const [values, setValues] = useState({ name: '', email: '', password: '' });
  const [errors, setErrors] = useState<SetupErrors>({});

  if (status.isPending) return <LoadingState />;
  if (status.data && !status.data.needsSetup) return <Navigate to="/" replace />;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const found = validateSetup(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setup.mutate(
      { name: values.name.trim(), email: values.email.trim(), password: values.password },
      { onSuccess: () => navigate('/', { replace: true }) },
    );
  };

  return (
    <AuthLayout title={t('auth.setup.title')} subtitle={t('auth.setup.subtitle')}>
      <form className={styles.form} onSubmit={onSubmit} noValidate>
        <TextField
          label={t('auth.setup.name')}
          autoComplete="name"
          value={values.name}
          onChange={(event) => setValues({ ...values, name: event.target.value })}
          error={errors.name}
          required
          autoFocus
        />
        <TextField
          label={t('auth.setup.email')}
          type="email"
          autoComplete="email"
          value={values.email}
          onChange={(event) => setValues({ ...values, email: event.target.value })}
          error={errors.email}
          required
        />
        <PasswordField
          label={t('auth.setup.password')}
          autoComplete="new-password"
          hint={t('auth.setup.passwordHint')}
          value={values.password}
          onChange={(event) => setValues({ ...values, password: event.target.value })}
          error={errors.password}
          required
          minLength={8}
        />
        {setup.isError ? (
          <p className={styles.formError} role="alert">
            {errorMessage(setup.error)}
          </p>
        ) : null}
        <Button type="submit" variant="primary" size="xl" fullWidth loading={setup.isPending}>
          {setup.isPending ? t('auth.setup.submitting') : t('auth.setup.submit')}
        </Button>
      </form>
    </AuthLayout>
  );
}
