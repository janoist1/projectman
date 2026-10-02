import { useState } from 'react';
import type { FormEvent } from 'react';
import { CustomRoleRequest, dutyHolders } from '@projectman/shared';
import type { ProjectConfig, RoleHolders, RoleView } from '@projectman/shared';
import { useDeleteRole, useRoles, useSaveRole } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Chip } from '../../components/Chip';
import { Dialog } from '../../components/Dialog';
import { TextAreaField, TextField } from '../../components/Field';
import { ErrorState, LoadingState } from '../../components/States';
import { ErrorBanner } from '../../components/ErrorBanner';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { roleView } from '../../lib/roles';
import styles from './RoleSection.module.css';
import formStyles from './memberForm.module.css';

export function RoleForm({
  role,
  instructions = '',
  onDone,
}: {
  role?: RoleView;
  instructions?: string;
  onDone: () => void;
}) {
  const { key } = useProject();
  const save = useSaveRole(key);
  const toast = useToast();
  const [draft, setDraft] = useState({
    id: role?.id ?? '',
    name: role?.name ?? '',
    summary: role?.summary ?? '',
    notTheirJob: role?.notTheirJob ?? '',
    whenToAsk: role?.whenToAsk ?? '',
    holders: role?.holders ?? ('both' as RoleHolders),
    duties: role?.duties ?? [],
    instructions,
  });
  const [invalid, setInvalid] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = CustomRoleRequest.safeParse(draft);
    if (!input.success) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    save.mutate(
      { id: role?.id, body: input.data },
      {
        onSuccess: () => {
          toast.show(t('roleCatalogue.saved'));
          onDone();
        },
      },
    );
  };
  return (
    <form className={formStyles.form} onSubmit={submit}>
      <TextField
        label={t('roleCatalogue.id')}
        required
        readOnly={Boolean(role)}
        value={draft.id}
        onChange={(event) => setDraft({ ...draft, id: event.target.value })}
      />
      <TextField
        label={t('roleCatalogue.name')}
        required
        maxLength={60}
        value={draft.name}
        onChange={(event) => setDraft({ ...draft, name: event.target.value })}
      />
      <TextAreaField
        label={t('roleCatalogue.summary')}
        required
        maxLength={280}
        value={draft.summary}
        onChange={(event) => setDraft({ ...draft, summary: event.target.value })}
      />
      <TextAreaField
        label={t('roleCatalogue.notTheirJob')}
        maxLength={200}
        value={draft.notTheirJob}
        onChange={(event) => setDraft({ ...draft, notTheirJob: event.target.value })}
      />
      <TextAreaField
        label={t('roleCatalogue.whenToAsk')}
        maxLength={280}
        value={draft.whenToAsk}
        onChange={(event) => setDraft({ ...draft, whenToAsk: event.target.value })}
      />
      <p>
        {t('roleCatalogue.holders')}: {t(`roleCatalogue.${dutyHolders(draft.duties) ?? 'both'}`)}
      </p>
      <TextAreaField
        label={t('roleCatalogue.instructions')}
        value={draft.instructions}
        onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
      />
      {invalid ? <p role="alert">{t('roleCatalogue.invalid')}</p> : null}
      {save.isError ? <ErrorBanner>{errorMessage(save.error)}</ErrorBanner> : null}
      <div className={formStyles.actions}>
        <Button type="submit" variant="primary" loading={save.isPending}>
          {t('memberEdit.save')}
        </Button>
        <Button type="button" variant="secondary" onClick={onDone}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

export function RoleSection({ config }: { config?: ProjectConfig }) {
  const { key, can } = useProject();
  const roles = useRoles(key);
  const remove = useDeleteRole(key);
  const toast = useToast();
  const [editing, setEditing] = useState<RoleView | 'new' | null>(null);
  const [deleting, setDeleting] = useState<RoleView | null>(null);
  return (
    <>
      <details className={styles.section}>
        <summary className={styles.summary}>
          <h2>{t('roleCatalogue.title')}</h2>
          {roles.data ? <span className={styles.count}>{roles.data.roles.length}</span> : null}
        </summary>
        {can.manageTeam ? (
          <div className={styles.header}>
            <Button variant="secondary" onClick={() => setEditing('new')}>
              {t('roleCatalogue.create')}
            </Button>
          </div>
        ) : null}
        {roles.isPending ? (
          <LoadingState compact />
        ) : roles.isError ? (
          <ErrorState error={roles.error} onRetry={() => void roles.refetch()} />
        ) : (
          <ul className={styles.list}>
            {roles.data.roles.map((role) => {
              const view = roleView(role);
              return (
                <li key={role.id} className={styles.role}>
                  <div className={styles.header}>
                    <Chip icon={view.icon}>{view.name}</Chip>
                    <code>{role.id}</code>
                    {role.builtIn ? <Chip>{t('roleCatalogue.builtin')}</Chip> : null}
                    <Chip>{t(`roleCatalogue.${role.holders}`)}</Chip>
                  </div>
                  <p>{view.summary}</p>
                  <p className={styles.muted}>
                    {t('roleCatalogue.notTheirJob')}: {view.notTheirJob}
                  </p>
                  {view.whenToAsk ? (
                    <p className={styles.muted}>
                      {t('roleCatalogue.whenToAsk')}: {view.whenToAsk}
                    </p>
                  ) : null}
                  {!role.builtIn && can.manageTeam ? (
                    <div className={formStyles.actions}>
                      <Button size="sm" variant="ghost" disabled={!config} onClick={() => setEditing(role)}>
                        {t('memberEdit.edit')}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => {
                          remove.reset();
                          setDeleting(role);
                        }}
                      >
                        {t('roleCatalogue.delete')}
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </details>
      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? t('roleCatalogue.create') : t('roleCatalogue.edit')}
      >
        {editing ? (
          <RoleForm
            role={editing === 'new' ? undefined : editing}
            instructions={
              editing === 'new' ? '' : config?.team.roles.find((role) => role.id === editing.id)?.instructions
            }
            onDone={() => setEditing(null)}
          />
        ) : null}
      </Dialog>
      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={t('roleCatalogue.deleteTitle', { name: deleting?.name ?? '' })}
      >
        <div className={formStyles.form}>
          <p>{t('roleCatalogue.deleteConfirm')}</p>
          {remove.isError ? <ErrorBanner>{errorMessage(remove.error)}</ErrorBanner> : null}
          <Button
            variant="dangerSolid"
            loading={remove.isPending}
            onClick={() =>
              deleting &&
              remove.mutate(deleting.id, {
                onSuccess: () => {
                  setDeleting(null);
                  toast.show(t('roleCatalogue.deleted'));
                },
              })
            }
          >
            {t('roleCatalogue.delete')}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
