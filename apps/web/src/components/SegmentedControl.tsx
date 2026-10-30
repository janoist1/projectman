import clsx from 'clsx';
import styles from './SegmentedControl.module.css';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  count?: number;
  ariaLabel?: string;
  indicator?: boolean;
  /** The language of the label when it differs from the page's (a language's own name). */
  lang?: string;
}

interface SegmentedControlProps<T extends string> {
  label: string;
  options: ReadonlyArray<SegmentOption<T>>;
  value: T;
  onChange: (value: T) => void;
  appearance?: 'segmented' | 'pills';
  size?: 'sm' | 'md';
  className?: string;
  asRadioGroup?: boolean;
}

/** Filter toggles (toggle buttons with aria-pressed), as a segmented track or as pills. */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  appearance = 'segmented',
  size = 'md',
  className,
  asRadioGroup = false,
}: SegmentedControlProps<T>) {
  return (
    <div
      role={asRadioGroup ? 'radiogroup' : 'group'}
      aria-label={label}
      className={clsx(styles.group, styles[appearance], styles[size], className)}
      onKeyDown={(event) => {
        const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (!step) return;
        const buttons = [...event.currentTarget.querySelectorAll('button')];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const nextIndex = asRadioGroup ? (index + step + buttons.length) % buttons.length : index + step;
        const next = buttons[nextIndex];
        if (!next) return;
        event.preventDefault();
        next.focus();
        if (asRadioGroup) onChange(options[nextIndex]!.value);
      }}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            className={clsx(styles.option, active && styles.active)}
            role={asRadioGroup ? 'radio' : undefined}
            aria-pressed={asRadioGroup ? undefined : active}
            aria-checked={asRadioGroup ? active : undefined}
            tabIndex={asRadioGroup && !active ? -1 : undefined}
            aria-label={option.ariaLabel}
            lang={option.lang}
            onClick={() => onChange(option.value)}
          >
            <span>{option.label}</span>
            {option.indicator ? <span className={styles.indicator} aria-hidden="true" /> : null}
            {option.count !== undefined ? <span className={styles.count}>{option.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
