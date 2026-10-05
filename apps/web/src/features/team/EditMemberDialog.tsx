import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  DEFAULT_AGENT_PROVIDER,
  effortForProvider,
  DEFAULT_PROVIDER_MODELS,
  holdersAllow,
  HumanAccess,
} from '@projectman/shared';
import type {
  AgentProvider,
  AgentEffort,
  CheapSubagentModel,
  MemberView,
  ProjectConfig,
  RoleView,
} from '@projectman/shared';
import { useUpdateMember } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { SelectField, TextAreaField, TextField } from '../../components/Field';
import { useToast } from '../../components/toastContext';
import { humanRoleName } from '../../lib/roles';
import { ErrorBanner } from '../../components/ErrorBanner';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { focusFirstInvalid } from '../../lib/focus';
import { PermissionLevelControl } from './PermissionLevelControl';
import { ProviderFields } from './ProviderFields';
import { ScheduleFields } from './ScheduleFields';
import type { ScheduleDraft } from './ScheduleFields';
import styles from './memberForm.module.css';

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
  const { members } = useProjectIndexes(key);
  const update = useUpdateMember(key);
  const toast = useToast();
  const original = config?.team.members.find((entry) => entry.handle === member.handle);
  const ai = original?.kind === 'ai' ? original : undefined;
  const [displayName, setDisplayName] = useState(member.displayName);
  const [access, setAccess] = useState(member.role);
  const [selected, setSelected] = useState(member.roles);
  const [specialty, setSpecialty] = useState(member.specialty ?? '');
  const [provider, setProvider] = useState<AgentProvider>(
    ai?.provider ?? member.provider ?? DEFAULT_AGENT_PROVIDER,
  );
  const [effort, setEffort] = useState<AgentEffort | undefined>(
    effortForProvider(provider, ai?.effort ?? member.effort),
  );
  const [cheapSubagent, setCheapSubagent] = useState<CheapSubagentModel | undefined>(
    ai?.cheapSubagent ?? member.cheapSubagent,
  );
  // Empty: the project's value (a string, so a half-typed number stays as typed).
  const [compactWindow, setCompactWindow] = useState(
    String(ai?.autoCompactWindowTokens ?? member.autoCompactWindowTokens ?? ''),
  );
  // The Senior (PM-347) is an AI member that is no stand-in; the choice is the form's own, saved with it.
  const canBeSenior = member.kind === 'ai' && !member.temp;
  const [senior, setSenior] = useState(member.senior === true);
  const [model, setModel] = useState(ai?.model ?? member.model ?? DEFAULT_PROVIDER_MODELS[provider]);
  const [instructions, setInstructions] = useState(ai?.instructions ?? '');
  const [schedule, setSchedule] = useState<ScheduleDraft>({
    enabled: Boolean(ai?.schedule),
    cron: ai?.schedule?.cron ?? '',
    prompt: ai?.schedule?.prompt ?? '',
  });
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [scheduleError, setScheduleError] = useState(false);
  // Counts refused saves: each one moves focus to the first field marked invalid.
  const [refused, setRefused] = useState(0);
  useEffect(() => {
    if (refused) focusFirstInvalid(formRef.current);
  }, [refused]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (member.kind === 'ai' && !model.trim()) return;
    if (member.kind === 'ai' && schedule.enabled && (!schedule.cron.trim() || !schedule.prompt.trim())) {
      setScheduleError(true);
      setRefused((count) => count + 1);
      return;
    }
    setScheduleError(false);
    update.mutate(
      {
        handle: member.handle,
        body:
          member.kind === 'human'
            ? { displayName: displayName.trim(), roles: selected, access: HumanAccess.parse(access) }
            : {
                displayName: displayName.trim(),
                specialty: specialty.trim(),
                // Sent only when it changes: a stand-in has none, and the server refuses it for one.
                ...(canBeSenior && senior !== (member.senior === true) ? { senior } : {}),
                provider,
                effort: effort ?? null,
                autoCompactWindowTokens: compactWindow.trim() ? Number(compactWindow) : null,
                cheapSubagent: cheapSubagent ?? null,
                model: model.trim(),
                instructions: instructions.trim(),
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
    <Dialog
      open
      onClose={onDone}
      title={t('memberEdit.title', { name: member.displayName })}
      error={
        scheduleError ? (
          <ErrorBanner>{t('schedules.form.invalid')}</ErrorBanner>
        ) : update.isError ? (
          <ErrorBanner>{errorMessage(update.error)}</ErrorBanner>
        ) : null
      }
      footer={
        <>
          <Button variant="secondary" size="md" onClick={onDone}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form={formId} variant="primary" size="md" loading={update.isPending}>
            {t('memberEdit.save')}
          </Button>
        </>
      }
    >
      <form id={formId} ref={formRef} className={styles.form} onSubmit={submit}>
        <TextField
          label={t('hire.displayName')}
          required
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
        {member.kind === 'human' ? (
          <fieldset className={styles.schedule}>
            <legend>{t('memberEdit.roles')}</legend>
            <SelectField
              label={t('invites.access')}
              value={access}
              onChange={(event) => setAccess(event.target.value)}
            >
              {HumanAccess.options.map((level) => (
                <option key={level} value={level}>
                  {humanRoleName(level)}
                </option>
              ))}
            </SelectField>
            {roles
              .filter((role) => holdersAllow(role.holders, 'human'))
              .map((role) => (
                <label key={role.id} className={styles.toggle}>
                  <input
                    type="checkbox"
                    checked={selected.includes(role.id)}
                    onChange={(event) =>
                      setSelected(
                        event.target.checked
                          ? [...selected, role.id]
                          : selected.filter((id) => id !== role.id),
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
            {canBeSenior ? (
              <div>
                <label className={styles.toggle}>
                  <input
                    type="checkbox"
                    checked={senior}
                    aria-describedby={`${formId}-senior`}
                    onChange={(event) => setSenior(event.target.checked)}
                  />
                  {t('memberEdit.senior')}
                </label>
                <p id={`${formId}-senior`} className={styles.toggleHint}>
                  {t('memberEdit.seniorHint')}
                </p>
              </div>
            ) : null}
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
              cheapSubagent={cheapSubagent}
              onCheapSubagentChange={setCheapSubagent}
            />
            <TextField
              label={t('memberEdit.autoCompactWindow')}
              hint={t(
                provider === 'claude'
                  ? 'memberEdit.autoCompactWindowHint'
                  : 'memberEdit.autoCompactWindowCodex',
                { provider: t(`providers.${provider}`) },
              )}
              type="number"
              min={100_000}
              max={1_000_000}
              step={10_000}
              placeholder={t('memberEdit.autoCompactWindowPlaceholder')}
              // Kept as it is for a Codex member: it has no effect there.
              disabled={provider !== 'claude'}
              value={compactWindow}
              onChange={(event) => setCompactWindow(event.target.value)}
            />
            <TextAreaField
              label={t('memberEdit.instructions')}
              hint={t('hire.instructionsNote')}
              rows={6}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
            />
            <ScheduleFields value={schedule} onChange={setSchedule} showErrors={scheduleError} />
            {/* These save at once, apart from the form's own button: show the current roster entry. */}
            <PermissionLevelControl member={members.get(member.handle) ?? member} />
          </>
        )}
      </form>
    </Dialog>
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
  return member ? (
    <EditMemberForm key={member.handle} member={member} config={config} roles={roles} onDone={onClose} />
  ) : null;
}
