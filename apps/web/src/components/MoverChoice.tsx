import type { ReactNode } from 'react';
import { t } from '../i18n/t';
import { ChoiceCard } from './Field';
import { Chip } from './Chip';
import styles from './MoverChoice.module.css';

type MoverKind = 'worker' | 'project_manager' | 'human';

const KINDS: readonly MoverKind[] = ['worker', 'project_manager', 'human'];

interface MoverChoiceProps {
  /** The radio group's name; one per form. */
  name: string;
  value: MoverKind;
  onChange: (kind: MoverKind) => void;
  /** Shown under the "one person" card while it is chosen. */
  humanExtra?: ReactNode;
  disabled?: boolean;
  /** The group's name for assistive technology; the screen shows its own heading. */
  legend?: string;
}

/** The three choices for who moves cards on in the team settings. */
export function MoverChoice({ name, value, onChange, humanExtra, disabled, legend }: MoverChoiceProps) {
  return (
    <fieldset className={styles.group} disabled={disabled}>
      <legend className="visually-hidden">{legend ?? t('settings.team.mover.label')}</legend>
      {KINDS.map((kind) => (
        <div key={kind} className={styles.item}>
          <ChoiceCard
            name={name}
            value={kind}
            checked={value === kind}
            onChange={(next) => onChange(next as MoverKind)}
            title={
              <span className={styles.title}>
                {t(`settings.team.mover.${kind}.title`)}
                {kind === 'worker' ? <Chip tone="accent">{t('settings.team.mover.recommended')}</Chip> : null}
              </span>
            }
            description={t(`settings.team.mover.${kind}.description`)}
          />
          {kind === 'human' && value === 'human' && humanExtra ? (
            <div className={styles.extra}>{humanExtra}</div>
          ) : null}
        </div>
      ))}
    </fieldset>
  );
}
