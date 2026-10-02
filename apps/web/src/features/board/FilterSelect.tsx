import clsx from 'clsx';
import { useId } from 'react';
import { Icon } from '../../components/Icon';
import type { FilterOption } from './boardFilters';
import styles from './FilterSelect.module.css';

/**
 * A native select in a pill, named by what it filters ("Felelős: Mind"). The whole pill is the
 * control, so the browser's own picker and the keyboard work as on any select; what is set looks set.
 */
export function FilterSelect({
  label,
  anyLabel,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  /** The text of the "no filter" choice. */
  anyLabel: string;
  value: string;
  options: readonly FilterOption[];
  onChange: (value: string) => void;
  className?: string;
}) {
  const id = useId();
  const current =
    value === '' ? anyLabel : (options.find((option) => option.value === value)?.label ?? anyLabel);
  return (
    <span className={clsx(styles.pill, value !== '' && styles.active, className)}>
      <label htmlFor={id} className={styles.name}>
        {label}
      </label>
      <span className={styles.value} aria-hidden="true">
        {current}
      </span>
      <Icon name="chevronDown" size={14} strokeWidth={2.4} className={styles.chevron} />
      <select
        id={id}
        className={styles.select}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{anyLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </span>
  );
}
