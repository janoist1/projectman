import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { EMAIL_LOGIN_CODE_LENGTH } from '@projectman/shared';
import { Button } from '../../components/Button';
import { ErrorBanner } from '../../components/ErrorBanner';
import { TextField } from '../../components/Field';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { formatCountdown, isLoginCode, normalizeLoginCode } from './emailLogin';
import type { EmailCodeFlow } from './useEmailCodeFlow';
import styles from './AuthLayout.module.css';

/** Room for `123 456` or `123-456` with spaces around. */
const CODE_INPUT_LENGTH = 12;

/** The problems of a request or a check that have a banner of their own; each reads the same for every address. */
export function FlowProblems({ flow }: { flow: EmailCodeFlow }) {
  const limited = flow.requestLimitLeft > 0 || flow.verifyLimitLeft > 0;
  return (
    <>
      {limited ? <ErrorBanner>{t('auth.emailLogin.tooMany')}</ErrorBanner> : null}
      {flow.unavailable ? <ErrorBanner>{t('auth.emailLogin.unavailable')}</ErrorBanner> : null}
      {flow.failure ? <ErrorBanner>{errorMessage(flow.failure)}</ErrorBanner> : null}
    </>
  );
}

/** The code step: the address, the code field, the check and the new-code request. */
export function CodeStep({
  flow,
  address,
  onOtherAddress,
  onSubmit,
}: {
  flow: EmailCodeFlow;
  address: string;
  /** Absent when the address is not the person's to change (an invitation's). */
  onOtherAddress?: () => void;
  /** Called with a code that has the right shape; the page sends it. */
  onSubmit: (code: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState('');
  const [malformed, setMalformed] = useState(false);

  useEffect(() => input.current?.focus(), []);
  // A wrong code keeps the focus on the field with the text selected, to type over it.
  useEffect(() => {
    if (!flow.codeInvalid) return;
    input.current?.focus();
    input.current?.select();
  }, [flow.codeInvalid]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizeLoginCode(code);
    if (!isLoginCode(normalized)) {
      setMalformed(true);
      input.current?.focus();
      input.current?.select();
      return;
    }
    setMalformed(false);
    onSubmit(normalized);
  };

  const resend = async () => {
    if ((await flow.request(true)) !== 'sent') return;
    setCode('');
    setMalformed(false);
    input.current?.focus();
  };

  const error = malformed
    ? t('auth.emailLogin.codeFormat', { digits: EMAIL_LOGIN_CODE_LENGTH })
    : flow.codeInvalid
      ? t('auth.emailLogin.codeInvalid')
      : null;
  const verifying = flow.busy === 'verify';
  const resendBlocked = flow.busy !== null || flow.requestLimitLeft > 0;
  const waiting = flow.resendLeft > 0;

  return (
    <>
      {address || onOtherAddress ? (
        <div className={styles.address}>
          <span>
            <span className="visually-hidden">{t('auth.emailLogin.address')} </span>
            <strong>{address}</strong>
          </span>
          {onOtherAddress ? (
            <button type="button" className={styles.linkButton} onClick={onOtherAddress}>
              {t('auth.emailLogin.otherAddress')}
            </button>
          ) : null}
        </div>
      ) : null}
      <form className={styles.form} onSubmit={submit} noValidate>
        <TextField
          ref={input}
          label={t('auth.emailLogin.codeLabel')}
          className={styles.codeInput}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={CODE_INPUT_LENGTH}
          placeholder="••••••"
          value={code}
          onChange={(event) => {
            setCode(event.target.value.replace(/[^\d\s-]/g, ''));
            setMalformed(false);
          }}
          error={error}
        />
        {flow.resent ? <p className={styles.notice}>{t('auth.emailLogin.resent')}</p> : null}
        <FlowProblems flow={flow} />
        <Button
          type="submit"
          variant="primary"
          size="xl"
          fullWidth
          loading={verifying}
          disabled={flow.verifyLimitLeft > 0}
        >
          {flow.verifyLimitLeft > 0
            ? t('auth.emailLogin.verifyWait', { time: formatCountdown(flow.verifyLimitLeft) })
            : verifying
              ? t('auth.emailLogin.verifying')
              : t('auth.emailLogin.verify')}
        </Button>
      </form>
      <div className={styles.resend}>
        {waiting ? (
          <>
            <span aria-hidden="true">
              {t('auth.emailLogin.resendWait', {
                time: formatCountdown(flow.resendLeft),
              })}
            </span>
            <span className="visually-hidden">{t('auth.emailLogin.resendWaitSr')}</span>
            <span className={styles.resendHint}>{t('auth.emailLogin.spamHint')}</span>
          </>
        ) : flow.codeInvalid ? (
          <Button
            variant="secondary"
            size="lg"
            fullWidth
            disabled={resendBlocked}
            onClick={() => void resend()}
          >
            {t('auth.emailLogin.resend')}
          </Button>
        ) : (
          <span>
            {t('auth.emailLogin.resendAsk')}{' '}
            <button
              type="button"
              className={styles.linkButton}
              disabled={resendBlocked}
              onClick={() => void resend()}
            >
              {t('auth.emailLogin.resend')}
            </button>
          </span>
        )}
      </div>
    </>
  );
}

/** The name step of a new account: the same code goes again, with the name. */
export function NameStep({
  flow,
  initialName = '',
  onSubmit,
}: {
  flow: EmailCodeFlow;
  initialName?: string;
  onSubmit: (name: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => input.current?.focus(), []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError(t('auth.validation.nameRequired'));
      input.current?.focus();
      return;
    }
    setError(null);
    onSubmit(name.trim());
  };

  const verifying = flow.busy === 'verify';
  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <TextField
        ref={input}
        label={t('auth.emailLogin.nameLabel')}
        autoComplete="name"
        maxLength={100}
        value={name}
        onChange={(event) => {
          setName(event.target.value);
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
        loading={verifying}
        disabled={flow.verifyLimitLeft > 0}
      >
        {flow.verifyLimitLeft > 0
          ? t('auth.emailLogin.verifyWait', { time: formatCountdown(flow.verifyLimitLeft) })
          : verifying
            ? t('auth.login.submitting')
            : t('auth.login.submit')}
      </Button>
    </form>
  );
}
