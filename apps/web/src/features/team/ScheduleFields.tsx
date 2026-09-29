import { Button } from '../../components/Button';
import { TextAreaField, TextField } from '../../components/Field';
import { t } from '../../i18n/t';
import styles from './HireDialog.module.css';

export interface ScheduleDraft {
  enabled: boolean;
  cron: string;
  prompt: string;
}

export function ScheduleFields({
  value,
  onChange,
}: {
  value: ScheduleDraft;
  onChange: (value: ScheduleDraft) => void;
}) {
  return (
    <fieldset className={styles.schedule}>
      <legend>{t('schedule.title')}</legend>
      <label className={styles.toggle}>
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(event) => onChange({ ...value, enabled: event.target.checked })}
        />
        {t('schedule.enabled')}
      </label>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => onChange({ ...value, enabled: true, cron: '0 8 * * 1-5' })}
      >
        {t('schedule.preset')}
      </Button>
      {value.enabled ? (
        <>
          <TextField
            label={t('schedule.cron')}
            hint={t('schedule.hint')}
            required
            value={value.cron}
            onChange={(event) => onChange({ ...value, cron: event.target.value })}
          />
          <TextAreaField
            label={t('schedule.prompt')}
            required
            value={value.prompt}
            onChange={(event) => onChange({ ...value, prompt: event.target.value })}
          />
        </>
      ) : null}
    </fieldset>
  );
}
