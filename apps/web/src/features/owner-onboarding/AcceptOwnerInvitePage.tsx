import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { PublicOwnerInviteView } from '@projectman/shared';
import { isApiError } from '../../api/client';
import { useAcceptOwnerInvite, useMe, useOwnerInvite } from '../../api/queries';
import { Button } from '../../components/Button';
import { PasswordField, TextField } from '../../components/Field';
import { Icon } from '../../components/Icon';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { t } from '../../i18n/t';
import { useDocumentTitle } from '../../lib/hooks';
import { AuthLayout } from '../auth/AuthLayout';
import styles from './OwnerOnboarding.module.css';

/** The owner invitation (PM-1065): name and password, then straight to the first steps. */
export function AcceptOwnerInvitePage() {
  useDocumentTitle(t('ownerOnboarding.invite.title'));
  const { token = '' } = useParams();
  const invite = useOwnerInvite(token);
  if (invite.isPending) return <LoadingState />;
  if (invite.isError)
    return (
      <AuthLayout
        title={t('ownerOnboarding.invite.title')}
        subtitle={t('ownerOnboarding.invite.subtitleFallback')}
      >
        {isApiError(invite.error) && invite.error.code === 'invite_invalid' ? (
          <InvalidInvite />
        ) : (
          <ErrorState error={invite.error} onRetry={() => void invite.refetch()} />
        )}
      </AuthLayout>
    );
  return <AcceptForm key={token} token={token} invite={invite.data} />;
}

function InvalidInvite() {
  return (
    <EmptyState
      icon="lock"
      titleAs="h2"
      title={t('ownerOnboarding.invite.invalidTitle')}
      body={t('ownerOnboarding.invite.invalidBody')}
      action={<Link to="/login">{t('ownerOnboarding.invite.hasAccount')}</Link>}
    />
  );
}

function AcceptForm({ token, invite }: { token: string; invite: PublicOwnerInviteView }) {
  const me = useMe();
  const accept = useAcceptOwnerInvite(token);
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const loginRequired =
    (invite.requiresLogin && !me.data) ||
    (accept.isError && isApiError(accept.error) && accept.error.code === 'login_required');
  const loginPath = `/login?next=${encodeURIComponent(`/owner-invite/${token}`)}`;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    accept.mutate(invite.requiresLogin ? {} : { name: name.trim(), password }, {
      onSuccess: () => navigate('/welcome', { replace: true }),
    });
  };
  return (
    <AuthLayout
      title={t('ownerOnboarding.invite.title')}
      subtitle={t('ownerOnboarding.invite.subtitle', { name: invite.inviterName })}
    >
      <div className={styles.form}>
        <ul className={styles.facts}>
          {(['factProjects', 'factMachine', 'factPrivate'] as const).map((fact) => (
            <li key={fact}>
              <Icon name="check" size={16} strokeWidth={2.6} />
              <span>{t(`ownerOnboarding.invite.${fact}`)}</span>
            </li>
          ))}
        </ul>
        {accept.isError && isApiError(accept.error) && accept.error.code === 'invite_invalid' ? (
          <InvalidInvite />
        ) : me.isPending ? (
          <LoadingState compact />
        ) : loginRequired ? (
          <>
            <p>{t('ownerOnboarding.invite.loginRequired')}</p>
            <Link to={loginPath}>{t('ownerOnboarding.invite.login')}</Link>
          </>
        ) : (
          <form className={styles.form} onSubmit={submit}>
            {!invite.requiresLogin ? (
              <>
                <TextField
                  label={t('invites.name')}
                  hint={t('ownerOnboarding.invite.nameHint')}
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
              {t('ownerOnboarding.invite.accept')}
            </Button>
          </form>
        )}
      </div>
    </AuthLayout>
  );
}
