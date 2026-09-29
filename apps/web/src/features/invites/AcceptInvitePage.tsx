import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { PublicInviteView } from '@projectman/shared';
import { isApiError } from '../../api/client';
import { useAcceptInvite, useInvite, useMe } from '../../api/queries';
import { Button } from '../../components/Button';
import { PasswordField, TextField } from '../../components/Field';
import { ErrorState, LoadingState } from '../../components/States';
import { t } from '../../i18n/t';
import { humanRoleName } from '../../lib/roles';
import { AuthLayout } from '../auth/AuthLayout';
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
  const accept = useAcceptInvite(token);
  const navigate = useNavigate();
  const [name, setName] = useState(invite.displayName ?? '');
  const [password, setPassword] = useState('');
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
        <p>
          <strong>{humanRoleName(invite.access)}</strong> · {t(`invites.accessHint.${invite.access}`)}
        </p>
        {invite.roleNames.length > 0 ? (
          <p>
            {t('invites.roles')}: {invite.roleNames.join(t('common.listSeparator'))}
          </p>
        ) : null}
        <p>{t('invites.expires', { date: new Date(invite.expiresAt).toLocaleString('hu-HU') })}</p>
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
