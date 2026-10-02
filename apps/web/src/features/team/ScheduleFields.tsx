import { useState } from 'react';
import { TextAreaField, TextField } from '../../components/Field';
import { SegmentedControl } from '../../components/SegmentedControl';
import { t } from '../../i18n/t';
import { cronTime, parsePlainCron, plainCron } from '../../lib/schedules';
import type { ScheduleFrequency } from '../../lib/schedules';
import styles from './memberForm.module.css';

export interface ScheduleDraft {
  enabled: boolean;
  cron: string;
  prompt: string;
}

const DEFAULT_TIME = '08:00';

export function ScheduleFields({
  value,
  onChange,
  showErrors = false,
}: {
  value: ScheduleDraft;
  onChange: (value: ScheduleDraft) => void;
  /** Mark the fields that are empty: set by a form that refused to save. */
  showErrors?: boolean;
}) {
  // A plain weekday or daily cron shows as a frequency and a time; any other cron is "Egyéni".
  const [frequency, setFrequency] = useState<ScheduleFrequency>(() => {
    const plain = parsePlainCron(value.cron);
    return plain ? plain.frequency : value.cron.trim() ? 'custom' : 'weekdays';
  });
  const [time, setTime] = useState(() => {
    const plain = parsePlainCron(value.cron);
    return plain ? cronTime(plain) : DEFAULT_TIME;
  });
  const cronFor = (next: ScheduleFrequency, nextTime: string) =>
    next === 'custom' ? value.cron : (plainCron(next, nextTime) ?? '');
  return (
    <fieldset className={styles.schedule}>
      <legend>{t('schedules.form.title')}</legend>
      <label className={styles.toggle}>
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(event) =>
            onChange({
              ...value,
              enabled: event.target.checked,
              // Turned on with no time yet: start from the chosen frequency.
              cron: event.target.checked && !value.cron.trim() ? cronFor(frequency, time) : value.cron,
            })
          }
        />
        {t('schedules.form.enabled')}
      </label>
      {value.enabled ? (
        <>
          <SegmentedControl<ScheduleFrequency>
            label={t('schedules.form.frequency')}
            value={frequency}
            onChange={(next) => {
              setFrequency(next);
              onChange({ ...value, cron: cronFor(next, time) });
            }}
            options={[
              { value: 'weekdays', label: t('schedules.form.weekdays') },
              { value: 'daily', label: t('schedules.form.daily') },
              { value: 'custom', label: t('schedules.form.custom') },
            ]}
          />
          {frequency === 'custom' ? (
            <TextField
              label={t('schedules.form.cron')}
              hint={t('schedules.form.hint')}
              required
              spellCheck={false}
              autoCapitalize="off"
              value={value.cron}
              error={showErrors && !value.cron.trim() ? t('schedules.form.timeMissing') : null}
              onChange={(event) => onChange({ ...value, cron: event.target.value })}
            />
          ) : (
            <TextField
              label={t('schedules.form.time')}
              hint={t('schedules.form.timeHint')}
              type="time"
              required
              value={time}
              error={showErrors && !value.cron.trim() ? t('schedules.form.timeMissing') : null}
              onChange={(event) => {
                setTime(event.target.value);
                onChange({ ...value, cron: cronFor(frequency, event.target.value) });
              }}
            />
          )}
          <TextAreaField
            label={t('schedules.form.prompt')}
            required
            value={value.prompt}
            error={showErrors && !value.prompt.trim() ? t('schedules.form.promptMissing') : null}
            onChange={(event) => onChange({ ...value, prompt: event.target.value })}
          />
        </>
      ) : null}
    </fieldset>
  );
}
