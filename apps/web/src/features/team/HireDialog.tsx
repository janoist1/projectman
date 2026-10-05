import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  DEFAULT_PROVIDER_MODELS,
  modelForProvider,
  MemberHandle,
  usesCodexCli,
  approverBlocksProvider,
} from '@projectman/shared';
import type { AgentProvider, AgentEffort, CheapSubagentModel, RoleId } from '@projectman/shared';
import type { ProjectConfig } from '@projectman/shared';
import { useHireMember, useRoles } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { SelectField, TextField } from '../../components/Field';
import { Dialog } from '../../components/Dialog';
import { Fold } from '../../components/Fold';
import { useToast } from '../../components/toastContext';
import { ErrorBanner } from '../../components/ErrorBanner';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { focusFirstInvalid } from '../../lib/focus';
import { aiRoleView, hireableRoles, isDeveloperRole } from '../../lib/roles';
import { ErrorState, LoadingState } from '../../components/States';
import { ScheduleFields } from './ScheduleFields';
import type { ScheduleDraft } from './ScheduleFields';
import { previewFor } from './hirePreview';
import { ProviderFields } from './ProviderFields';
import styles from './HireDialog.module.css';
import form from './memberForm.module.css';

interface HireDialogProps {
  open: boolean;
  onClose: () => void;
  config: ProjectConfig | undefined;
}

function HireForm({ config, onDone }: { config: ProjectConfig | undefined; onDone: () => void }) {
  const { key, isOwner } = useProject();
  const hire = useHireMember(key);
  const roles = useRoles(key);
  const options = hireableRoles(roles.data?.roles ?? []);
  const [schedule, setSchedule] = useState<ScheduleDraft>({ enabled: false, cron: '', prompt: '' });
  const [scheduleError, setScheduleError] = useState(false);
  const toast = useToast();
  const [role, setRole] = useState<RoleId>('developer');
  const [displayName, setDisplayName] = useState('');
  const [handle, setHandle] = useState('');
  const [specialty, setSpecialty] = useState('');
  const [provider, setProvider] = useState<AgentProvider>('claude');
  const [effort, setEffort] = useState<AgentEffort | undefined>();
  const [cheapSubagent, setCheapSubagent] = useState<CheapSubagentModel | undefined>();
  const [model, setModel] = useState<string | null>(null);
  const [handleError, setHandleError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  // Counts refused saves: each one moves focus to the first field marked invalid.
  const [refused, setRefused] = useState(0);
  const instructionsId = useId();
  const preview = useMemo(() => previewFor(role, specialty, config), [role, specialty, config]);
  const chosenModel =
    model ??
    (usesCodexCli(provider) ? DEFAULT_PROVIDER_MODELS[provider] : modelForProvider(provider, preview.model));
  const selectedRole = aiRoleView(role, specialty, roles.data?.roles);
  const defaultName = selectedRole.name;

  useEffect(() => {
    if (options.length && !options.some((option) => option.id === role)) setRole(options[0]!.id);
  }, [roles.data, role]);

  useEffect(() => {
    if (refused) focusFirstInvalid(formRef.current);
  }, [refused]);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (handle && !MemberHandle.safeParse(handle).success) {
      setHandleError(t('hire.handleInvalid'));
      setScheduleError(false);
      // The identifier lives in the closed fold: open it so the error is in sight.
      setDetailsOpen(true);
      setRefused((count) => count + 1);
      return;
    }
    if (!options.some((option) => option.id === role) || !chosenModel.trim()) return;
    if (schedule.enabled && (!schedule.cron.trim() || !schedule.prompt.trim())) {
      setHandleError(null);
      setScheduleError(true);
      setRefused((count) => count + 1);
      return;
    }
    setScheduleError(false);
    setHandleError(null);
    const name = displayName.trim() || defaultName;
    hire.mutate(
      {
        role,
        displayName: name,
        handle: handle || undefined,
        specialty: isDeveloperRole(role) && specialty.trim() ? specialty.trim() : undefined,
        provider,
        effort,
        // A Codex member has none (the field is off for it).
        cheapSubagent: provider === 'claude' ? cheapSubagent : undefined,
        model: chosenModel.trim(),
        schedule: schedule.enabled
          ? { cron: schedule.cron.trim(), prompt: schedule.prompt.trim() }
          : undefined,
      },
      {
        onSuccess: () => {
          toast.show(t('hire.hired', { name }));
          onDone();
        },
      },
    );
  };

  return (
    <Dialog
      open
      onClose={onDone}
      title={t('hire.title')}
      size="lg"
      error={
        scheduleError ? (
          <ErrorBanner>{t('schedules.form.invalid')}</ErrorBanner>
        ) : hire.isError ? (
          <ErrorBanner>{errorMessage(hire.error)}</ErrorBanner>
        ) : null
      }
      footer={
        <>
          <Button variant="secondary" size="md" onClick={onDone}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            size="md"
            loading={hire.isPending}
            disabled={roles.isPending || roles.isError || options.length === 0}
          >
            {hire.isPending ? t('hire.submitting') : t('hire.submit')}
          </Button>
        </>
      }
    >
      {roles.isPending ? (
        <LoadingState />
      ) : roles.isError ? (
        <ErrorState error={roles.error} onRetry={() => void roles.refetch()} />
      ) : (
        <form id={formId} ref={formRef} className={form.form} onSubmit={onSubmit} noValidate>
          <p className={styles.intro}>{t('hire.intro')}</p>
          <SelectField
            label={t('hire.roles')}
            value={role}
            onChange={(event) => {
              setRole(event.target.value);
              setModel(null);
            }}
          >
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </SelectField>
          <div className={styles.roleCard}>
            <Avatar member={{ handle: role, displayName: selectedRole.name, kind: 'ai', role }} size="md" />
            <span className={styles.roleText}>
              <span className={styles.roleName}>{selectedRole.name}</span>
              <span className={styles.roleSummary}>{selectedRole.summary}</span>
            </span>
          </div>
          <div className={styles.grid}>
            <TextField
              label={t('hire.displayName')}
              placeholder={defaultName}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
            {isDeveloperRole(role) ? (
              <TextField
                label={t('hire.specialty')}
                placeholder={t('hire.specialtyPlaceholder')}
                value={specialty}
                onChange={(event) => setSpecialty(event.target.value)}
                optional
              />
            ) : null}
            <ProviderFields
              key={role}
              provider={provider}
              model={chosenModel}
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
          </div>

          {approverBlocksProvider({ provider, approver: preview.approver }) ? (
            <p className={form.approverWarning}>
              {t('hire.nanogptApproverNone')}{' '}
              {t(isOwner ? 'hire.nanogptApproverOwner' : 'hire.nanogptApproverOther')}
            </p>
          ) : null}
          <ScheduleFields value={schedule} onChange={setSchedule} showErrors={scheduleError} />

          <Fold summary={t('hire.details')} plain open={detailsOpen} onToggle={setDetailsOpen}>
            <div className={styles.details}>
              <p>
                {t('roleCatalogue.notTheirJob')}: {selectedRole.notTheirJob}
              </p>
              {selectedRole.whenToAsk ? (
                <p>
                  {t('roleCatalogue.whenToAsk')}: {selectedRole.whenToAsk}
                </p>
              ) : null}
              <dl className={styles.facts}>
                <div>
                  <dt>{t('hire.permissionMode')}</dt>
                  <dd>{t(`permissionModes.${preview.permissionMode}`)}</dd>
                </div>
                <div>
                  <dt>{t('hire.approver')}</dt>
                  <dd>{t(`permissionControls.approvers.${preview.approver}`)}</dd>
                </div>
                <div>
                  <dt>{t('hire.capacity')}</dt>
                  <dd>{t('hire.capacityValue', { count: preview.capacity })}</dd>
                </div>
                <div>
                  <dt>{t('hire.subscription')}</dt>
                  <dd>
                    {t(provider === 'nanogpt' ? 'providerSettings.runsOn.nanogpt' : 'hire.subscriptionYours')}
                  </dd>
                </div>
              </dl>
              <TextField
                label={t('hire.handle')}
                hint={t('hire.handleHint')}
                value={handle}
                onChange={(event) => setHandle(event.target.value.toLowerCase())}
                error={handleError}
                optional
                spellCheck={false}
                autoCapitalize="off"
              />
              <div className={styles.instructions}>
                <label htmlFor={instructionsId} className={styles.instructionsLabel}>
                  {t('hire.instructions')}
                </label>
                <textarea
                  id={instructionsId}
                  className={styles.instructionsText}
                  readOnly
                  rows={4}
                  value={preview.instructions || t('hire.instructionsDefault')}
                  aria-describedby={`${instructionsId}-note`}
                />
                <span id={`${instructionsId}-note`} className={styles.note}>
                  {t('hire.instructionsNote')}
                </span>
              </div>
            </div>
          </Fold>
        </form>
      )}
    </Dialog>
  );
}

export function HireDialog({ open, onClose, config }: HireDialogProps) {
  return open ? <HireForm config={config} onDone={onClose} /> : null;
}
