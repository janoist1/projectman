import { useEffect, useId, useState } from 'react';
import type { Task } from '@projectman/shared';
import { isTheme } from '@projectman/shared';
import { t } from '../../i18n/t';
import styles from './MemberContextPage.module.css';

/** A board-backed picker that also accepts a key outside the board's loaded cards. */
export function TaskPicker({
  tasks,
  value,
  onChange,
  error,
}: {
  tasks: readonly Task[];
  value: string;
  onChange: (key: string) => void;
  error?: string;
}) {
  const id = useId();
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  useEffect(() => {
    setText(value);
    setOpen(false);
    setActive(-1);
  }, [value]);
  const matches = tasks
    .filter(
      (task) =>
        !isTheme(task) && `${task.key} ${task.title}`.toLocaleLowerCase().includes(text.toLocaleLowerCase()),
    )
    .slice(0, 20);
  const expanded = open && matches.length > 0;
  function choose(key: string) {
    setText(key);
    setOpen(false);
    setActive(-1);
    onChange(key);
  }
  return (
    <div className={styles.picker}>
      <label htmlFor={id}>{t('memberContext.task')}</label>
      <input
        id={id}
        role="combobox"
        autoComplete="off"
        value={text}
        placeholder={t('memberContext.taskPlaceholder')}
        aria-expanded={expanded}
        aria-controls={expanded ? `${id}-list` : undefined}
        aria-autocomplete="list"
        aria-activedescendant={expanded && active >= 0 ? `${id}-${active}` : undefined}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onChange={(event) => {
          setText(event.target.value);
          setActive(-1);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            setOpen(false);
            setActive(-1);
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
            setActive((before) =>
              matches.length
                ? (before + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length
                : -1,
            );
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            const selected = open && active >= 0 ? matches[active]?.key : undefined;
            if (selected) choose(selected);
            else if (text.trim()) choose(text.trim().toUpperCase());
          }
        }}
      />
      {expanded && (
        <ul id={`${id}-list`} role="listbox" aria-label={t('memberContext.task')} className={styles.options}>
          {matches.map((task, index) => (
            <li
              key={task.key}
              id={`${id}-${index}`}
              role="option"
              aria-selected={active === index}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(task.key)}
            >
              {task.key} · {task.title}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className={styles.fieldError}>
          {error}
        </p>
      )}
    </div>
  );
}
