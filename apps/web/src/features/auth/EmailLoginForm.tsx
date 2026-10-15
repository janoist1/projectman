import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Button } from '../../components/Button';
import { TextField } from '../../components/Field';
import { t } from '../../i18n/t';
import { FlowProblems } from './EmailCodeSteps';
import { formatCountdown } from './emailLogin';
import type { EmailCodeFlow } from './useEmailCodeFlow';
import styles from './AuthLayout.module.css';

/** The address step: the address, and a code on its way. Nothing tells whether the address is known. */
export function EmailLoginForm({
  email,
  onEmailChange,
  flow,
  onSent,
  onUsePassword,
}: {
  email: string;
  onEmailChange: (value: string) => void;
  flow: EmailCodeFlow;
  onSent: () => void;
  onUsePassword: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  // A step back with an address in the field selects it, to type over.
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
      setError(t('auth.validation.emailInvalid'));
      input.current?.focus();
      return;
    }
    setError(null);
    const outcome = await flow.request();
    if (outcome === 'sent') onSent();
    else if (outcome === 'invalid_address') {
      setError(t('auth.validation.emailInvalid'));
      input.current?.focus();
    }
  };

  const sending = flow.busy === 'request';
  return (
    <>
      <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
        <TextField
          ref={input}
          label={t('auth.login.email')}
          type="email"
          inputMode="email"
          autoComplete="username"
          value={email}
          onChange={(event) => {
            onEmailChange(event.target.value);
            setError(null);
          }}
          error={error}
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
      <div className={styles.alt}>
        {t('auth.emailLogin.hasPassword')}
        <button type="button" className={styles.linkButton} onClick={onUsePassword}>
          {t('auth.emailLogin.usePassword')}
        </button>
      </div>
    </>
  );
}
