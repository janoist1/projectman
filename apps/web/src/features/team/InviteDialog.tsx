import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { holdersAllow } from '@projectman/shared';
import type { InviteAccess, MemberView } from '@projectman/shared';
import { useCreateInvite, useRoles } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Dialog, DialogActions } from '../../components/Dialog';
import { ErrorBanner } from '../../components/ErrorBanner';
import { ChoiceCard, TextField } from '../../components/Field';
import { ErrorState, LoadingState } from '../../components/States';
import { t } from '../../i18n/t';
import { humanRoleName } from '../../lib/roles';
import styles from '../invites/Invites.module.css';

export function InviteDialog({
  open,
  onClose,
  member,
}: {
  open: boolean;
  onClose: () => void;
  member?: MemberView;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={t('invites.title')}>
      <InviteForm key={member?.handle ?? 'new'} member={member} onClose={onClose} />
    </Dialog>
  );
}

/** The invitation form and, once created, its link. "Add colleague" shows it as one of its two ways. */
export function InviteForm({ member, onClose }: { member?: MemberView; onClose: () => void }) {
  const formId = useId();
  const { key, isOwner } = useProject();
  const roles = useRoles(key);
  const create = useCreateInvite(key);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [access, setAccess] = useState<InviteAccess>(member ? (member.role as InviteAccess) : 'developer');
  const [selected, setSelected] = useState<string[]>(member?.roles ?? []);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const levels: InviteAccess[] = isOwner
    ? ['admin', 'developer', 'client', 'viewer']
    : ['developer', 'client', 'viewer'];
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate({
      email: email.trim(),
      ...(member ? { memberHandle: member.handle } : {}),
      ...(name.trim() ? { displayName: name.trim() } : {}),
      access,
      roles: selected,
    });
  };
  const link = create.data ? `${window.location.origin}${create.data.path}` : '';

  if (create.data)
    return (
      <div className={styles.form}>
        <TextField
          label={t('invites.link')}
          value={link}
          readOnly
          onFocus={(event) => event.target.select()}
        />
        <p>{t('invites.lifetime')}</p>
        <DialogActions error={copyFailed ? <ErrorBanner>{t('invites.copyFailed')}</ErrorBanner> : null}>
          <Button size="md" onClick={onClose}>
            {t('common.close')}
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(link);
                setCopied(true);
                setCopyFailed(false);
              } catch {
                setCopyFailed(true);
              }
            }}
          >
            {copied ? t('invites.copied') : t('invites.copy')}
          </Button>
        </DialogActions>
      </div>
    );

  return (
    <form id={formId} className={styles.form} onSubmit={submit}>
      <TextField
        label={t('invites.email')}
        type="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        required
        autoFocus
      />
      {member ? null : (
        <TextField
          label={t('invites.name')}
          value={name}
          onChange={(event) => setName(event.target.value)}
          optional
        />
      )}
      <fieldset className={styles.choices}>
        <legend>{t('invites.access')}</legend>
        {levels.map((level) => (
          <ChoiceCard
            key={level}
            name="invite-access"
            value={level}
            checked={access === level}
            onChange={() => setAccess(level)}
            title={humanRoleName(level)}
            description={t(`invites.accessHint.${level}`)}
          />
        ))}
      </fieldset>
      {member ? null : (
        <fieldset className={styles.choices}>
          <legend>{t('invites.roles')}</legend>
          {roles.isPending ? (
            <LoadingState compact />
          ) : roles.isError ? (
            <ErrorState compact error={roles.error} onRetry={() => void roles.refetch()} />
          ) : (
            roles.data.roles
              .filter((role) => holdersAllow(role.holders, 'human'))
              .map((role) => (
                <label key={role.id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(role.id)}
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked ? [...current, role.id] : current.filter((id) => id !== role.id),
                      )
                    }
                  />{' '}
                  {role.name}
                </label>
              ))
          )}
        </fieldset>
      )}
      <DialogActions error={create.isError ? <ErrorState compact error={create.error} /> : null}>
        <Button size="md" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button
          variant="primary"
          size="md"
          type="submit"
          form={formId}
          loading={create.isPending}
          disabled={!roles.data}
        >
          {t('invites.create')}
        </Button>
      </DialogActions>
    </form>
  );
}
