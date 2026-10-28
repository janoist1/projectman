import type { EngineView } from '@projectman/shared';
import { t } from '../../i18n/t';
import { useNow } from '../../lib/useNow';
import { engineState, machineParts, statusText } from '../engines/engineView';
import styles from './EnginePicker.module.css';

/** The "Gép" choice of the wizard: only the machines of the person creating the project; a machine that is not connected cannot be chosen. */
export function EnginePicker({
  engines,
  value,
  onChange,
}: {
  engines: readonly EngineView[];
  value: string | null;
  onChange: (id: string) => void;
}) {
  const now = new Date(useNow(true, 30_000));
  return (
    <fieldset className={styles.group}>
      <legend>{t('projects.create.engineLegend')}</legend>
      {engines.map((engine) => {
        const online = engineState(engine) === 'online';
        const lineId = `engine-${engine.id}-line`;
        const host = machineParts(engine)[0]?.text;
        return (
          <label
            key={engine.id}
            className={styles.option}
            data-selected={value === engine.id || undefined}
            data-disabled={!online || undefined}
          >
            <input
              type="radio"
              name="project-engine"
              value={engine.id}
              checked={value === engine.id}
              disabled={!online}
              aria-describedby={lineId}
              onChange={() => onChange(engine.id)}
            />
            <span className={styles.text}>
              <span className={styles.name}>{engine.name}</span>
              <span id={lineId} className={styles.line} data-tone={online ? undefined : 'needs'}>
                {online
                  ? [t('projects.create.engineOnline'), host].filter(Boolean).join(t('engines.workJoin'))
                  : t('projects.create.engineUnavailable', { status: statusText(engine, now) })}
              </span>
            </span>
          </label>
        );
      })}
      <p className={styles.hint}>{t('projects.create.engineHint')}</p>
    </fieldset>
  );
}
