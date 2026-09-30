import type { MemberConfig } from '@projectman/shared';
import styles from './MemberSelect.module.css';

/** A labelled multi-select of configured members (stage owners, label setters). */
export function MemberSelect({
  label,
  members,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  members: readonly MemberConfig[];
  value: string[];
  onChange: (handles: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <label className={styles.field}>
      {label}
      <select
        multiple
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Array.from(event.target.selectedOptions, (option) => option.value))}
      >
        {members.map((member) => (
          <option key={member.handle} value={member.handle}>
            {member.displayName}
          </option>
        ))}
      </select>
    </label>
  );
}
