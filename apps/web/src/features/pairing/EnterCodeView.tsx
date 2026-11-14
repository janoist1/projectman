import { useEffect, useRef } from 'react';
import type { FormEvent } from 'react';
import { Button } from '../../components/Button';
import { ErrorBanner } from '../../components/ErrorBanner';
import { TextField } from '../../components/Field';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { formatCountdown } from '../auth/emailLogin';
import { formatTypedCode } from './pairingCode';
import authStyles from '../auth/AuthLayout.module.css';
import styles from './Pairing.module.css';

/**
 * The code step (states 1–3): one field, the focus on it. A wrong code keeps the focus on the field with the text
 * selected, to type over it; a wait after too many wrong codes disables the button and shows what is left.
 */
export function EnterCodeView({
  value,
  onChange,
  onSubmit,
  invalid,
  failure,
  limitLeft,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Called with whatever is in the field; the page checks its shape. */
  onSubmit: () => void;
  invalid: boolean;
  /** A lookup that failed for another reason (network, server): shown above the button, the code stays. */
  failure: unknown;
  /** Seconds of the wait that is still running; 0 when none. */
  limitLeft: number;
}) {
  const input = useRef<HTMLInputElement>(null);
  const waited = useRef(false);

  useEffect(() => {
    input.current?.focus();
    if (invalid) input.current?.select();
    // A mount and a new wrong code only; typing must not pull the selection back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!invalid) return;
    input.current?.focus();
    input.current?.select();
  }, [invalid]);
  // When the wait ends the field gets the focus back (the button was disabled).
  useEffect(() => {
    if (limitLeft > 0) waited.current = true;
    else if (waited.current) {
      waited.current = false;
      input.current?.focus();
    }
  }, [limitLeft]);

  const limited = limitLeft > 0;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!limited) onSubmit();
  };
  return (
    <form className={authStyles.form} onSubmit={submit} noValidate>
      <TextField
        ref={input}
        label={t('pairing.enter.label')}
        hint={t('pairing.enter.hint')}
        className={styles.codeField}
        value={value}
        onChange={(event) => onChange(formatTypedCode(event.target.value))}
        maxLength={32}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        error={invalid ? t('pairing.enter.invalid') : null}
      />
      {limited ? (
        <ErrorBanner silent>{t('pairing.enter.tooMany', { time: formatCountdown(limitLeft) })}</ErrorBanner>
      ) : null}
      {failure ? <ErrorBanner>{errorMessage(failure)}</ErrorBanner> : null}
      <Button
        type="submit"
        variant="primary"
        size="xl"
        fullWidth
        className={styles.action}
        disabled={limited}
      >
        {limited ? t('pairing.enter.wait', { time: formatCountdown(limitLeft) }) : t('pairing.enter.submit')}
      </Button>
    </form>
  );
}
