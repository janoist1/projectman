import { useState } from 'react';
import type { FormEvent } from 'react';
import { holdersAllow, InviteAccess } from '@projectman/shared';
import { useAddHumanMember, useRoles } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { SelectField, TextField } from '../../components/Field';
import { SegmentedControl } from '../../components/SegmentedControl';
import { ErrorState, LoadingState } from '../../components/States';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { humanRoleName } from '../../lib/roles';
import { InviteForm } from './InviteDialog';
import styles from './memberForm.module.css';

type AddMode = 'direct' | 'invite';

/** "Kolléga hozzáadása": a member without an account, or an invitation link for one. */
export function AddHumanDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [mode, setMode] = useState<AddMode>('direct');
  return (
    <Dialog open={open} onClose={onClose} title={t('addHuman.title')}>
      <div className={styles.form}>
        <SegmentedControl<AddMode>
          label={t('addHuman.modeLabel')}
          value={mode}
          onChange={setMode}
          options={[
            { value: 'direct', label: t('addHuman.modeDirect') },
            { value: 'invite', label: t('addHuman.modeInvite') },
          ]}
        />
        {mode === 'direct' ? <AddHumanForm onDone={onClose} /> : <InviteForm />}
      </div>
    </Dialog>
  );
}

function AddHumanForm({ onDone }: { onDone: () => void }) {
  const { key, isOwner } = useProject();
  const roles = useRoles(key);
  const add = useAddHumanMember(key);
  const toast = useToast();
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [access, setAccess] = useState<InviteAccess>('developer');
  const [selected, setSelected] = useState<string[]>([]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    add.mutate(
      {
        displayName: name.trim(),
        ...(handle.trim() ? { handle: handle.trim() } : {}),
        access,
        roles: selected,
      },
      {
        onSuccess: () => {
          toast.show(t('addHuman.added', { name: name.trim() }));
          onDone();
        },
      },
    );
  };
  return (
    <form className={styles.form} onSubmit={submit}>
      <TextField
        label={t('hire.displayName')}
        required
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <TextField
        label={t('hire.handle')}
        optional
        value={handle}
        pattern="[a-z0-9][a-z0-9-]{0,31}"
        onChange={(event) => setHandle(event.target.value)}
      />
      <SelectField
        label={t('invites.access')}
        value={access}
        onChange={(event) => setAccess(InviteAccess.parse(event.target.value))}
      >
        {InviteAccess.options
          .filter((level) => isOwner || level !== 'admin')
          .map((level) => (
            <option key={level} value={level}>
              {humanRoleName(level)}
            </option>
          ))}
      </SelectField>
      <fieldset className={styles.schedule}>
        <legend>{t('invites.roles')}</legend>
        {roles.isPending ? (
          <LoadingState compact />
        ) : roles.isError ? (
          <ErrorState compact error={roles.error} />
        ) : (
          roles.data.roles
            .filter((role) => holdersAllow(role.holders, 'human'))
            .map((role) => (
              <label key={role.id} className={styles.toggle}>
                <input
                  type="checkbox"
                  checked={selected.includes(role.id)}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked ? [...current, role.id] : current.filter((id) => id !== role.id),
                    )
                  }
                />
                {role.name}
              </label>
            ))
        )}
      </fieldset>
      {add.isError ? <ErrorState compact error={add.error} /> : null}
      <Button variant="primary" type="submit" loading={add.isPending} disabled={!roles.data}>
        {t('addHuman.submit')}
      </Button>
    </form>
  );
}
