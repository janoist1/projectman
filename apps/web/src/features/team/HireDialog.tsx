import { useId, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { MemberHandle } from '@projectman/shared';
import type { AiRole } from '@projectman/shared';
import type { AiMemberConfig, ProjectConfig } from '@projectman/shared';
import { useHireMember } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { SelectField, TextField } from '../../components/Field';
import { Dialog } from '../../components/Dialog';
import { useToast } from '../../components/Toast';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { aiRoleView, hireableRoles, isDeveloperRole } from '../../lib/roles';
import styles from './HireDialog.module.css';

const MODELS = ['opus', 'sonnet', 'haiku'] as const;

interface HireDialogProps {
  open: boolean;
  onClose: () => void;
  config: ProjectConfig | undefined;
}

/**
 * Defaults shown in the preview. There is no role-template endpoint yet, so the preview
 * mirrors an existing member with the same role (the server applies the real defaults).
 */
export function previewFor(role: AiRole, specialty: string, config: ProjectConfig | undefined): Pick<AiMemberConfig, 'model' | 'permissionMode' | 'capacity' | 'instructions'> {
  const ai = (config?.team.members ?? []).filter((member): member is AiMemberConfig => member.kind === 'ai' && member.role === role);
  const wanted = specialty.trim().toLowerCase();
  const match = ai.find((member) => wanted && member.specialty?.toLowerCase().includes(wanted)) ?? ai[0];
  return {
    model: match?.model ?? 'opus',
    permissionMode: match?.permissionMode ?? 'default',
    capacity: match?.capacity ?? 1,
    instructions: match?.instructions ?? '',
  };
}

function HireForm({ config, onDone }: { config: ProjectConfig | undefined; onDone: () => void }) {
  const { key } = useProject();
  const hire = useHireMember(key);
  const toast = useToast();
  const [role, setRole] = useState<AiRole>('developer');
  const [displayName, setDisplayName] = useState('');
  const [handle, setHandle] = useState('');
  const [specialty, setSpecialty] = useState('');
  const [model, setModel] = useState<string>('');
  const [handleError, setHandleError] = useState<string | null>(null);
  const instructionsId = useId();
  const preview = useMemo(() => previewFor(role, specialty, config), [role, specialty, config]);
  const chosenModel = model || preview.model;
  const defaultName = aiRoleView(role, specialty).name;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (handle && !MemberHandle.safeParse(handle).success) {
      setHandleError(t('hire.handleInvalid'));
      return;
    }
    setHandleError(null);
    const name = displayName.trim() || defaultName;
    hire.mutate(
      {
        role,
        displayName: name,
        handle: handle || undefined,
        specialty: isDeveloperRole(role) && specialty.trim() ? specialty.trim() : undefined,
        model: chosenModel,
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
    <form className={styles.form} onSubmit={onSubmit} noValidate>
      <p className={styles.intro}>{t('hire.intro')}</p>
      <fieldset className={styles.roles}>
        <legend className="visually-hidden">{t('hire.roles')}</legend>
        {hireableRoles().map((option) => {
          const checked = option.id === role;
          return (
            <label key={option.id} className={styles.role} data-checked={checked || undefined}>
              <input
                type="radio"
                name="role"
                value={option.id}
                checked={checked}
                onChange={() => {
                  setRole(option.id as AiRole);
                  setModel('');
                }}
                className={styles.radio}
              />
              <Avatar member={{ handle: option.id, displayName: option.name, kind: 'ai', role: option.id }} size="md" />
              <span className={styles.roleText}>
                <span className={styles.roleName}>{option.name}</span>
                <span className={styles.roleTag}>{option.tagline}</span>
              </span>
            </label>
          );
        })}
      </fieldset>

      <section className={styles.preview} aria-labelledby="hire-preview">
        <h3 id="hire-preview" className={styles.previewTitle}>
          {t('hire.preview')}
        </h3>
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
          <SelectField label={t('hire.model')} value={chosenModel} onChange={(event) => setModel(event.target.value)}>
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

      {hire.isError ? (
        <p className={styles.error} role="alert">
          {errorMessage(hire.error)}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button type="submit" variant="primary" size="xl" loading={hire.isPending}>
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
