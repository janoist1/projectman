import { useEffect, useId, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { MemberHandle } from '@projectman/shared';
import type { RoleId } from '@projectman/shared';
import type { ProjectConfig } from '@projectman/shared';
import { useHireMember, useRoles } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { SelectField, TextField } from '../../components/Field';
import { Dialog } from '../../components/Dialog';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { aiRoleView, hireableRoles, isDeveloperRole } from '../../lib/roles';
import { ErrorState, LoadingState } from '../../components/States';
import { ScheduleFields } from './ScheduleFields';
import type { ScheduleDraft } from './ScheduleFields';
import { previewFor } from './hirePreview';
import styles from './HireDialog.module.css';

const MODELS = ['opus', 'sonnet', 'haiku'] as const;

interface HireDialogProps {
  open: boolean;
  onClose: () => void;
  config: ProjectConfig | undefined;
}

function HireForm({ config, onDone }: { config: ProjectConfig | undefined; onDone: () => void }) {
  const { key } = useProject();
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
  const [model, setModel] = useState<string>('');
  const [handleError, setHandleError] = useState<string | null>(null);
  const instructionsId = useId();
  const preview = useMemo(() => previewFor(role, specialty, config), [role, specialty, config]);
  const chosenModel = model || preview.model;
  const selectedRole = aiRoleView(role, specialty, roles.data?.roles);
  const defaultName = selectedRole.name;

  useEffect(() => {
    if (options.length && !options.some((option) => option.id === role)) setRole(options[0]!.id);
  }, [roles.data, role]);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (handle && !MemberHandle.safeParse(handle).success) {
      setHandleError(t('hire.handleInvalid'));
      return;
    }
    if (!options.some((option) => option.id === role)) return;
    if (schedule.enabled && (!schedule.cron.trim() || !schedule.prompt.trim())) {
      setScheduleError(true);
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
        model: chosenModel,
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

  if (roles.isPending) return <LoadingState />;
  if (roles.isError) return <ErrorState error={roles.error} onRetry={() => void roles.refetch()} />;

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate>
      <p className={styles.intro}>{t('hire.intro')}</p>
      <fieldset className={styles.roles}>
        <legend className="visually-hidden">{t('hire.roles')}</legend>
        {options.map((option) => {
          const checked = option.id === role;
          return (
            <label key={option.id} className={styles.role} data-checked={checked || undefined}>
              <input
                type="radio"
                name="role"
                value={option.id}
                checked={checked}
                onChange={() => {
                  setRole(option.id);
                  setModel('');
                }}
                className={styles.radio}
              />
              <Avatar
                member={{ handle: option.id, displayName: option.name, kind: 'ai', role: option.id }}
                size="md"
              />
              <span className={styles.roleText}>
                <span className={styles.roleName}>{option.name}</span>
                <span className={styles.roleTag}>{option.summary}</span>
              </span>
            </label>
          );
        })}
      </fieldset>

      <section className={styles.preview} aria-labelledby="hire-preview">
        <h3 id="hire-preview" className={styles.previewTitle}>
          {t('hire.preview')}
        </h3>
        <p>{selectedRole.name}</p>
        <p>{selectedRole.summary}</p>
        <p>
          {t('roleCatalogue.notTheirJob')}: {selectedRole.notTheirJob}
        </p>
        <div className={styles.grid}>
          <TextField
            label={t('hire.displayName')}
            placeholder={defaultName}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
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
          {isDeveloperRole(role) ? (
            <TextField
              label={t('hire.specialty')}
              placeholder={t('hire.specialtyPlaceholder')}
              value={specialty}
              onChange={(event) => setSpecialty(event.target.value)}
              optional
            />
          ) : null}
          <SelectField
            label={t('hire.model')}
            value={chosenModel}
            onChange={(event) => setModel(event.target.value)}
          >
            {[...new Set([preview.model, ...MODELS])].map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </SelectField>
        </div>
        <dl className={styles.facts}>
          <div>
            <dt>{t('hire.permissionMode')}</dt>
            <dd>{t(`permissionModes.${preview.permissionMode}`)}</dd>
          </div>
          <div>
            <dt>{t('hire.capacity')}</dt>
            <dd>{t('hire.capacityValue', { count: preview.capacity })}</dd>
          </div>
          <div>
            <dt>{t('hire.subscription')}</dt>
            <dd>{t('hire.subscriptionYours')}</dd>
          </div>
        </dl>
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
      </section>

      <ScheduleFields value={schedule} onChange={setSchedule} />
      {scheduleError ? <p role="alert">{t('schedule.invalid')}</p> : null}
      {hire.isError ? (
        <p className={styles.error} role="alert">
          {errorMessage(hire.error)}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button
          type="submit"
          variant="primary"
          size="xl"
          loading={hire.isPending}
          disabled={options.length === 0}
        >
          {hire.isPending ? t('hire.submitting') : t('hire.submit')}
        </Button>
        <span className={styles.note}>{t('hire.note')}</span>
      </div>
    </form>
  );
}

export function HireDialog({ open, onClose, config }: HireDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title={t('hire.title')} size="lg">
      <HireForm config={config} onDone={onClose} />
    </Dialog>
  );
}
