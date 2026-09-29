import { useState } from 'react';
import type { FormEvent } from 'react';
import { holdersAllow } from '@projectman/shared';
import type { AgentProvider, AgentEffort, MemberView, ProjectConfig, RoleView } from '@projectman/shared';
import { useUpdateMember } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { TextField } from '../../components/Field';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { ProviderFields } from './ProviderFields';
import { ScheduleFields } from './ScheduleFields';
import type { ScheduleDraft } from './ScheduleFields';
import styles from './HireDialog.module.css';

function EditMemberForm({
  member,
  config,
  roles,
  onDone,
}: {
  member: MemberView;
  config?: ProjectConfig;
  roles: readonly RoleView[];
  onDone: () => void;
}) {
  const { key } = useProject();
  const update = useUpdateMember(key);
  const toast = useToast();
  const original = config?.team.members.find((entry) => entry.handle === member.handle);
  const ai = original?.kind === 'ai' ? original : undefined;
  const [displayName, setDisplayName] = useState(member.displayName);
  const [selected, setSelected] = useState(member.roles);
  const [specialty, setSpecialty] = useState(member.specialty ?? '');
  const [provider, setProvider] = useState<AgentProvider>(ai?.provider ?? member.provider ?? 'claude');
  const [effort, setEffort] = useState<AgentEffort>(ai?.effort ?? member.effort ?? 'medium');
  const [model, setModel] = useState(
    ai?.model ?? member.model ?? (provider === 'codex' ? 'gpt-6.1-sol' : 'opus'),
  );
  const [schedule, setSchedule] = useState<ScheduleDraft>({
    enabled: Boolean(ai?.schedule),
    cron: ai?.schedule?.cron ?? '',
    prompt: ai?.schedule?.prompt ?? '',
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (member.kind === 'ai' && !model.trim()) return;
    update.mutate(
      {
        handle: member.handle,
        body:
          member.kind === 'human'
            ? { displayName: displayName.trim(), roles: selected }
            : {
                displayName: displayName.trim(),
                specialty: specialty.trim(),
                provider,
                effort: provider === 'codex' ? effort : undefined,
                model: model.trim(),
                schedule: schedule.enabled
                  ? { cron: schedule.cron.trim(), prompt: schedule.prompt.trim() }
                  : null,
              },
      },
      {
        onSuccess: () => {
          toast.show(t('memberEdit.saved'));
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
        value={displayName}
        onChange={(event) => setDisplayName(event.target.value)}
      />
      {member.kind === 'human' ? (
        <fieldset className={styles.schedule}>
          <legend>{t('memberEdit.roles')}</legend>
          {roles
            .filter((role) => holdersAllow(role.holders, 'human'))
            .map((role) => (
              <label key={role.id} className={styles.toggle}>
                <input
                  type="checkbox"
                  checked={selected.includes(role.id)}
                  onChange={(event) =>
                    setSelected(
                      event.target.checked ? [...selected, role.id] : selected.filter((id) => id !== role.id),
                    )
                  }
                />
                {role.name}
              </label>
            ))}
        </fieldset>
      ) : (
        <>
          <TextField
            label={t('hire.specialty')}
            value={specialty}
            onChange={(event) => setSpecialty(event.target.value)}
          />
          <ProviderFields
            provider={provider}
            model={model}
            effort={effort}
            onProviderChange={(next, nextModel) => {
              setProvider(next);
              setModel(nextModel);
            }}
            onModelChange={setModel}
            onEffortChange={setEffort}
          />
          <ScheduleFields value={schedule} onChange={setSchedule} />
        </>
      )}
      {update.isError ? (
        <p className={styles.error} role="alert">
          {errorMessage(update.error)}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button type="submit" variant="primary" loading={update.isPending}>
          {t('memberEdit.save')}
        </Button>
        <Button type="button" variant="secondary" onClick={onDone}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

export function EditMemberDialog({
  member,
  config,
  roles,
  onClose,
}: {
  member: MemberView | null;
  config?: ProjectConfig;
  roles: readonly RoleView[];
  onClose: () => void;
}) {
  return (
    <Dialog
      open={Boolean(member)}
      onClose={onClose}
      title={t('memberEdit.title', { name: member?.displayName ?? '' })}
    >
      {member ? (
        <EditMemberForm key={member.handle} member={member} config={config} roles={roles} onDone={onClose} />
      ) : null}
    </Dialog>
  );
}
