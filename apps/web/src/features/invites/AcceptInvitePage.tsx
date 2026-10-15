import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { PublicInviteView } from '@projectman/shared';
import { isApiError } from '../../api/client';
import { useAcceptInvite, useInvite, useMe, useSetupStatus } from '../../api/queries';
import { Button } from '../../components/Button';
import { PasswordField, TextField } from '../../components/Field';
import { ErrorState, LoadingState } from '../../components/States';
import { t } from '../../i18n/t';
import { AuthLayout } from '../auth/AuthLayout';
import { InviteCodeAccept } from './InviteCodeAccept';
import { InviteFacts } from './InviteFacts';
import styles from './Invites.module.css';

export function AcceptInvitePage() {
  const { token = '' } = useParams();
  const invite = useInvite(token);
  if (invite.isPending) return <LoadingState />;
  if (invite.isError)
    return (
      <AuthLayout title={t('invites.acceptTitle')} subtitle={t('invites.acceptSubtitle')}>
        {isApiError(invite.error) && invite.error.code === 'invite_invalid' ? (
          <p>{t('invites.invalid')}</p>
        ) : (
          <ErrorState error={invite.error} onRetry={() => void invite.refetch()} />
        )}
      </AuthLayout>
    );
  return <AcceptForm key={token} token={token} invite={invite.data} />;
}

function AcceptForm({ token, invite }: { token: string; invite: PublicInviteView }) {
  const me = useMe();
  const status = useSetupStatus();
  const accept = useAcceptInvite(token);
  const navigate = useNavigate();
  const [name, setName] = useState(invite.displayName ?? '');
  const [password, setPassword] = useState('');
  // A client who is not logged in accepts with an e-mail code when the server has that login.
  const codeCandidate = invite.access === 'client' && !me.isPending && !me.data;
  if (codeCandidate && status.isPending) return <LoadingState />;
  if (codeCandidate && status.data?.emailLoginEnabled === true)
    return <InviteCodeAccept token={token} invite={invite} />;
  const loginRequired =
    (invite.requiresLogin && !me.data) ||
    (accept.isError && isApiError(accept.error) && accept.error.code === 'login_required');
  const loginPath = `/login?next=${encodeURIComponent(`/invite/${token}`)}`;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    accept.mutate(invite.requiresLogin ? {} : { name: name.trim(), password }, {
      onSuccess: () => navigate(`/p/${invite.projectKey}`, { replace: true }),
    });
  };
  return (
    <AuthLayout
      title={t('invites.acceptTitle')}
      subtitle={t('invites.offered', { name: invite.inviterName, project: invite.projectName })}
    >
      <div className={styles.form}>
        <InviteFacts invite={invite} />
        {accept.isError && isApiError(accept.error) && accept.error.code === 'invite_invalid' ? (
          <p>{t('invites.invalid')}</p>
        ) : me.isPending ? (
          <LoadingState compact />
        ) : loginRequired ? (
          <>
            <p>{t('invites.loginRequired')}</p>
            <Link to={loginPath}>{t('invites.login')}</Link>
          </>
        ) : (
          <form className={styles.form} onSubmit={submit}>
            {!invite.requiresLogin ? (
              <>
                <TextField
                  label={t('invites.name')}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  autoComplete="name"
                />
                <PasswordField
                  label={t('invites.password')}
                  hint={t('invites.passwordHint')}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  minLength={8}
                  required
                  autoComplete="new-password"
                />
                <Link to={loginPath}>{t('invites.existing')}</Link>
              </>
            ) : null}
            {accept.isError ? <ErrorState compact error={accept.error} /> : null}
            <Button type="submit" variant="primary" loading={accept.isPending}>
              {t('invites.accept')}
            </Button>
          </form>
        )}
      </div>
    </AuthLayout>
  );
}
