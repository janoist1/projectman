import clsx from 'clsx';
import styles from './SegmentedControl.module.css';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

interface SegmentedControlProps<T extends string> {
  label: string;
  options: ReadonlyArray<SegmentOption<T>>;
  value: T;
  onChange: (value: T) => void;
  appearance?: 'segmented' | 'pills';
  size?: 'sm' | 'md';
  className?: string;
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
}: SegmentedControlProps<T>) {
  return (
    <div
      role="group"
      aria-label={label}
      className={clsx(styles.group, styles[appearance], styles[size], className)}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            className={clsx(styles.option, active && styles.active)}
            aria-pressed={active}
            onClick={() => onChange(option.value)}
          >
            <span>{option.label}</span>
            {option.count !== undefined ? <span className={styles.count}>{option.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
