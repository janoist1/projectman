import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { EMAIL_LOGIN_CODE_LENGTH } from '@projectman/shared';
import type { PublicInviteView } from '@projectman/shared';
import { queryKeys } from '../../api/queryKeys';
import { Button } from '../../components/Button';
import { TextField } from '../../components/Field';
import { t } from '../../i18n/t';
import { AuthLayout } from '../auth/AuthLayout';
import authStyles from '../auth/AuthLayout.module.css';
import { CodeStep, FlowProblems } from '../auth/EmailCodeSteps';
import { emailLoginTarget, formatCountdown } from '../auth/emailLogin';
import { useEmailCodeFlow } from '../auth/useEmailCodeFlow';
import { InviteFacts } from './InviteFacts';
import styles from './Invites.module.css';

/**
 * Accepts a client invitation with an e-mail code instead of a password: a new client names themselves
 * and gets the code, an existing one only gets the code. The code goes to the invited address, which the
 * page never sees whole. The name and the code live in this component only.
 */
export function InviteCodeAccept({ token, invite }: { token: string; invite: PublicInviteView }) {
  const flow = useEmailCodeFlow({ inviteToken: token });
  const client = useQueryClient();
  const navigate = useNavigate();
  const nameInput = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<'start' | 'code'>('start');
  const [name, setName] = useState(invite.displayName ?? '');
  const [nameError, setNameError] = useState<string | null>(null);
  const isNewClient = !invite.requiresLogin;
  const loginPath = `/login?next=${encodeURIComponent(`/invite/${token}`)}`;

  useEffect(() => nameInput.current?.focus(), []);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (isNewClient && !name.trim()) {
      setNameError(t('auth.validation.nameRequired'));
      nameInput.current?.focus();
      return;
    }
    setNameError(null);
    if ((await flow.request()) === 'sent') setStep('code');
  };

  const check = async (code: string) => {
    const outcome = await flow.verify(code, isNewClient ? name.trim() : undefined);
    if (!outcome) return;
    if (outcome.kind === 'ok')
      navigate(emailLoginTarget(outcome.me, null, invite.projectKey), { replace: true });
    // The invitation may have stopped being valid meanwhile: ask again, the page shows what it finds.
    else if (outcome.kind === 'invalid' || outcome.kind === 'no_access')
      void client.invalidateQueries({ queryKey: queryKeys.invite(token) });
  };

  if (step === 'code')
    return (
      <AuthLayout
        title={t('auth.emailLogin.codeTitle')}
        subtitle={t('invites.codeSentInvite', {
          digits: EMAIL_LOGIN_CODE_LENGTH,
          minutes: flow.lifetimeMinutes,
        })}
        announcement={flow.announcement}
      >
        <div className={authStyles.step}>
          <CodeStep flow={flow} address={invite.emailHint ?? ''} onSubmit={(code) => void check(code)} />
        </div>
      </AuthLayout>
    );

  const sending = flow.busy === 'request';
  return (
    <AuthLayout
      title={t('invites.acceptTitle')}
      subtitle={t('invites.offered', { name: invite.inviterName, project: invite.projectName })}
      announcement={flow.announcement}
    >
      <div className={styles.form}>
        <InviteFacts invite={invite} />
        <form className={styles.form} onSubmit={(event) => void send(event)} noValidate>
          {isNewClient ? (
            <TextField
              ref={nameInput}
              label={t('auth.emailLogin.nameLabel')}
              hint={t('invites.nameHint')}
              value={name}
              maxLength={100}
              onChange={(event) => {
                setName(event.target.value);
                setNameError(null);
              }}
              error={nameError}
              autoComplete="name"
            />
          ) : null}
          <p>
            {invite.emailHint
              ? t('invites.codeIntro', { hint: invite.emailHint })
              : t('invites.codeIntroNoHint')}
          </p>
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
        {!isNewClient ? (
          <div className={authStyles.alt}>
            {t('auth.emailLogin.hasPassword')}{' '}
            <Link to={loginPath} className={authStyles.linkButton}>
              {t('auth.emailLogin.usePassword')}
            </Link>
          </div>
        ) : null}
      </div>
    </AuthLayout>
  );
}
