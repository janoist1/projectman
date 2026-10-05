import type { TaskPriority } from '@projectman/shared';
import styles from './PriorityMark.module.css';

/** A decorative mark; its caller supplies the accessible level name. */
export function PriorityMark({ priority }: { priority: TaskPriority }) {
  const filled = priority === 'high' ? 3 : priority === 'normal' ? 2 : 1;
  return (
    <svg key={priority} className={styles.mark} width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      {priority === 'urgent' ? (
        <>
          <rect width="14" height="14" rx="3" fill="var(--c-needs)" />
          <path d="M7 3.5v4" stroke="var(--c-on-needs)" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="7" cy="10.5" r="1" fill="var(--c-on-needs)" />
        </>
      ) : (
        [0, 1, 2].map((bar) => (
          <rect
            key={bar}
            x={bar * 5}
            y={10 - bar * 4}
            width="4"
            height={4 + bar * 4}
            rx="0.7"
            fill={bar < filled ? 'var(--c-ink-2)' : 'var(--c-mark-off)'}
          />
        ))
      )}
    </svg>
  );
}
