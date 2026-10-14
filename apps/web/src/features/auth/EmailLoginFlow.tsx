import { useState } from 'react';
import { useNavigate } from 'react-router';
import { EMAIL_LOGIN_CODE_LENGTH } from '@projectman/shared';
import { t } from '../../i18n/t';
import { AuthLayout } from './AuthLayout';
import { CodeStep, NameStep } from './EmailCodeSteps';
import { EmailLoginForm } from './EmailLoginForm';
import { emailLoginTarget } from './emailLogin';
import { useEmailCodeFlow } from './useEmailCodeFlow';
import styles from './AuthLayout.module.css';

type Step = 'address' | 'code' | 'name';

/**
 * The login page with the e-mail code: address, code and, for a new account without a name, the name.
 * The step, the code and the name live in this component only: a reload starts over.
 */
export function EmailLoginFlow({
  email,
  onEmailChange,
  next,
  onUsePassword,
}: {
  email: string;
  onEmailChange: (value: string) => void;
  next: string | null;
  onUsePassword: () => void;
}) {
  const address = email.trim();
  const flow = useEmailCodeFlow({ email: address });
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('address');
  // The code that waits for a name: the server did not use it up.
  const [pendingCode, setPendingCode] = useState('');

  const check = async (code: string, name?: string) => {
    const outcome = await flow.verify(code, name);
    if (!outcome) return;
    if (outcome.kind === 'ok') navigate(emailLoginTarget(outcome.me, next), { replace: true });
    else if (outcome.kind === 'name_required') {
      setPendingCode(code);
      setStep('name');
    } else if (outcome.kind === 'invalid') setStep('code');
    else if (outcome.kind === 'no_access') setStep('address');
  };

  const heading =
    step === 'code'
      ? {
          title: t('auth.emailLogin.codeTitle'),
          subtitle: t('auth.emailLogin.codeSubtitle', {
            digits: EMAIL_LOGIN_CODE_LENGTH,
            minutes: flow.lifetimeMinutes,
          }),
        }
      : step === 'name'
        ? { title: t('auth.emailLogin.nameTitle'), subtitle: t('auth.emailLogin.nameSubtitle') }
        : { title: t('auth.login.title'), subtitle: t('auth.emailLogin.subtitle') };

  return (
    <AuthLayout title={heading.title} subtitle={heading.subtitle} announcement={flow.announcement}>
      <div key={step} className={styles.step}>
        {step === 'address' ? (
          <EmailLoginForm
            email={email}
            onEmailChange={onEmailChange}
            flow={flow}
            onSent={() => setStep('code')}
            onUsePassword={onUsePassword}
          />
        ) : step === 'code' ? (
          <CodeStep
            flow={flow}
            address={address}
            onOtherAddress={() => {
              flow.reset();
              setStep('address');
            }}
            onSubmit={(code) => void check(code)}
          />
        ) : (
          <NameStep flow={flow} onSubmit={(name) => void check(pendingCode, name)} />
        )}
      </div>
    </AuthLayout>
  );
}
