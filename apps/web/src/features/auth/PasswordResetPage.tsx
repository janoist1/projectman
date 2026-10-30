import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router';
import { EMAIL_LOGIN_CODE_LENGTH } from '@projectman/shared';
import { useSetupStatus } from '../../api/queries';
import { Button } from '../../components/Button';
import { PasswordField, TextField } from '../../components/Field';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { useDocumentTitle } from '../../lib/hooks';
import { AuthLayout } from './AuthLayout';
import { CodeStep, FlowProblems } from './EmailCodeSteps';
import { formatCountdown, safeNextOrNull } from './emailLogin';
import { useEmailCodeFlow } from './useEmailCodeFlow';
import styles from './AuthLayout.module.css';

const MIN_PASSWORD_LENGTH = 8;

/**
 * A client sets or resets their password with a code sent by e-mail (PM-946): the address, then the code
 * and the new password on one screen. The address arrives in the router state from the login page, never in
 * the URL; the code and the password live in this component only.
 */
export function PasswordResetPage() {
  useDocumentTitle(t('auth.passwordReset.title'));
  const [params] = useSearchParams();
  const next = safeNextOrNull(params.get('next'));
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const status = useSetupStatus();
  const [email, setEmail] = useState(() => stateEmail(location.state));
  const [step, setStep] = useState<'address' | 'code'>('address');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const flow = useEmailCodeFlow({ email: email.trim() }, 'password');
  const passwordId = useId();
  const loginPath = next ? `/login?next=${encodeURIComponent(next)}` : '/login';

  if (status.data?.needsSetup) return <Navigate to="/setup" replace />;
  if (status.data && !status.data.emailLoginEnabled) return <Navigate to={loginPath} replace />;
  // The form waits for the setup status: without e-mail codes the page leads back to the login.
  if (status.isPending)
    return (
      <AuthLayout title={t('auth.passwordReset.title')} subtitle={t('auth.passwordReset.subtitle')}>
        <div className={styles.skeletons} aria-busy="true">
          <div className={styles.skeleton} />
          <div className={`${styles.skeleton} ${styles.skeletonButton}`} />
          <span className="visually-hidden">{t('app.loading')}</span>
        </div>
      </AuthLayout>
    );

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
      setEmailError(t('auth.validation.emailInvalid'));
      return;
    }
    setEmailError(null);
    const outcome = await flow.request();
    if (outcome === 'sent') setStep('code');
    else if (outcome === 'invalid_address') setEmailError(t('auth.validation.emailInvalid'));
  };

  const save = async (code: string) => {
    if (password.length < MIN_PASSWORD_LENGTH) {
      setPasswordError(t('auth.validation.passwordShort'));
      document.getElementById(passwordId)?.focus();
      return;
    }
    setPasswordError(null);
    const outcome = await flow.setPassword(code, password);
    if (outcome?.kind !== 'ok') return;
    toast.show(t('auth.passwordReset.saved'), 'ok');
    navigate(next ?? '/', { replace: true });
  };

  const back = (
    <div className={styles.alt}>
      {t('auth.passwordReset.remembered')}{' '}
      <Link to={loginPath} className={styles.linkButton}>
        {t('auth.passwordReset.backToLogin')}
      </Link>
    </div>
  );

  if (step === 'code')
    return (
      <AuthLayout
        title={t('auth.emailLogin.codeTitle')}
        subtitle={t('auth.passwordReset.codeSubtitle', {
          digits: EMAIL_LOGIN_CODE_LENGTH,
          minutes: flow.lifetimeMinutes,
        })}
        announcement={flow.announcement}
      >
        <div className={styles.step}>
          <CodeStep
            flow={flow}
            address={email.trim()}
            onOtherAddress={() => {
              flow.reset();
              setPassword('');
              setPasswordError(null);
              setStep('address');
            }}
            onSubmit={(code) => void save(code)}
            submitLabels={{
              ready: t('auth.passwordReset.save'),
              busy: t('auth.passwordReset.saving'),
              wait: (time) => t('auth.passwordReset.saveWait', { time }),
            }}
            extraFields={
              <>
                {/* Lets a password manager file the new password under the address. */}
                <input
                  type="text"
                  name="username"
                  autoComplete="username"
                  value={email.trim()}
                  readOnly
                  hidden
                />
                <PasswordField
                  id={passwordId}
                  label={t('auth.passwordReset.newPassword')}
                  hint={t('auth.passwordReset.newPasswordHint')}
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setPasswordError(null);
                  }}
                  error={passwordError}
                />
              </>
            }
          />
          {back}
        </div>
      </AuthLayout>
    );

  const sending = flow.busy === 'request';
  return (
    <AuthLayout
      title={t('auth.passwordReset.title')}
      subtitle={t('auth.passwordReset.subtitle')}
      announcement={flow.announcement}
    >
      <div className={styles.step}>
        <form className={styles.form} onSubmit={(event) => void send(event)} noValidate>
          <TextField
            label={t('auth.login.email')}
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              setEmailError(null);
            }}
            error={emailError}
            required
            autoFocus
          />
          <FlowProblems flow={flow} />
          <Button
            type="submit"
            variant="primary"
            size="xl"
            fullWidth
            loading={sending}
            disabled={flow.requestLimitLeft > 0}
          >
            {flow.requestLimitLeft > 0
              ? t('auth.emailLogin.sendCodeWait', { time: formatCountdown(flow.requestLimitLeft) })
              : sending
                ? t('auth.emailLogin.sending')
                : t('auth.emailLogin.sendCode')}
          </Button>
        </form>
        {back}
      </div>
    </AuthLayout>
  );
}

/** The address the login page handed over in the router state, if any. */
function stateEmail(state: unknown): string {
  if (typeof state !== 'object' || state === null || !('email' in state)) return '';
  return typeof state.email === 'string' ? state.email : '';
}
