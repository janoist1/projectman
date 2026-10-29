import clsx from 'clsx';
import { SegmentedControl } from '../../components/SegmentedControl';
import { t } from '../../i18n/t';
import styles from './Engines.module.css';
import { useEngineMode } from './useEngineMode';

/** "Telepítés: Motor-app (Mac) | Checkout (fejlesztői)": the choice is remembered and shared by every place. */
export function EngineModeSwitch({ className }: { className?: string }) {
  const [mode, setMode] = useEngineMode();
  return (
    <div className={clsx(styles.modeSwitch, className)}>
      <span className={styles.modeLabel} aria-hidden="true">
        {t('engines.mode.label')}
      </span>
      <SegmentedControl
        appearance="pills"
        size="sm"
        asRadioGroup
        label={t('engines.mode.aria')}
        value={mode}
        onChange={setMode}
        options={[
          { value: 'app', label: t('engines.mode.app') },
          { value: 'checkout', label: t('engines.mode.checkout') },
        ]}
      />
    </div>
  );
}
